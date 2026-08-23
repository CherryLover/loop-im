// 附件多选。产品决策不变：**文字和媒体各占一个气泡**，所以选 3 张图 + 一段文字
// = 发 4 条（1 条文字在前，3 条媒体按选择顺序在后）。
//
// 这个文件重点锁三块最容易错的地方：
//   1. 上限（9 个）和超出时的行为；
//   2. **发到一半失败**：已发出的绝不退回，没发出的（含它后面的）整截退回；
//   3. 多个附件之下，「按会话暂存草稿」「还原认发送时的那个会话」仍然成立。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Composer, MAX_ATTACHMENTS } from './Composer';
import { clearPreviewCache, localPreviewFor } from '../lib/upload-cache';
import type { Conversation, ReplyTarget } from '../lib/types';

const member = (id: string, name: string) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品', role: 'member' as const,
  avatarUrl: null, isAI: false, online: true, roleInGroup: '产品',
});

const conv = (id: string, title: string): Conversation => ({
  id,
  type: 'group',
  title,
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航')],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
});

const groupA = conv('c_a', '产品 · 发版协作');
const groupB = conv('c_b', '客户 · 交付群');

const FROM_CHEN: ReplyTarget = { id: 'm_1', senderName: '陈子航', preview: '联调排期改到下周二' };

interface UploadResult { url: string; filename: string; kind: string; storage: string }

const uploaded = (name: string): UploadResult => (
  { url: `/uploads/${name}`, filename: name, kind: 'image', storage: 'local' }
);

/**
 * 上传桩。按文件名决定结果：以 `bad` 开头的那个上传失败，其余成功。
 * 这样一批文件里「有的成、有的败」可以在一次选择里造出来。
 */
const upload = vi.fn(async (file: File): Promise<UploadResult> => {
  if (file.name.startsWith('bad')) throw new Error('这不是有效的图片文件');
  return uploaded(file.name);
});

vi.mock('../lib/api', () => ({
  MAX_UPLOAD_MB: 8,
  MAX_VIDEO_UPLOAD_MB: 100,
  api: { upload: (file: File) => upload(file) },
}));

const png = (name: string) => new File(['fake'], name, { type: 'image/png' });
const embed = (name: string) => `![${name}](/uploads/${name})`;

beforeEach(() => {
  upload.mockClear();
  // 预览缓存是模块级的，要在换掉 revoke 桩之前清，免得清理动作算到新桩头上。
  clearPreviewCache();
  URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
  URL.revokeObjectURL = vi.fn();
});

function Harness({ onSend }: { onSend: (body: string, replyTo?: string | null) => void | Promise<void> }) {
  const [active, setActive] = useState(groupA);
  const [request, setRequest] = useState<ReplyTarget | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setActive(groupA)}>切到A</button>
      <button type="button" onClick={() => setActive(groupB)}>切到B</button>
      <button type="button" onClick={() => setRequest({ ...FROM_CHEN })}>回复陈子航</button>
      <Composer conversation={active} meId="u_lin" onSend={onSend} replyRequest={request} />
    </div>
  );
}

/** 让在途的 Promise 全部落地。 */
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const setup = (onSend: (body: string, replyTo?: string | null) => void | Promise<void> = vi.fn()) => {
  const { container } = render(<Harness onSend={onSend} />);
  const input = () => screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
  return {
    container,
    input,
    onSend,
    type: (value: string) => fireEvent.change(input(), { target: { value } }),
    click: (name: string) => fireEvent.click(screen.getByRole('button', { name })),
    send: () => fireEvent.click(screen.getByRole('button', { name: '发送' })),
    /** 附件条上显示的文件名，按界面顺序。 */
    names: () => Array.from(container.querySelectorAll('.attach__name')).map((n) => n.textContent),
    removeButtons: () => Array.from(container.querySelectorAll('.attach__x')) as HTMLButtonElement[],
    /** 一次选中若干个文件（真实的多选就是这样一次 change 带一组 files）。 */
    pick: async (...names: string[]) => {
      await act(async () => {
        fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
          target: { files: names.map(png) },
        });
        await Promise.resolve();
      });
    },
  };
};

describe('一次能选多个', () => {
  it('file input 带 multiple，否则系统对话框根本不让多选', () => {
    const t = setup();
    expect(t.container.querySelector('input[type="file"]')).toHaveAttribute('multiple');
  });

  it('一次选 3 个，附件条上按选择顺序排成 3 行', async () => {
    const t = setup();
    await t.pick('a.png', 'b.png', 'c.png');

    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it('分几次选是追加，不是替换（以前后选的会顶掉先选的）', async () => {
    const t = setup();
    await t.pick('a.png');
    await t.pick('b.png', 'c.png');

    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('每一行各有各的移除按钮，移掉中间那个不影响别的', async () => {
    const t = setup();
    await t.pick('a.png', 'b.png', 'c.png');

    fireEvent.click(t.removeButtons()[1]);

    expect(t.names()).toEqual(['a.png', 'c.png']);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:b.png');   // 只放掉被移除的那个
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:a.png');
  });

  it('多选时提示总数和「按顺序各发一条」，只选一个时不啰嗦', async () => {
    const t = setup();
    await t.pick('a.png');
    expect(screen.queryByText(/已选 .*个附件/)).not.toBeInTheDocument();

    await t.pick('b.png');
    expect(screen.getByText(`已选 2/${MAX_ATTACHMENTS} 个附件，将按顺序各发一条`)).toBeInTheDocument();
  });
});

describe('数量上限', () => {
  it(`上限是 ${MAX_ATTACHMENTS} 个`, () => {
    // 依据：服务端 /uploads 是每分钟 20 次的用量限流，9 个一批意味着连发两批
    // （18 次）仍在额度内；无上限则一次拖 50 张既卡住自己也把额度瞬间打光。
    expect(MAX_ATTACHMENTS).toBe(9);
  });

  it('一次选超了：只收前 9 个，多的不收也不上传，并说清楚少了几个', async () => {
    const t = setup();
    await t.pick(...Array.from({ length: 12 }, (_, i) => `f${i}.png`));

    expect(t.names()).toHaveLength(MAX_ATTACHMENTS);
    expect(t.names()?.[0]).toBe('f0.png');
    expect(t.names()?.[8]).toBe('f8.png');
    expect(upload).toHaveBeenCalledTimes(MAX_ATTACHMENTS);            // 多的那 3 个没有白跑一趟
    expect(screen.getByText(`一次最多 ${MAX_ATTACHMENTS} 个附件，这次加进来 9 个，剩下 3 个没有加`))
      .toBeInTheDocument();
  });

  it('分批选也顶到同一个上限，装满之后再选给出提示', async () => {
    const t = setup();
    await t.pick(...Array.from({ length: 8 }, (_, i) => `f${i}.png`));
    await t.pick('x.png', 'y.png');                                   // 只剩 1 个位置

    expect(t.names()).toHaveLength(MAX_ATTACHMENTS);
    expect(t.names()?.[8]).toBe('x.png');

    upload.mockClear();
    await t.pick('z.png');                                            // 一个位置都没有了
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByText(`最多同时挂 ${MAX_ATTACHMENTS} 个附件，先发送或移除几个再选`))
      .toBeInTheDocument();
  });

  it('腾出位置之后又能继续选，提示跟着消失', async () => {
    const t = setup();
    await t.pick(...Array.from({ length: 9 }, (_, i) => `f${i}.png`));
    await t.pick('z.png');
    expect(screen.getByText(/最多同时挂/)).toBeInTheDocument();

    fireEvent.click(t.removeButtons()[0]);
    expect(screen.queryByText(/最多同时挂/)).not.toBeInTheDocument();

    await t.pick('z.png');
    expect(t.names()?.[8]).toBe('z.png');
  });
});

describe('发送：文字一条，每个附件各一条', () => {
  it('3 张图 + 一段文字发 4 条，文字在前，图片保持选择顺序', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');
    t.type('这是今天的三张构建截图');

    t.send();
    await settle();

    expect(onSend.mock.calls.map((c) => c[0])).toEqual([
      '这是今天的三张构建截图', embed('a.png'), embed('b.png'), embed('c.png'),
    ]);
  });

  it('只有 3 张图就发 3 条，发完输入框和附件条都干净了', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(3);
    expect(t.input().value).toBe('');
    expect(t.container.querySelector('.attach')).toBeNull();
  });

  it('引用只挂第一条：有文字挂文字那条，后面几条都不带', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'b.png');
    t.click('回复陈子航');
    t.type('见图');

    t.send();
    await settle();

    expect(onSend.mock.calls).toEqual([['见图', 'm_1'], [embed('a.png')], [embed('b.png')]]);
  });

  it('没有文字时，引用挂第一个附件那条，后面的不带', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'b.png');
    t.click('回复陈子航');

    t.send();
    await settle();

    expect(onSend.mock.calls).toEqual([[embed('a.png'), 'm_1'], [embed('b.png')]]);
  });

  it('还有在传的时候发不出去，「发送」按钮是禁用的', async () => {
    let finish: (r: UploadResult) => void = () => {};
    upload.mockImplementationOnce(() => new Promise<UploadResult>((res) => { finish = res; }));
    const t = setup();
    await t.pick('slow.png', 'quick.png');

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    await act(async () => {
      finish(uploaded('slow.png'));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });
});

describe('一批里有的上传失败', () => {
  it('一个上传失败不拖垮其他的：其余照常可发，失败的那行显示原因', async () => {
    const t = setup();
    await t.pick('a.png', 'bad.png', 'c.png');
    await settle();

    expect(screen.getByText('这不是有效的图片文件')).toBeInTheDocument();
    expect(screen.getAllByText('已上传，将作为图片附件发送')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('发送时跳过上传失败的那个，它**留在附件条上**而不是被悄悄扔掉', async () => {
    // 多选之后一批里坏一两个是常态。悄悄丢掉用户根本发现不了自己少发了东西。
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'bad.png', 'c.png');
    await settle();

    t.send();
    await settle();

    expect(onSend.mock.calls.map((c) => c[0])).toEqual([embed('a.png'), embed('c.png')]);
    expect(t.names()).toEqual(['bad.png']);
    expect(screen.getByText('这不是有效的图片文件')).toBeInTheDocument();
  });

  it('全都上传失败、又没有文字时发不出去', async () => {
    const onSend = vi.fn();
    const t = setup(onSend);
    await t.pick('bad1.png', 'bad2.png');
    await settle();

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    t.send();
    await settle();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('发到一半失败：已发出的不退回，没发出的整截退回', () => {
  /**
   * 这是本次多选里最关键的一档，行为定为 **fail-fast**：
   * 第 2 张失败时，第 1 张已经在对话里了（不动它），第 3 张**不再发**，
   * 和第 2 张一起退回附件条。理由见 Composer.submit 里那段注释。
   */
  it('第 2 张失败：第 3 张不发，第 2、3 张一起退回，第 1 张不退回', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)                              // a 成功
      .mockRejectedValueOnce(new Error('服务暂时不可用'));            // b 失败
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await settle();

    // c 那一条根本没有发出去。
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls.map((c) => c[0])).toEqual([embed('a.png'), embed('b.png')]);
    // 退回来的是「失败的那张 + 它后面的」，顺序原样保留，重发一次就能接上。
    expect(t.names()).toEqual(['b.png', 'c.png']);
    // a 已经真的在对话里了，绝不能退回来 —— 否则用户重发一次就发重了。
    expect(t.names()).not.toContain('a.png');
  });

  it('退回之后再点发送，只补发剩下的两条，顺序仍然是 b、c', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');
    t.send();
    await settle();

    onSend.mockResolvedValue(undefined);
    t.send();
    await settle();

    expect(onSend.mock.calls.slice(2).map((c) => c[0])).toEqual([embed('b.png'), embed('c.png')]);
    expect(t.container.querySelector('.attach')).toBeNull();
  });

  it('文字成了、第 1 张就失败：文字不退回，3 张全退回', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)                              // 文字成功
      .mockRejectedValueOnce(new Error('服务暂时不可用'));            // 第 1 张失败
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');
    t.type('三张构建截图');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(t.input().value).toBe('');                                 // 文字真的发出去了
    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('文字没成：一张都不发，文字和 3 张附件整组退回', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');
    t.type('三张构建截图');

    t.send();
    await settle();

    expect(onSend).toHaveBeenCalledTimes(1);                          // 只试了文字那一条
    expect(t.input().value).toBe('三张构建截图');
    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('最后一张失败：前面几张留在对话里，只退回最后那一张', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await settle();

    expect(t.names()).toEqual(['c.png']);
  });

  it('上传失败的那个和退回的那些能并存，退回的排在前面', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)                              // a 发出去了
      .mockRejectedValueOnce(new Error('服务暂时不可用'));            // b 失败
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'bad.png');
    await settle();

    t.send();
    await settle();

    // 没发出去的（b）排在前面，本来就没传上去的（bad）跟在后面。
    expect(t.names()).toEqual(['b.png', 'bad.png']);
  });

  it('引用挂在第一个附件上、而它失败了：引用跟着退回来', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png');
    t.click('回复陈子航');

    t.send();
    await settle();

    expect(screen.getByText('回复 陈子航')).toBeInTheDocument();
    expect(t.names()).toEqual(['a.png', 'b.png']);
  });

  it('引用挂在第一个附件上、它成了而第 2 张失败：引用**不**退回（已经带着它发出去了）', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png');
    t.click('回复陈子航');

    t.send();
    await settle();

    expect(screen.queryByText('回复 陈子航')).not.toBeInTheDocument();
    expect(t.names()).toEqual(['b.png']);
  });

  it('等待期间用户又选了新图：退回的排在前面，新选的跟在后面，都不丢', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await t.pick('new.png');                                          // 发送在途时又选了一张
    await settle();

    expect(t.names()).toEqual(['b.png', 'c.png', 'new.png']);
  });
});

describe('多个附件下，按会话暂存仍然成立', () => {
  it('在 A 群选了 3 张切到 B 再切回来，3 张原样都在（顺序也一样）', async () => {
    const t = setup();
    await t.pick('a.png', 'b.png', 'c.png');

    t.click('切到B');
    expect(t.names()).toEqual([]);

    await t.pick('b1.png', 'b2.png');                                 // B 群有自己的两张
    expect(t.names()).toEqual(['b1.png', 'b2.png']);

    t.click('切到A');
    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);

    t.click('切到B');
    expect(t.names()).toEqual(['b1.png', 'b2.png']);
  });

  it('切走只是暂存，一张预览图都不释放（切回来缩略图还得能显示）', async () => {
    const t = setup();
    await t.pick('a.png', 'b.png', 'c.png');
    t.click('切到B');

    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('上传还没回来就切走，结果落回发起上传的那个会话', async () => {
    let finish: (r: UploadResult) => void = () => {};
    upload.mockImplementationOnce(() => new Promise<UploadResult>((res) => { finish = res; }));
    const t = setup();
    await t.pick('slow.png', 'quick.png');
    expect(screen.getByText('上传中…')).toBeInTheDocument();

    t.click('切到B');
    await act(async () => {
      finish(uploaded('slow.png'));
      await Promise.resolve();
    });
    expect(t.names()).toEqual([]);                                    // 没串到 B 群

    t.click('切到A');
    expect(t.names()).toEqual(['slow.png', 'quick.png']);
    expect(screen.queryByText('上传中…')).not.toBeInTheDocument();
  });

  it('上传在途时把这一条移除了，结果落地时不会把它又塞回来', async () => {
    let finish: (r: UploadResult) => void = () => {};
    upload.mockImplementationOnce(() => new Promise<UploadResult>((res) => { finish = res; }));
    const t = setup();
    await t.pick('slow.png', 'quick.png');

    fireEvent.click(t.removeButtons()[0]);
    expect(t.names()).toEqual(['quick.png']);

    await act(async () => {
      finish(uploaded('slow.png'));
      await Promise.resolve();
    });
    expect(t.names()).toEqual(['quick.png']);
  });

  it('发到一半失败时切走了，退回的附件还给发送时的那个会话', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');
    t.type('A 群的内容');

    t.send();
    t.click('切到B');                                                 // 发送在途，人已经切走
    await settle();

    // B 群这边什么都不该多出来。
    expect(t.names()).toEqual([]);
    expect(t.input().value).toBe('');

    t.click('切到A');
    expect(t.names()).toEqual(['a.png', 'b.png', 'c.png']);
    expect(t.input().value).toBe('');                                 // 文字那条在 A 群发出去了
  });

  it('整组失败时切走了，文字和全部附件一起还给原会话', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png');
    t.type('A 群的内容');

    t.send();
    t.click('切到B');
    await settle();

    expect(t.input().value).toBe('');
    t.click('切到A');
    expect(t.input().value).toBe('A 群的内容');
    expect(t.names()).toEqual(['a.png', 'b.png']);
  });
});

describe('发送成功后的 blob 归属', () => {
  it('每张发出去的图都进了预览缓存，且都没有被 revoke', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await settle();

    for (const name of ['a.png', 'b.png', 'c.png']) {
      expect(localPreviewFor(`/uploads/${name}`)).toBe(`blob:${name}`);
      expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(`blob:${name}`);
    }
  });

  it('失败退回的那些不进缓存（它们还在附件条上用着自己的 blob）', async () => {
    const onSend = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('服务暂时不可用'));
    const t = setup(onSend);
    await t.pick('a.png', 'b.png', 'c.png');

    t.send();
    await settle();

    expect(localPreviewFor('/uploads/a.png')).toBe('blob:a.png');
    expect(localPreviewFor('/uploads/b.png')).toBeNull();
    expect(localPreviewFor('/uploads/c.png')).toBeNull();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:b.png');
  });
});
