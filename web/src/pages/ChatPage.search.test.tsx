// 搜索框：既过滤会话标题，也搜消息正文；点结果跳到对应会话。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPage } from './ChatPage';
import { api } from '../lib/api';
import type { Conversation, MessageSearchResult, User } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    searchMessages: vi.fn(),
  },
}));

const searchMessages = vi.mocked(api.searchMessages);

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'admin', avatarUrl: null, isAI: false, online: true,
};

const convo = (id: string, title: string): Conversation => ({
  id, type: 'group', title, peerId: null, createdBy: me.id,
  members: [{ ...me, roleInGroup: '管理员' }],
  lastMessage: { preview: '在吗', createdAt: 1_700_000_000_000 },
  unread: 0,
});

const hit = (id: string, body: string, overrides: Partial<MessageSearchResult> = {}): MessageSearchResult => ({
  id,
  conversationId: 'c_release',
  conversationTitle: '发版协作',
  conversationType: 'group',
  senderId: 'u_chen',
  senderName: '陈子航',
  senderAvatarUrl: null,
  body,
  mentions: [],
  createdAt: 1_700_000_000_000,
  isAI: false,
  ...overrides,
});

const page = (results: MessageSearchResult[]) => ({
  query: 'x', results, hasMore: false, nextBefore: null,
});

const view = (onSelect = vi.fn()) => {
  render(
    <ChatPage
      me={me}
      conversations={[convo('c_release', '发版协作'), convo('c_daily', '日常闲聊')]}
      activeId={null}
      messages={[]}
      typing={false}
      canCreateGroup
      showChatOnMobile={false}
      reads={[]}
      hasOlder={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      onSelect={onSelect}
      onBack={vi.fn()}
      onSend={vi.fn()}
      onCreateGroup={vi.fn()}
      onAddMembers={vi.fn()}
      onRemoveMember={vi.fn()}
      onRenameGroup={vi.fn()}
      onLeaveGroup={vi.fn()}
      onTogglePin={vi.fn()}
      onToggleMute={vi.fn()}
    />,
  );
  return onSelect;
};

const type = async (text: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('搜索会话和消息'), text);
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  searchMessages.mockResolvedValue(page([]));
});

describe('会话搜索框', () => {
  it('没输入关键词时不打服务端，也不显示分组标题', async () => {
    view();
    expect(screen.queryByText(/^消息 ·/)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 350));
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('输入关键词时既过滤会话标题，也把消息正文交给服务端搜', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '接口联调今晚能完成')]));
    view();
    await type('联调');

    await waitFor(() => expect(searchMessages).toHaveBeenCalledWith('联调', { limit: 20 }));
    // 会话标题里没有「联调」，所以会话分组是空的，但消息命中要出来
    expect(screen.getByText('会话 · 0')).toBeInTheDocument();
    expect(await screen.findByText(/接口联调今晚能完成/)).toBeInTheDocument();
    expect(screen.getByText('消息 · 1')).toBeInTheDocument();
  });

  it('会话标题命中时照旧显示会话，两组结果并存', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '发版协作群里聊的事')]));
    view();
    await type('发版');

    await waitFor(() => expect(screen.getByText('会话 · 1')).toBeInTheDocument());
    expect(await screen.findByText(/发版协作群里聊的事/)).toBeInTheDocument();
  });

  it('点击消息结果会跳到它所在的会话', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '接口联调今晚能完成', { conversationId: 'c_release' })]));
    const onSelect = view();
    const user = await type('联调');

    const row = await screen.findByRole('button', { name: /接口联调今晚能完成/ });
    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith('c_release');
  });

  it('结果行带上会话标题和发送者名字', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '接口联调今晚能完成')]));
    view();
    await type('联调');

    const row = await screen.findByRole('button', { name: /接口联调今晚能完成/ });
    expect(row).toHaveTextContent('发版协作');
    expect(row).toHaveTextContent('陈子航');
  });

  it('没有命中时给出明确提示，而不是空白一片', async () => {
    view();
    await type('绝不可能命中的词');
    expect(await screen.findByText('没有匹配的消息。')).toBeInTheDocument();
  });

  it('搜索失败时显示错误文案，不把上一次的结果留在屏幕上', async () => {
    searchMessages.mockRejectedValue(new Error('请求失败（500）'));
    view();
    await type('联调');
    expect(await screen.findByText('请求失败（500）')).toBeInTheDocument();
  });

  it('清空关键词后结果立刻收起', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '接口联调今晚能完成')]));
    view();
    const user = await type('联调');
    expect(await screen.findByText(/接口联调今晚能完成/)).toBeInTheDocument();

    await user.clear(screen.getByLabelText('搜索会话和消息'));
    await waitFor(() => expect(screen.queryByText(/接口联调今晚能完成/)).not.toBeInTheDocument());
    expect(screen.queryByText(/^消息 ·/)).not.toBeInTheDocument();
  });

  it('连续输入只按最后一个关键词发一次请求（防抖）', async () => {
    view();
    await type('联调环境');
    await waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(1));
    expect(searchMessages).toHaveBeenCalledWith('联调环境', { limit: 20 });
  });

  it('正文里的 Markdown 图片在结果行里压成 [图片]', async () => {
    searchMessages.mockResolvedValue(page([hit('m1', '看这个 ![截图](/uploads/a.png) 联调结果')]));
    view();
    await type('联调');

    const row = await screen.findByRole('button', { name: /联调结果/ });
    expect(row).toHaveTextContent('[图片]');
    expect(row).not.toHaveTextContent('/uploads/a.png');
  });
});
