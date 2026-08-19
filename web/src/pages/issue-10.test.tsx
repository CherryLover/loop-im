import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiPage } from './AiPage';
import type { AiOverview } from '../lib/types';

// issue #10：AI 配置里的三个规则开关必须有可识别名称（无障碍）

const overview: AiOverview = {
  provider: 'openai',
  hasApiKey: true,
  configured: true,
  providers: [
    { key: 'openai', name: 'OpenAI', note: '云端', model: 'gpt-4o-mini' },
    { key: 'grok', name: 'xAI Grok', note: '云端', model: 'grok-2' },
  ],
  rules: { silentRead: true, replyAtAll: false, allowDm: true },
  statusLine: '已连接 OpenAI',
  stats: [{ key: 'at', label: '今日被 @ 次数', value: '3', note: '较昨日持平' }],
  rows: [],
};

const saveAiSettings = vi.fn(async (_patch: Record<string, unknown>) => ({ ok: true as const }));

vi.mock('../lib/api', () => ({
  api: {
    aiOverview: vi.fn(async () => overview),
    saveAiSettings: (patch: Record<string, unknown>) => saveAiSettings(patch),
    testAi: vi.fn(async () => ({ ok: true, message: '连接正常' })),
  },
}));

// 进入「AI 配置」子页面，返回 user-event 实例
const openConfig = async () => {
  render(<AiPage onSettingsSaved={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'AI 配置' }));
  return user;
};

const names = ['群聊静默读取上下文', '@全员 时 AI 也回复', '允许成员与 AI 私聊'];

beforeEach(() => {
  saveAiSettings.mockClear();
});

describe('AI 配置 · 规则开关的可访问名称', () => {
  it('三个开关都能按名称找到，并暴露开关语义与状态', async () => {
    await openConfig();

    for (const name of names) {
      expect(screen.getByRole('switch', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('switch', { name: '群聊静默读取上下文' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '@全员 时 AI 也回复' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '允许成员与 AI 私聊' })).toBeChecked();
  });

  it('空格键和回车键都能独立切换某一个开关', async () => {
    const user = await openConfig();
    const atAll = screen.getByRole('switch', { name: '@全员 时 AI 也回复' });

    atAll.focus();
    await user.keyboard('{ }');
    expect(atAll).toBeChecked();
    await user.keyboard('{Enter}');
    expect(atAll).not.toBeChecked();

    // 其它两个开关不受影响
    expect(screen.getByRole('switch', { name: '群聊静默读取上下文' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '允许成员与 AI 私聊' })).toBeChecked();
  });

  it('Tab 能依次聚焦到三个开关', async () => {
    const user = await openConfig();
    const switches = names.map((name) => screen.getByRole('switch', { name }));

    switches[0].focus();
    expect(switches[0]).toHaveFocus();
    await user.tab();
    expect(switches[1]).toHaveFocus();
    await user.tab();
    expect(switches[2]).toHaveFocus();
  });

  it('保存后名称与状态仍然正确', async () => {
    const user = await openConfig();
    await user.click(screen.getByRole('switch', { name: '允许成员与 AI 私聊' }));
    await user.click(screen.getByRole('button', { name: '保存配置' }));

    expect(saveAiSettings).toHaveBeenCalledWith(expect.objectContaining({ allowDm: false }));
    expect(screen.getByRole('switch', { name: '允许成员与 AI 私聊' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: '群聊静默读取上下文' })).toBeChecked();
  });
});
