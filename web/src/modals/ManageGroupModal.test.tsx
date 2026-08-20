// 群管理弹窗：加人 / 改群名 / 退群三种模式共用一个组件。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManageGroupModal } from './ManageGroupModal';
import type { Conversation, User } from '../lib/types';

const api = {
  addMembers: vi.fn(),
  renameConversation: vi.fn(),
  leaveConversation: vi.fn(),
};
vi.mock('../lib/api', () => ({ api: { get addMembers() { return api.addMembers; },
  get renameConversation() { return api.renameConversation; },
  get leaveConversation() { return api.leaveConversation; } } }));

const person = (id: string, name: string, isAI = false): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: isAI ? 'ai' : 'member', avatarUrl: null, isAI, online: true,
});

const IN_GROUP = person('u_chen', '陈子航');
const OUTSIDER = person('u_su', '苏晴');
const ARIA = person('ai', 'Aria', true);

const room: Conversation = {
  id: 'c_room', type: 'group', title: '发版协作', peerId: null, createdBy: 'u_lin',
  members: [IN_GROUP].map((m) => ({ ...m, roleInGroup: m.dept })),
  lastMessage: null, unread: 0,
};

const view = (mode: 'add' | 'rename' | 'leave', users: User[] = [IN_GROUP, OUTSIDER, ARIA]) => {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(<ManageGroupModal mode={mode} conversation={room} users={users} onClose={onClose} onDone={onDone} />);
  return { onDone, onClose, user: userEvent.setup() };
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({});
});

describe('添加成员', () => {
  it('只列出还没在群里的人', () => {
    view('add');
    expect(screen.getByText('苏晴')).toBeInTheDocument();
    expect(screen.getByText('Aria')).toBeInTheDocument();     // Aria 被移出后可以加回来
    expect(screen.queryByText('陈子航')).not.toBeInTheDocument();
  });

  it('没选人时提交按钮不可用，选了就可用并显示个数', async () => {
    const { user } = view('add');
    expect(screen.getByRole('button', { name: /添加（0）/ })).toBeDisabled();
    await user.click(screen.getByText('苏晴'));
    expect(screen.getByRole('button', { name: /添加（1）/ })).toBeEnabled();
  });

  it('提交后带上选中的 id 调接口，并回执给上层', async () => {
    const { user, onDone } = view('add');
    await user.click(screen.getByText('苏晴'));
    await user.click(screen.getByRole('button', { name: /添加（1）/ }));
    expect(api.addMembers).toHaveBeenCalledWith('c_room', ['u_su']);
    expect(onDone).toHaveBeenCalledWith('已添加 1 名成员');
  });

  it('所有人都在群里时给出说明而不是空列表', () => {
    view('add', [IN_GROUP]);
    expect(screen.getByText('所有人都已经在群里了。')).toBeInTheDocument();
  });
});

describe('修改群名', () => {
  it('预填当前群名，清空后不能提交', async () => {
    const { user } = view('rename');
    const input = screen.getByLabelText('群名称');
    expect(input).toHaveValue('发版协作');
    await user.clear(input);
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('只有空白字符也算空，不能提交', async () => {
    const { user } = view('rename');
    const input = screen.getByLabelText('群名称');
    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('提交时去掉首尾空白', async () => {
    const { user, onDone } = view('rename');
    const input = screen.getByLabelText('群名称');
    await user.clear(input);
    await user.type(input, '  新名字  ');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(api.renameConversation).toHaveBeenCalledWith('c_room', '新名字');
    expect(onDone).toHaveBeenCalledWith('群名已改为「新名字」');
  });
});

describe('退出群聊', () => {
  it('说明退出的后果，确认后调接口并告知上层「已离开」', async () => {
    const { user, onDone } = view('leave');
    expect(screen.getByText(/退出后将不再收到「发版协作」的消息/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认退出' }));
    expect(api.leaveConversation).toHaveBeenCalledWith('c_room');
    expect(onDone).toHaveBeenCalledWith('已退出「发版协作」', true);
  });
});

describe('失败处理', () => {
  it('接口报错时显示服务端的原因，且不通知上层成功', async () => {
    api.renameConversation.mockRejectedValue(new Error('只有群主或管理员可以改群名'));
    const { user, onDone } = view('rename');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('只有群主或管理员可以改群名')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('失败后按钮恢复可点，可以重试', async () => {
    api.leaveConversation.mockRejectedValue(new Error('网络错误'));
    const { user } = view('leave');
    await user.click(screen.getByRole('button', { name: '确认退出' }));
    expect(await screen.findByText('网络错误')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认退出' })).toBeEnabled();
  });

  it('取消会关闭弹窗且不调任何接口', async () => {
    const { user, onClose } = view('add');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.addMembers).not.toHaveBeenCalled();
  });
});
