// 联系人页的「重置密码」入口：只有管理员看得见，重置后新密码显示一次给管理员抄走。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactsPage } from './ContactsPage';
import type { User } from '../lib/types';

const resetUserPassword = vi.fn();
vi.mock('../lib/api', () => ({ api: { get resetUserPassword() { return resetUserPassword; } } }));

const person = (id: string, name: string, isAI = false): User => ({
  id, name, email: `${id}@loop.dev`, dept: '产品',
  role: isAI ? 'ai' : 'member', avatarUrl: null, isAI, online: true,
});

const ME = person('u_admin', '管理员');
const CHEN = person('u_chen', '陈子航');
const SU = person('u_su', '苏晴');
const ARIA = person('ai', 'Aria', true);

const view = (isAdmin = true) => {
  render(
    <ContactsPage
      me={ME}
      users={[ME, CHEN, SU, ARIA]}
      isAdmin={isAdmin}
      onChat={vi.fn()}
      onAddContact={vi.fn()}
      onCreateGroup={vi.fn()}
    />,
  );
  return userEvent.setup();
};

const resetButton = (name: string) => screen.getByTitle(`重置 ${name} 的密码`);

beforeEach(() => {
  resetUserPassword.mockReset().mockResolvedValue({ user: CHEN, password: 'Kp7mQr4tXz9wVbNs' });
});

describe('重置密码入口', () => {
  it('管理员能在每个成员上看到入口', () => {
    view();
    expect(resetButton('陈子航')).toBeInTheDocument();
    expect(resetButton('苏晴')).toBeInTheDocument();
  });

  it('AI 账号没有密码，不给重置入口', () => {
    view();
    expect(screen.queryByTitle('重置 Aria 的密码')).not.toBeInTheDocument();
  });

  it('自己不在名单里，也就没法从这里重置自己的密码', () => {
    view();
    expect(screen.queryByTitle('重置 管理员 的密码')).not.toBeInTheDocument();
  });

  it('非管理员看不到任何重置入口', () => {
    view(false);
    expect(screen.queryByText('重置密码')).not.toBeInTheDocument();
  });
});

describe('重置弹窗', () => {
  it('先说明后果，确认后才调接口', async () => {
    const user = view();
    await user.click(resetButton('陈子航'));
    expect(screen.getByText(/在所有设备上都会被登出/)).toBeInTheDocument();
    expect(resetUserPassword).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认重置' }));
    expect(resetUserPassword).toHaveBeenCalledWith('u_chen');
  });

  it('重置成功后把新密码显示出来，并提示只显示这一次', async () => {
    const user = view();
    await user.click(resetButton('陈子航'));
    await user.click(screen.getByRole('button', { name: '确认重置' }));

    expect(await screen.findByText('Kp7mQr4tXz9wVbNs')).toBeInTheDocument();
    expect(screen.getByText(/只显示这一次/)).toBeInTheDocument();
    // 密码已经发出来了，不该再留一个能重复提交的按钮。
    expect(screen.queryByRole('button', { name: '确认重置' })).not.toBeInTheDocument();
  });

  it('关掉弹窗后新密码不再出现，重新打开也不会带出上次的密码', async () => {
    const user = view();
    await user.click(resetButton('陈子航'));
    await user.click(screen.getByRole('button', { name: '确认重置' }));
    await screen.findByText('Kp7mQr4tXz9wVbNs');

    await user.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.queryByText('Kp7mQr4tXz9wVbNs')).not.toBeInTheDocument();

    await user.click(resetButton('陈子航'));
    expect(screen.queryByText('Kp7mQr4tXz9wVbNs')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重置' })).toBeInTheDocument();
  });

  it('点的是谁就重置谁', async () => {
    const user = view();
    await user.click(resetButton('苏晴'));
    await user.click(screen.getByRole('button', { name: '确认重置' }));
    expect(resetUserPassword).toHaveBeenCalledWith('u_su');
  });

  it('取消不会调接口', async () => {
    const user = view();
    await user.click(resetButton('陈子航'));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(resetUserPassword).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '确认重置' })).not.toBeInTheDocument();
  });

  it('接口报错时显示服务端的原因，且可以重试', async () => {
    resetUserPassword.mockRejectedValue(new Error('需要管理员权限'));
    const user = view();
    await user.click(resetButton('陈子航'));
    await user.click(screen.getByRole('button', { name: '确认重置' }));
    expect(await screen.findByText('需要管理员权限')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重置' })).toBeEnabled();
  });
});
