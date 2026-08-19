import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiPage } from './AiPage';
import { api } from '../lib/api';
import type { AiOverview } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    aiOverview: vi.fn(),
    saveAiSettings: vi.fn(),
    testAi: vi.fn(),
  },
}));

const aiOverview = vi.mocked(api.aiOverview);
const saveAiSettings = vi.mocked(api.saveAiSettings);
const testAi = vi.mocked(api.testAi);

const overview: AiOverview = {
  provider: 'grok',
  hasApiKey: false,
  configured: false,
  providers: [
    { key: 'grok', name: 'Grok', note: '默认', model: 'grok-4' },
    { key: 'claude', name: 'Claude', note: '备选', model: 'claude-sonnet' },
  ],
  rules: { silentRead: true, replyAtAll: false, allowDm: true },
  statusLine: 'Grok 未配置凭据（本地模拟回复）· 群聊静默读取开启',
  stats: [],
  rows: [],
};

const TEST_MSG = '未配置凭据，使用本地模拟回复';

/** 渲染 AI 页并进入「AI 配置」子页 */
async function setup() {
  const user = userEvent.setup();
  render(<AiPage onSettingsSaved={vi.fn()} />);
  await user.click(await screen.findByRole('button', { name: /AI 配置/ }));
  return { user };
}

const saveBtn = () => screen.getByRole('button', { name: '保存配置' });
const testBtn = () => screen.getByRole('button', { name: '测试连通性' });
/** 规则开关是页面里唯一带 aria-pressed 的按钮 */
// #10 之后规则开关是 role="switch"（带可访问名称），不再是 aria-pressed 的 button。
const firstSwitch = () => screen.getAllByRole('switch', { checked: true })[0];

beforeEach(() => {
  aiOverview.mockResolvedValue(overview);
  saveAiSettings.mockResolvedValue({ ...overview });
  testAi.mockResolvedValue({ ok: false, message: TEST_MSG });
});

describe('issue #8 · AI 配置的反馈时效性', () => {
  it('测试失败后再保存，只显示最新的保存成功提示', async () => {
    const { user } = await setup();

    await user.click(testBtn());
    expect(await screen.findByText(TEST_MSG)).toBeInTheDocument();

    await user.click(saveBtn());
    expect(await screen.findByText('配置已保存')).toBeInTheDocument();
    expect(screen.queryByText(TEST_MSG)).not.toBeInTheDocument();
  });

  it('保存后再测试，只显示最新的测试结果', async () => {
    const { user } = await setup();

    await user.click(saveBtn());
    expect(await screen.findByText('配置已保存')).toBeInTheDocument();

    testAi.mockResolvedValue({ ok: true, message: '连通正常' });
    await user.click(testBtn());
    expect(await screen.findByText('连通正常')).toBeInTheDocument();
    expect(screen.queryByText('配置已保存')).not.toBeInTheDocument();
  });

  it('切换 AI Agent 会清掉过期反馈', async () => {
    const { user } = await setup();

    await user.click(testBtn());
    expect(await screen.findByText(TEST_MSG)).toBeInTheDocument();

    await user.click(screen.getByText('Claude'));
    expect(screen.queryByText(TEST_MSG)).not.toBeInTheDocument();
  });

  it('改动凭据会清掉过期反馈', async () => {
    const { user } = await setup();

    await user.click(testBtn());
    expect(await screen.findByText(TEST_MSG)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('sk-…'), 'sk-1');
    expect(screen.queryByText(TEST_MSG)).not.toBeInTheDocument();
  });

  it('改动规则开关会清掉过期反馈', async () => {
    const { user } = await setup();

    await user.click(testBtn());
    expect(await screen.findByText(TEST_MSG)).toBeInTheDocument();

    await user.click(firstSwitch());
    expect(screen.queryByText(TEST_MSG)).not.toBeInTheDocument();
  });

  it('保存失败不显示成功提示', async () => {
    const { user } = await setup();

    saveAiSettings.mockRejectedValue(new Error('保存失败（500）'));
    await user.click(saveBtn());
    expect(await screen.findByText('保存失败（500）')).toBeInTheDocument();
    expect(screen.queryByText('配置已保存')).not.toBeInTheDocument();
  });
});
