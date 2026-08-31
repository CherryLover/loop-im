// hapi Agent 管理页：状态展示、开关联动、改名校验反馈、测试连通性、未配置降级。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsPage } from './AgentsPage';
import { api } from '../lib/api';
import type { AgentsStatus } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    agentsStatus: vi.fn(),
    setAgentEnabled: vi.fn(),
    renameAgent: vi.fn(),
    testAgents: vi.fn(),
  },
}));

const mockApi = vi.mocked(api);

const status = (over: Partial<AgentsStatus> = {}): AgentsStatus => ({
  configured: true,
  machineOnline: true,
  machineHost: 'Test-Runner',
  hubError: null,
  agents: [
    { key: 'claude', label: 'Claude', defaultName: 'Claude', name: 'Claude', userId: 'ai-claude', enabled: false, available: false, online: false },
    { key: 'grok', label: 'Grok Build', defaultName: 'Grok-Build', name: 'Grok-Build', userId: 'ai-grok', enabled: true, available: true, online: true },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.agentsStatus.mockResolvedValue(status());
});

describe('AgentsPage', () => {
  it('展示连接状态与全部 Agent，开关是真的 switch（可访问名称指向名字）', async () => {
    render(<AgentsPage />);
    expect(await screen.findByText(/机器 Test-Runner 在线/)).toBeInTheDocument();

    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(screen.getByText(/Grok Build · 本机可用/)).toBeInTheDocument();
    expect(screen.getByText(/Claude · 未检测到/)).toBeInTheDocument();
    const grok = screen.getByRole('switch', { name: /Grok-Build/ });
    expect(grok).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /Claude/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('拨开关调用启用接口并刷新', async () => {
    mockApi.setAgentEnabled.mockResolvedValue({ ok: true });
    render(<AgentsPage />);
    await userEvent.click(await screen.findByRole('switch', { name: /Claude/ }));
    expect(mockApi.setAgentEnabled).toHaveBeenCalledWith('claude', true);
    await waitFor(() => expect(mockApi.agentsStatus).toHaveBeenCalledTimes(2));
  });

  it('启用但机器离线的 Agent 标出「暂不可用」', async () => {
    mockApi.agentsStatus.mockResolvedValue(status({
      machineOnline: false,
      agents: [
        { key: 'grok', label: 'Grok Build', defaultName: 'Grok-Build', name: 'Grok-Build', userId: 'ai-grok', enabled: true, available: true, online: false },
      ],
    }));
    render(<AgentsPage />);
    expect(await screen.findByText(/暂不可用（机器离线）/)).toBeInTheDocument();
    expect(screen.getByText(/机器不在线/)).toBeInTheDocument();
  });

  it('改名把新名字发给接口；接口报「空格」错误时就地显示', async () => {
    mockApi.renameAgent.mockRejectedValue(new Error('名字不能包含空格'));
    render(<AgentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /修改 Grok-Build 的名字/ }));
    const input = screen.getByRole('textbox', { name: /Grok Build 的显示名/ });
    await userEvent.clear(input);
    await userEvent.type(input, 'Grok Build');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(mockApi.renameAgent).toHaveBeenCalledWith('grok', 'Grok Build');
    expect(await screen.findByText(/名字不能包含空格/)).toBeInTheDocument();
  });

  it('测试连通性显示每一行结果', async () => {
    mockApi.testAgents.mockResolvedValue({ ok: true, lines: ['hub 连通 ✓', '机器 Test-Runner 在线，runner 运行中 ✓'] });
    render(<AgentsPage />);
    await userEvent.click(await screen.findByRole('button', { name: '测试连通性' }));
    const result = await screen.findByRole('status');
    expect(within(result).getByText(/hub 连通 ✓/)).toBeInTheDocument();
  });

  it('未配置时开关禁用并给出指引', async () => {
    mockApi.agentsStatus.mockResolvedValue(status({ configured: false, machineOnline: false }));
    render(<AgentsPage />);
    expect(await screen.findByText(/未配置 hapi 连接/)).toBeInTheDocument();
    for (const s of screen.getAllByRole('switch')) expect(s).toBeDisabled();
  });
});
