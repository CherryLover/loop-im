// 回归：issue #5 —— 手机端建群成功后没有直接进入新群。
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPage } from './pages/ChatPage';
import { CreateGroupModal } from './modals/CreateGroupModal';
import type { Conversation, User } from './lib/types';

vi.mock('./lib/api', () => ({
  // #9 之后 Composer 会读这个常量来做本地大小校验，mock 里要一并提供。
  MAX_UPLOAD_MB: 8,
  api: {
    aiContext: vi.fn(async () => ({ line: '' })),
    createGroup: vi.fn(async () => {
      throw new Error('仅管理员可建群');
    }),
  },
}));

// jsdom 没有实现 scrollIntoView，消息列表挂载时会调用它。
Element.prototype.scrollIntoView = vi.fn();

const member = (id: string, name: string, isAI = false) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: (isAI ? 'ai' : 'member') as 'ai' | 'member',
  avatarUrl: null, isAI, online: true, roleInGroup: '产品',
});

const me: User = member('u_lin', '林悦');

const group: Conversation = {
  id: 'c_new',
  type: 'group',
  title: '新建的群',
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航'), member('ai', 'Aria', true)],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
};

// 建群成功后 AppShell 会走 selectConversation（选中会话 + 手机端展开详情），
// 这里直接以受控的 showChatOnMobile 验证 ChatPage 在两种状态下的呈现。
const renderChat = (showChatOnMobile: boolean, onBack = vi.fn()) => {
  const view = render(
    <ChatPage
      me={me}
      conversations={[group]}
      activeId={group.id}
      messages={[]}
      typing={false}
      reads={[]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      aiProviderLabel="模拟供应商"
      silentRead={false}
      canCreateGroup
      showChatOnMobile={showChatOnMobile}
      onSelect={vi.fn()}
      onBack={onBack}
      onSend={vi.fn()}
      onCreateGroup={vi.fn()}
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onRenameGroup={vi.fn()}
      onLeaveGroup={vi.fn()}
    />,
  );
  return { ...view, onBack };
};

describe('建群成功后的会话跳转', () => {
  it('新群被选中并展开时，手机端直接显示聊天详情', async () => {
    const { container } = renderChat(true);
    expect(await screen.findByTitle('返回会话列表')).toBeInTheDocument();
    // 手机端靠 convos--hidden / chat--hidden 二选一，详情展开时列表让位。
    expect(container.querySelector('.convos')?.className).toContain('convos--hidden');
    expect(container.querySelector('.chat__main')).toBeInTheDocument();
    expect(container.querySelector('.chat--hidden')).toBeNull();
  });

  it('返回按钮通知外部收起详情，回到会话列表', async () => {
    const user = userEvent.setup();
    const { onBack } = renderChat(true);
    await user.click(screen.getByTitle('返回会话列表'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('没有展开时，手机端仍然停在会话列表', async () => {
    const { container } = renderChat(false);
    expect((await screen.findAllByText('新建的群')).length).toBeGreaterThan(0);
    expect(container.querySelector('.convos--hidden')).toBeNull();
    expect(container.querySelector('.chat--hidden')).toBeInTheDocument();
  });

  it('收起详情后新群仍是会话列表里的选中态', async () => {
    const { container } = renderChat(false);
    expect(container.querySelector('.convos--hidden')).toBeNull();
    expect(container.querySelector('.convo--on')).toHaveTextContent('新建的群');
  });

  it('创建失败时弹窗保持打开并提示错误', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateGroupModal
        users={[me, member('u_chen', '陈子航'), member('u_zhou', '周明')]}
        meId={me.id}
        onClose={onClose}
        onCreated={onCreated}
      />,
    );
    await user.click(screen.getByText('陈子航'));
    await user.click(screen.getByText('周明'));
    await user.click(screen.getByRole('button', { name: /创建并进入/ }));

    expect(await screen.findByText('仅管理员可建群')).toBeInTheDocument();
    expect(screen.getByText('创建群聊')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
