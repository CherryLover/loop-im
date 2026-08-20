import { useEffect, useRef } from 'react';
import { getToken } from './api';
import type { Message, MessageReaction, User } from './types';

export interface StreamHandlers {
  onMessage?: (message: Message) => void;
  onTyping?: (conversationId: string, typing: boolean) => void;
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

    const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
    const json = <T,>(e: MessageEvent): T => JSON.parse(e.data) as T;

    es.addEventListener('message', (e) => ref.current.onMessage?.(json<{ message: Message }>(e).message));
    es.addEventListener('ai-typing', (e) => {
      const d = json<{ conversationId: string; typing: boolean }>(e);
      ref.current.onTyping?.(d.conversationId, d.typing);
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
