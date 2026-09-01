import { useEffect, useRef } from 'react';
import { getToken } from './api';
import { deviceId } from './push';
import { pageStreamId } from './visibility';
import type { AgentStep, Message, MessageReaction, TypingAgent, User } from './types';

export interface StreamHandlers {
  /**
   * 连上了（含 EventSource 自己重连成功）。
   *
   * 存在的理由只有一个：服务端把「这个页面在不在前台」挂在**这条连接**上，连接一换就是
   * 一张白纸（默认按后台算）。服务端重启或网络抖一下之后，一个明明开着的页面会被当成
   * 后台一直白收推送 —— 除非重连时把可见性重报一遍。这就是那一遍。
   */
  onOpen?: () => void;
  onMessage?: (message: Message) => void;
  /**
   * AI「输入中」状态变了。typing 是老语义的总开关（最后一个 Agent 收工才为 false）；
   * agents 是此刻正在这个会话里干活的全部 Agent（按开工顺序），老服务端不带这个
   * 字段时为 undefined —— 回调第三个参数是可选的，就是为了这份向后兼容。
   */
  onTyping?: (conversationId: string, typing: boolean, agents?: TypingAgent[]) => void;
  /** Agent 回合里的一步（D15）：中间文字/工具动作，实时更新「正在输入」下的状态行。 */
  onProgress?: (conversationId: string, agent: TypingAgent, step: AgentStep) => void;
  onConversationCreated?: (conversationId: string) => void;
  onUserChanged?: (user: User) => void;
  onPresence?: (userId: string, online: boolean) => void;
  onRead?: (conversationId: string, userId: string, lastReadAt: number) => void;
  /** 别人给某条消息点了/取消了回应。服务端按人各发一份，reactions 里的 mine 已经是我这一份。 */
  onReaction?: (conversationId: string, messageId: string, reactions: MessageReaction[]) => void;
}

/** Server-sent events: new messages, AI typing, presence and roster changes. */
export function useStream(enabled: boolean, handlers: StreamHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const token = getToken();
    if (!token) return;

    // device：告诉服务端这条 SSE 是**哪一台**设备连的。推送判定要靠它区分
    // 「这个人在线」和「这个人的这一台在线」—— 桌面挂着网页时，手机上那台照样该响，
    // 而那正是最需要手机响的时候（见 server/src/push-decide.js）。
    //
    // 不带这个参数不会报错，只会让服务端把所有连接都当成「没有设备标识」，
    // 于是谁都不算在线、连你正在用的那台也照推。**这是个不会报错的失效**，
    // 所以 useStream.device.test.ts 专门盯着它。
    //
    // stream：这条 SSE 是这台设备上的**哪一个页面**开的。可见性上报（lib/visibility.ts）
    // 带着同一个值，服务端才能把「我切后台了」精确记在这一个标签页上，而不是一把盖掉
    // 同一台机器上另一个还开着的标签页 —— 那会让人正看着的页面也开始收推送。
    const es = new EventSource(
      `/api/stream?token=${encodeURIComponent(token)}`
      + `&device=${encodeURIComponent(deviceId())}`
      + `&stream=${encodeURIComponent(pageStreamId())}`,
    );
    const json = <T,>(e: MessageEvent): T => JSON.parse(e.data) as T;

    es.addEventListener('open', () => ref.current.onOpen?.());

    es.addEventListener('message', (e) => ref.current.onMessage?.(json<{ message: Message }>(e).message));
    es.addEventListener('ai-typing', (e) => {
      const d = json<{ conversationId: string; typing: boolean; agents?: TypingAgent[] }>(e);
      ref.current.onTyping?.(d.conversationId, d.typing, d.agents);
    });
    es.addEventListener('ai-progress', (e) => {
      const d = json<{ conversationId: string; agent: TypingAgent; step: AgentStep }>(e);
      ref.current.onProgress?.(d.conversationId, d.agent, d.step);
    });
    es.addEventListener('conversation-created', (e) =>
      ref.current.onConversationCreated?.(json<{ conversationId: string }>(e).conversationId));
    es.addEventListener('user-updated', (e) => ref.current.onUserChanged?.(json<{ user: User }>(e).user));
    es.addEventListener('user-created', (e) => ref.current.onUserChanged?.(json<{ user: User }>(e).user));
    es.addEventListener('presence', (e) => {
      const d = json<{ userId: string; online: boolean }>(e);
      ref.current.onPresence?.(d.userId, d.online);
    });
    es.addEventListener('read', (e) => {
      const d = json<{ conversationId: string; userId: string; lastReadAt: number }>(e);
      ref.current.onRead?.(d.conversationId, d.userId, d.lastReadAt);
    });

    es.addEventListener('reaction', (e) => {
      const d = json<{ conversationId: string; messageId: string; reactions: MessageReaction[] }>(e);
      ref.current.onReaction?.(d.conversationId, d.messageId, d.reactions);
    });

    return () => es.close();
  }, [enabled]);
}
