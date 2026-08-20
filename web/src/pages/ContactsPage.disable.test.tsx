// 联系人页的「停用 / 恢复账号」入口：只有管理员看得见。停用不是删除——
// 停用的人仍然留在名单里，只是标成「已停用」并恒为离线。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactsPage } from './ContactsPage';
import type { User } from '../lib/types';

const setUserDisabled = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    get setUserDisabled() { return setUserDisabled; },
    resetUserPassword: vi.fn(),
  },
}));

const person = (id: string, name: string, extra: Partial<User> = {}): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true, ...extra,
});

const ME = person('u_admin', '管理员', { role: 'admin' });
const CHEN = person('u_chen', '陈子航');
const GONE = person('u_gone', '周离职', { online: false, disabled: true });
const ARIA = person('ai', 'Aria', { role: 'ai', isAI: true });

const onUserChanged = vi.fn();

const view = (isAdmin = true) => {
  render(
    <ContactsPage
      me={ME}
      users={[ME, CHEN, GONE, ARIA]}
      isAdmin={isAdmin}
      onChat={vi.fn()}
      onAddContact={vi.fn()}
      onCreateGroup={vi.fn()}
      onUserChanged={onUserChanged}
    />,
  );
  return userEvent.setup();
};

beforeEach(() => {
  setUserDisabled.mockReset().mockResolvedValue({ user: { ...CHEN, disabled: true } });
  onUserChanged.mockReset();
});

describe('停用 / 恢复入口', () => {
  it('管理员在正常成员上看到「停用账号」，在停用的人身上看到「恢复账号」', () => {
    view();
    expect(screen.getByTitle('停用 陈子航 的账号')).toBeInTheDocument();
    expect(screen.getByTitle('恢复 周离职 的账号')).toBeInTheDocument();
    expect(screen.queryByTitle('恢复 陈子航 的账号')).not.toBeInTheDocument();
  });

  it('AI 账号没有登录这回事，不给停用入口', () => {
    view();
    expect(screen.queryByTitle('停用 Aria 的账号')).not.toBeInTheDocument();
  });

  it('自己不在名单里，也就没法从这里把自己停了', () => {
    view();
    expect(screen.queryByTitle('停用 管理员 的账号')).not.toBeInTheDocument();
  });

  it('非管理员看不到任何停用 / 恢复入口', () => {
    view(false);
    expect(screen.queryByText('停用账号')).not.toBeInTheDocument();
    expect(screen.queryByText('恢复账号')).not.toBeInTheDocument();
  });
});

describe('停用的人在名单里的样子', () => {
  it('仍然在名单里，名字和邮箱照常显示——停用不是删除', () => {
    view();
    expect(screen.getByText('周离职')).toBeInTheDocument();
    expect(screen.getByText('u_gone@loop.dev')).toBeInTheDocument();
  });

  it('状态显示「已停用」，而不是「在线 / 离线」', () => {
    render(
      <ContactsPage
        me={ME}
        // 故意把 online 造成 true：停用的人不管服务端怎么算都不该显示成在线
        users={[ME, person('u_x', '林停用', { disabled: true, online: true })]}
        isAdmin
        onChat={vi.fn()}
        onAddContact={vi.fn()}
        onCreateGroup={vi.fn()}
      />,
    );
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);
    expect(screen.queryByText('在线')).not.toBeInTheDocument();
  });
});

describe('停用弹窗', () => {
  it('先把后果说清楚（尤其是记录不会被删），确认后才调接口', async () => {
    const user = view();
    await user.click(screen.getByTitle('停用 陈子航 的账号'));
    expect(screen.getByText(/所有设备上的登录立刻失效/)).toBeInTheDocument();
    expect(screen.getByText(/聊天记录不会被删除/)).toBeInTheDocument();
    expect(setUserDisabled).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认停用' }));
    expect(setUserDisabled).toHaveBeenCalledWith('u_chen', true);
  });

  it('恢复走同一个弹窗，但传的是 false', async () => {
    const user = view();
    await user.click(screen.getByTitle('恢复 周离职 的账号'));
    expect(screen.getByText(/可以用原来的密码重新登录/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认恢复' }));
    expect(setUserDisabled).toHaveBeenCalledWith('u_gone', false);
  });

  it('成功后关掉弹窗并把结果回报给上层', async () => {
    const user = view();
    await user.click(screen.getByTitle('停用 陈子航 的账号'));
    await user.click(screen.getByRole('button', { name: '确认停用' }));

    expect(onUserChanged).toHaveBeenCalledWith('已停用 陈子航 的账号');
    expect(screen.queryByRole('button', { name: '确认停用' })).not.toBeInTheDocument();
  });

  it('取消不会调接口', async () => {
    const user = view();
    await user.click(screen.getByTitle('停用 陈子航 的账号'));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(setUserDisabled).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认停用' })).not.toBeInTheDocument();
  });

  it('接口报错时显示服务端的原因，且可以重试', async () => {
    setUserDisabled.mockRejectedValue(new Error('不能停用自己的账号'));
    const user = view();
    await user.click(screen.getByTitle('停用 陈子航 的账号'));
    await user.click(screen.getByRole('button', { name: '确认停用' }));

    expect(await screen.findByText('不能停用自己的账号')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认停用' })).toBeEnabled();
    expect(onUserChanged).not.toHaveBeenCalled();
  });
});
