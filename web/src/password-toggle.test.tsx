// 密码输入框的「小眼睛」：默认隐藏，点一下切明文，再点回去。
//
// 这里锁住的重点：
// - 全站每一处密码/密钥输入都走同一个 PasswordInput，不允许再出现裸的 type="password"
//   （最后那条源码扫描就是为此立的：仓库已经因为同一件事重复实现吃过亏）；
// - 切换按钮是 type="button"：登录页的输入框在 <form> 里，默认的 submit 会让
//   「看一眼密码」直接把登录表单提交出去；
// - aria-label 跟着状态变，读屏用户知道现在点下去是显示还是隐藏。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './pages/LoginPage';
import { ProfileModal } from './modals/ProfileModal';
import { PasswordInput } from './components/PasswordInput';
import type { User } from './lib/types';

const me: User = {
  id: 'u_lin', name: '林悦', email: 'lin@loop.dev', dept: '产品',
  role: 'member', avatarUrl: null, isAI: false, online: true,
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const profile = () => render(
  <ProfileModal
    me={me} theme="light" onToggleTheme={vi.fn()} onClose={vi.fn()}
    notifyEnabled={false} notifyPermission="unsupported" onToggleNotify={vi.fn()}
    onUpdated={vi.fn()} onSignOut={vi.fn()}
  />,
);

describe('PasswordInput 本身', () => {
  it('默认隐藏，点一下切明文，再点一下切回去', async () => {
    render(<PasswordInput placeholder="密码" />);
    const input = screen.getByPlaceholderText('密码');
    expect(input).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: '显示密码' }));
    expect(input).toHaveAttribute('type', 'text');

    await userEvent.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('切换按钮是 type="button"，并用 aria-pressed 报当前是开是关', async () => {
    render(<PasswordInput placeholder="密码" />);
    const eye = screen.getByRole('button', { name: '显示密码' });
    expect(eye).toHaveAttribute('type', 'button');
    expect(eye).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(eye);
    expect(screen.getByRole('button', { name: '隐藏密码' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('切换只改 type，不动 value——输入到一半点开看一眼不会丢字', async () => {
    render(<PasswordInput placeholder="密码" />);
    const input = screen.getByPlaceholderText('密码');
    await userEvent.type(input, 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: '显示密码' }));
    expect(input).toHaveValue('hunter2');
  });
});

describe('登录页', () => {
  it('密码框带小眼睛，能来回切', async () => {
    render(<LoginPage onSignedIn={vi.fn()} />);
    const input = screen.getByLabelText('密码', { exact: true });
    expect(input).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: '显示密码' }));
    expect(input).toHaveAttribute('type', 'text');
  });

  it('点小眼睛不会把登录表单提交出去（type="button" 的意义）', async () => {
    render(<LoginPage onSignedIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('邮箱'), 'lin@loop.dev');
    await userEvent.type(screen.getByLabelText('密码', { exact: true }), 'hunter2');

    await userEvent.click(screen.getByRole('button', { name: '显示密码' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();  // 没进「登录中…」
  });

  it('输入框的可访问名仍然正好是「密码」——小眼睛的 aria-label 不能混进来', () => {
    render(<LoginPage onSignedIn={vi.fn()} />);
    // 精确匹配拿到的必须是输入框本身；e2e 的 getByLabel('密码', { exact: true }) 靠这条活着
    expect(screen.getByLabelText('密码', { exact: true }).tagName).toBe('INPUT');
  });
});

describe('个人资料里的修改密码', () => {
  it('三个框各有各的小眼睛，互不影响', async () => {
    profile();
    const current = screen.getByPlaceholderText('当前密码');
    const next = screen.getByPlaceholderText('新密码');
    const confirm = screen.getByPlaceholderText('确认新密码');
    for (const input of [current, next, confirm]) expect(input).toHaveAttribute('type', 'password');

    const eyes = screen.getAllByRole('button', { name: '显示密码' });
    expect(eyes).toHaveLength(3);

    await userEvent.click(eyes[1]);
    expect(current).toHaveAttribute('type', 'password');
    expect(next).toHaveAttribute('type', 'text');
    expect(confirm).toHaveAttribute('type', 'password');
  });
});

describe('全站不允许再出现裸的密码输入框', () => {
  // 只要有人又在页面里手写一个 type="password"，这条就红——共用组件才不会被绕过去。
  const sources = import.meta.glob('./**/*.tsx', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  it('除了 PasswordInput 自己，没有别的组件写 type="password"', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith('/PasswordInput.tsx') && !path.includes('.test.'))
      .filter(([, code]) => /type=["']password["']/.test(code))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it('扫描确实扫到了东西（防止 glob 写错导致这条空跑）', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(sources['./components/PasswordInput.tsx']).toMatch(/type=\{visible \? 'text' : 'password'\}/);
  });
});
