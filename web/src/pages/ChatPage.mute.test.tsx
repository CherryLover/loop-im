// 会话**详情**里的免打扰入口（顶栏那个开关）。
//
// 列表行上那个 .convo__action 的用例在 ChatPage.prefs.test.tsx，两边分开写是有意的：
// 这两个入口解决的不是同一件事 —— 列表那个负责「一眼扫出哪几个会话静音了」，
// 顶栏这个负责「我正看着的这个会话，现在就关掉它」。所以这里每条用例都要顺带确认
// 列表那个还在，别哪天有人以为「详情里有了，列表那个就多余了」把它挪走。
//
// 放顶栏而不是成员面板的理由，在 ChatPage.tsx 的注释里；这里只钉行为：
// 群聊有、单聊（dm / ai）也有、窄版式下不依赖成员面板。
//
// 文案上顶栏那个末尾多一个「（当前会话）」。选中的会话同时出现在列表和顶栏，
// 两个按钮的无障碍名称要是一模一样，读屏过一遍按钮列表就是两个分不清的
// 「免打扰「X」」；顺带也让两处在测试里各自可寻址（AppShell.prefs.test.tsx
// 按 `免打扰「发版协作」` 精确取列表那个，靠的就是这点区分）。
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPage } from './ChatPage';
import { api } from '../lib/api';
import type { Conversation, ConversationType, User } from '../lib/types';

// 只替掉 api 对象本身（详情打开着，ChatPage 会去问 aiContext），模块里其余的导出照旧 ——
// Composer 要用到同一个模块导出的 MAX_VIDEO_UPLOAD_MB，整个模块替掉它就渲染不出来了。
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: { searchMessages: vi.fn(), aiContext: vi.fn() },
}));
vi.mocked(api.aiContext).mockResolvedValue({ line: '' });

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};
const peer: User = {
  id: 'u_chen', name: '陈默', email: 'chen@loop.dev', dept: '研发',
  role: 'member', avatarUrl: null, isAI: false, online: true,
};

const convo = (type: ConversationType, title: string, over: Partial<Conversation> = {}): Conversation => ({
  id: `c_${title}`,
  type,
  title,
  peerId: type === 'group' ? null : peer.id,
  createdBy: type === 'group' ? me.id : null,
  members: type === 'group'
    ? [{ ...me, roleInGroup: '管理员' }, { ...peer, roleInGroup: '成员' }]
    : [{ ...me, roleInGroup: '成员' }, { ...peer, roleInGroup: '成员' }],
  lastMessage: { preview: '在吗', createdAt: 1_700_000_000_000 },
  unread: 0,
  ...over,
});

const view = (conversation: Conversation) => {
  const onToggleMute = vi.fn();
  render(
    <ChatPage
      me={me}
      conversations={[conversation]}
      activeId={conversation.id}
      messages={[]}
      typing={false}
      aiProviderLabel="模拟供应商"
      silentRead={false}
      canCreateGroup
      showChatOnMobile
      reads={[]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      onSelect={vi.fn()}
      onBack={vi.fn()}
      onSend={vi.fn()}
      onCreateGroup={vi.fn()}
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onRenameGroup={vi.fn()}
      onLeaveGroup={vi.fn()}
      onTogglePin={vi.fn()}
      onToggleMute={onToggleMute}
    />,
  );
  return { onToggleMute };
};

/** 顶栏那一个。两个入口同框，一律按区域取，不指望名字在全局唯一。 */
const head = () => {
  const el = document.querySelector<HTMLElement>('.chat__head');
  if (!el) throw new Error('找不到会话详情顶栏 .chat__head');
  return within(el);
};
/** 列表行上那一个（.convo__actions 里的免打扰按钮，置顶是同一区域的另一个）。 */
const listRow = () => {
  const el = document.querySelector<HTMLElement>('.convo__actions');
  if (!el) throw new Error('找不到会话列表行上的操作区 .convo__actions');
  return within(el);
};

describe('会话详情顶栏的免打扰入口', () => {
  // 群聊和单聊各来一遍：单聊没有成员面板，如果哪天有人把开关挪进成员面板，这条先红。
  const cases: Array<[ConversationType, string]> = [['group', '发版协作'], ['dm', '陈默'], ['ai', 'Aria']];

  for (const [type, title] of cases) {
    it(`${type} 会话的详情里有免打扰开关，点一下请求开启`, async () => {
      const { onToggleMute } = view(convo(type, title));
      const button = head().getByRole('button', { name: `免打扰「${title}」（当前会话）` });
      expect(button).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(button);
      // 传的是「改成什么」，不是「当前是什么」
      expect(onToggleMute).toHaveBeenCalledWith(`c_${title}`, true);
      expect(onToggleMute).toHaveBeenCalledTimes(1);
    });

    it(`${type} 会话已免打扰时，详情里的开关变成「取消免打扰」，点一下请求取消`, async () => {
      const { onToggleMute } = view(convo(type, title, { muted: true }));
      const button = head().getByRole('button', { name: `取消免打扰「${title}」（当前会话）` });
      expect(button).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(button);
      expect(onToggleMute).toHaveBeenCalledWith(`c_${title}`, false);
      expect(onToggleMute).toHaveBeenCalledTimes(1);
    });
  }

  it('单聊没有成员面板，开关也照样够得着 —— 它不在成员面板里', () => {
    view(convo('dm', '陈默'));
    expect(document.querySelector('.members')).toBeNull();
    expect(head().getByRole('button', { name: '免打扰「陈默」（当前会话）' })).toBeInTheDocument();
  });

  it('详情里多了入口之后，列表行上那个仍然在（两个都要有，不是搬家）', async () => {
    view(convo('group', '发版协作'));
    // findBy 顺带把 aiContext 那个 promise 冲干净，免得 act(...) 告警
    expect(await head().findByRole('button', { name: '免打扰「发版协作」（当前会话）' })).toBeInTheDocument();
    expect(listRow().getByRole('button', { name: '免打扰「发版协作」' })).toBeInTheDocument();
  });

  it('两个入口读的是同一份 conversation.muted，状态不会各说各话', async () => {
    view(convo('group', '发版协作', { muted: true }));
    expect(await head().findByRole('button', { name: '取消免打扰「发版协作」（当前会话）' })).toHaveAttribute('aria-pressed', 'true');
    expect(listRow().getByRole('button', { name: '取消免打扰「发版协作」' })).toHaveAttribute('aria-pressed', 'true');
    // 列表行上的静音记号也还在
    expect(screen.getByLabelText('已免打扰')).toBeInTheDocument();
  });

  it('两个按钮的无障碍名称必须互不相同 —— 同框的两个同名按钮读屏分不清', async () => {
    view(convo('group', '发版协作'));
    // 顺带冲掉 aiContext 那个 promise，免得 act(...) 告警。标题在列表和顶栏各有一处，用 findAll。
    await screen.findAllByText('发版协作');
    const names = screen.getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') || '')
      .filter((n) => n.includes('免打扰'));
    expect(names).toEqual(['免打扰「发版协作」', '免打扰「发版协作」（当前会话）']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('顶栏的开关只管免打扰，不碰置顶', async () => {
    const conversation = convo('group', '发版协作', { pinned: true });
    const onTogglePin = vi.fn();
    const onToggleMute = vi.fn();
    render(
      <ChatPage
        me={me}
        conversations={[conversation]}
        activeId={conversation.id}
        messages={[]}
        typing={false}
        aiProviderLabel="模拟供应商"
        silentRead={false}
        canCreateGroup
        showChatOnMobile
        reads={[]}
        hasOlder={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        onSelect={vi.fn()}
        onBack={vi.fn()}
        onSend={vi.fn()}
        onCreateGroup={vi.fn()}
        onAddMembers={vi.fn()}
        onRemoveMember={vi.fn()}
        onRenameGroup={vi.fn()}
        onLeaveGroup={vi.fn()}
        onTogglePin={onTogglePin}
        onToggleMute={onToggleMute}
      />,
    );
    await userEvent.click(head().getByRole('button', { name: '免打扰「发版协作」（当前会话）' }));
    expect(onToggleMute).toHaveBeenCalledWith('c_发版协作', true);
    expect(onTogglePin).not.toHaveBeenCalled();
  });
});
