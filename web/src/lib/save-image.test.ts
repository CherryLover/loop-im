import { describe, expect, it } from 'vitest';
import { imageFileName } from './save-image';

/**
 * 只测起名字这条纯逻辑。真正的下载（triggerDownload）在 ImageViewer.save.test.tsx
 * 里连着按钮一起测 —— 单独测它只能再抄一遍 createObjectURL 的桩，没有额外收益。
 */
describe('imageFileName：给要保存的图起名字', () => {
  it('alt 是发送时的文件名（无扩展名），扩展名由 MIME 补上', () => {
    expect(imageFileName('发版流程', '/uploads/9f3a.png?token=abc', 'image/png')).toBe('发版流程.png');
  });

  it('alt 自带扩展名时，格式仍以真下载到的 MIME 为准', () => {
    // 服务端转过格式的话，URL/alt 上的旧扩展名就是错的。
    expect(imageFileName('photo.JPG', '/uploads/x.bin', 'image/jpeg')).toBe('photo.jpg');
  });

  it('alt 空了退回 URL 的 basename，token 那串查询参数不掺进来', () => {
    expect(imageFileName('', '/uploads/9f3a.png?token=abc', 'image/png')).toBe('9f3a.png');
  });

  it('MIME 不认识时退回 URL 上原有的扩展名', () => {
    expect(imageFileName('', '/uploads/9f3a.png', 'application/octet-stream')).toBe('9f3a.png');
  });

  it('blob: 地址没有像样的路径，拿末段当名、MIME 定后缀', () => {
    expect(imageFileName('', 'blob:http://localhost:5173/abc-def', 'image/jpeg')).toBe('abc-def.jpg');
  });

  it('alt 里的路径分隔符等非法字符换成空格，写不坏文件名', () => {
    expect(imageFileName('a/b:c', '/uploads/x.png', 'image/png')).toBe('a b c.png');
  });

  it('什么线索都没有时兜底成 image.png，不产出空名字', () => {
    expect(imageFileName('', 'blob:', '')).toBe('image.png');
  });
});
