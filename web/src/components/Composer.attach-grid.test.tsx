// 待发送附件从「一行一条、竖着堆」改成「1:1 方块、横着排、放不下横向滚」之后，
// 这里锁住**结构和信息**这两件事 —— 布局本身（横排、1:1、滚动条）是纯 CSS，
// jsdom 不做布局也不算层叠，验不了，只能到真浏览器里看（文件末尾列了清单）。
//
// 真正怕的不是「排歪了」，是「为了塞进小方块，信息被弄丢了」：
//   - 文件名还在不在；
//   - 上传中 / 失败还看不看得出来，失败是不是只剩一个红色（色觉障碍就废了）；
//   - 失败的**完整原因**还读不读得到，有没有被 72px 的格子截断；
//   - 移除按钮还点不点得到，无障碍名有没有变。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Composer, MAX_ATTACHMENTS } from './Composer';
import { clearPreviewCache } from '../lib/upload-cache';
import type { Conversation } from '../lib/types';

const member = (id: string, name: string) => ({
  id, name, email: `${id}@loop.dev`, dept: '产品', role: 'member' as const,
  avatarUrl: null, isAI: false, online: true, roleInGroup: '产品',
});

const group: Conversation = {
  id: 'c_a',
  type: 'group',
  title: '产品 · 发版协作',
  peerId: null,
  members: [member('u_lin', '林悦'), member('u_chen', '陈子航')],
  lastMessage: null,
  unread: 0,
  createdBy: 'u_lin',
};

interface UploadResult { url: string; filename: string; kind: string; storage: string }

/** 以 `bad` 开头的文件上传失败，且**故意给一句很长的报错** —— 方块里绝对放不下。 */
const LONG_ERROR = '这个文件在服务端被判定为无效：既不是有效的图片，也不在允许的扩展名白名单里，请换一个文件重试';
const upload = vi.fn(async (file: File): Promise<UploadResult> => {
  if (file.name.startsWith('bad')) throw new Error(LONG_ERROR);
  return {
    url: `/uploads/${file.name}`,
    filename: file.name,
    kind: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file',
    storage: 'local',
  };
});

vi.mock('../lib/api', () => ({
  MAX_UPLOAD_MB: 8,
  MAX_VIDEO_UPLOAD_MB: 100,
  api: { upload: (file: File) => upload(file) },
}));

const png = (name: string) => new File(['fake'], name, { type: 'image/png' });
const pdf = (name: string) => new File(['fake'], name, { type: 'application/pdf' });

beforeEach(() => {
  upload.mockClear();
  clearPreviewCache();
  URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
  URL.revokeObjectURL = vi.fn();
});

function setup() {
  const { container } = render(
    <Composer conversation={group} meId="u_lin" onSend={vi.fn()} replyRequest={null} />,
  );
  return {
    container,
    tiles: () => Array.from(container.querySelectorAll('.attach')) as HTMLElement[],
    list: () => container.querySelector('.attach-list') as HTMLElement | null,
    /** 一次选中若干文件（真实多选就是一次 change 带一组 files）。 */
    pick: async (...files: File[]) => {
      await act(async () => {
        fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
          target: { files },
        });
        await Promise.resolve();
      });
    },
  };
}

/** 让在途的上传 Promise 落地。 */
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('每个附件是一个独立的方块，且都是 .attach-list 的直接子节点', () => {
  it('选 9 个就是 9 个平级的方块，没有多包一层会把它们竖着堆起来的容器', async () => {
    const { pick, tiles, list } = setup();
    await pick(...Array.from({ length: MAX_ATTACHMENTS }, (_, i) => png(`p${i}.png`)));
    await settle();

    expect(tiles()).toHaveLength(MAX_ATTACHMENTS);
    // 横向排列靠的是 .attach-list 上的 flex-direction: row，前提是这 9 个是它的直接子节点。
    for (const tile of tiles()) expect(tile.parentElement).toBe(list());
  });

  it('方块的 title 上挂着完整文件名（格子里那条一定会被截断）', async () => {
    const { pick, tiles } = setup();
    const long = '2026-Q3-发版验收报告-最终版-真的最终版.png';
    await pick(png(long));
    await settle();

    expect(tiles()[0].getAttribute('title')).toBe(long);
    // 截断是 CSS 的事，DOM 里文件名必须是完整的，否则读屏也只能读到半截。
    expect(tiles()[0].querySelector('.attach__name')?.textContent).toBe(long);
  });
});

describe('三种状态在 DOM 上是可区分的', () => {
  it('上传中 / 已就绪 / 失败各自写在 data-state 上，CSS 靠它画不同的样子', async () => {
    let finish: (r: UploadResult) => void = () => {};
    upload.mockImplementationOnce(() => new Promise((res) => { finish = res as typeof finish; }));
    const { pick, tiles } = setup();

    await pick(png('slow.png'));
    expect(tiles()[0].dataset.state).toBe('uploading');
    expect(screen.getByText('上传中…')).toBeInTheDocument();

    await act(async () => {
      finish({ url: '/uploads/slow.png', filename: 'slow.png', kind: 'image', storage: 'local' });
      await Promise.resolve();
    });
    expect(tiles()[0].dataset.state).toBe('ready');
  });

  it('失败的方块是 error 态，且**不只**靠颜色：还有 ⚠ 和整句原因', async () => {
    const { pick, tiles } = setup();
    await pick(png('bad.png'));
    await settle();

    expect(tiles()[0].dataset.state).toBe('error');
    // ⚠ 由 CSS 的 ::after 画（jsdom 不算伪元素，这里只能验 data-state 这个开关在）；
    // 能在 DOM 里验的第二个非颜色标记是下面这句完整的文字原因。
    expect(screen.getByText(LONG_ERROR)).toBeInTheDocument();
  });

  it('就绪态的说明文案仍然留在 DOM 里给读屏（视觉上由 CSS 隐藏）', async () => {
    const { pick } = setup();
    await pick(png('ok.png'));
    await settle();

    expect(screen.getByText('已上传，将作为图片附件发送')).toBeInTheDocument();
  });
});

describe('失败原因必须读得全，而且只出现一次', () => {
  it('完整原因放在方块外面的 role="alert" 区里，不靠悬停（手机没有悬停）', async () => {
    const { pick, container } = setup();
    await pick(png('bad.png'));
    await settle();

    const alerts = container.querySelector('.attach-alerts');
    expect(alerts).not.toBeNull();
    expect(alerts?.getAttribute('role')).toBe('alert');
    expect(alerts?.textContent).toContain(LONG_ERROR);
    // 原因是「附件方块之外」的一条独立文字行，不在只有 72px 宽的格子里。
    expect(alerts?.closest('.attach')).toBeNull();
  });

  it('一句原因全篇只渲染一处，不在方块里再抄一遍', async () => {
    const { pick } = setup();
    await pick(png('bad.png'));
    await settle();

    expect(screen.getAllByText(LONG_ERROR)).toHaveLength(1);
  });

  it('哪个文件失败了说得出来，同时文件名不会因此变成两个同名节点', async () => {
    const { pick, container } = setup();
    await pick(png('good.png'), png('bad-1.png'));
    await settle();

    const alerts = container.querySelector('.attach-alerts');
    expect(alerts?.textContent).toContain('bad-1.png');
    // 提示行里的文件名是纯文本节点，不是独立元素，所以 getByText 仍然唯一命中方块里那个。
    expect(screen.getByText('bad-1.png')).toHaveClass('attach__name');
  });

  it('没有失败的时候整个提示区不渲染', async () => {
    const { pick, container } = setup();
    await pick(png('good.png'));
    await settle();

    expect(container.querySelector('.attach-alerts')).toBeNull();
  });
});

describe('非图片附件在方块里也说得清是什么', () => {
  it('PDF 没有缩略图，给的是图标而不是空白格，文件名照常在', async () => {
    const { pick, tiles } = setup();
    await pick(pdf('合同.pdf'));
    await settle();

    const thumb = tiles()[0].querySelector('.attach__thumb') as HTMLElement;
    expect(thumb.querySelector('img')).toBeNull();
    expect(thumb).toHaveClass('attach__thumb--file');
    expect(thumb.querySelector('svg')).not.toBeNull();          // lucide 的文件图标
    expect(tiles()[0].querySelector('.attach__name')?.textContent).toBe('合同.pdf');
  });
});

describe('移除按钮：无障碍名没变，多选之下也删得准', () => {
  it('每个方块各带一个「移除附件」按钮，无障碍名就是这四个字', async () => {
    const { pick, tiles } = setup();
    await pick(png('a.png'), png('b.png'), png('c.png'));
    await settle();

    expect(screen.getAllByRole('button', { name: '移除附件' })).toHaveLength(3);
    for (const tile of tiles()) expect(tile.querySelector('.attach__x')).not.toBeNull();
  });

  it('点第二个方块上的叉，删掉的就是第二个', async () => {
    const { pick, container } = setup();
    await pick(png('a.png'), png('b.png'), png('c.png'));
    await settle();

    const buttons = screen.getAllByRole('button', { name: '移除附件' });
    await act(async () => { fireEvent.click(buttons[1]); });

    const names = Array.from(container.querySelectorAll('.attach__name')).map((n) => n.textContent);
    expect(names).toEqual(['a.png', 'c.png']);
  });

  it('失败的那个也删得掉，删完提示行跟着消失', async () => {
    const { pick, container } = setup();
    await pick(png('bad.png'));
    await settle();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '移除附件' })); });

    expect(container.querySelector('.attach')).toBeNull();
    expect(container.querySelector('.attach-alerts')).toBeNull();
  });
});

describe('多选计数仍然在，且在方块之外', () => {
  it('选 2 个以上才提示总数，且它不是横向滚动条里的一格', async () => {
    const { pick, container } = setup();
    await pick(png('a.png'), png('b.png'));
    await settle();

    const count = container.querySelector('.attach-list__count');
    expect(count?.textContent).toContain(`已选 2/${MAX_ATTACHMENTS} 个附件`);
    // 计数条如果被塞进 .attach-list，横排时它会变成第一格，把方块挤走。
    expect(count?.closest('.attach-list')).toBeNull();
  });
});

/*
 * 只能靠真浏览器看的部分（jsdom 一概验不了）：
 *   1. 方块确实是 1:1、确实横着排、宽度确实是 72px（手机 64px）；
 *   2. 放不下时确实出现横向滚动条，而且滚动条是细的那一档；
 *   3. 触摸横滑、以及用 Tab 走到后面的方块时容器会自动跟着滚；
 *   4. 文件名条 / 移除按钮 / 上传中遮罩压在**真实图片**上时的可读性；
 *   5. 窄屏下附件区确实没再把输入框挤出可视区。
 */
