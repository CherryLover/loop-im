/**
 * 发送端本地预览缓存的契约。
 *
 * 这张表是两边对接的地方：写入那一侧（上传成功后 rememberPreview）和读出那一侧
 * （md.ts 渲染时 localPreviewFor）互不认识，唯一的约定就是 key 怎么算、
 * 什么样的值才收。下面这几条钉的就是这个约定 —— 两边改任何一边，先看这里。
 */
import { describe, expect, it } from 'vitest';
import { localPreviewFor, rememberPreview } from './upload-cache';

describe('本地预览缓存', () => {
  it('没记过就是 null', () => {
    expect(localPreviewFor('/uploads/nothing.png')).toBeNull();
  });

  it('记过之后能换回本地 blob', () => {
    rememberPreview('/uploads/a.png', 'blob:http://localhost/aaa');
    expect(localPreviewFor('/uploads/a.png')).toBe('blob:http://localhost/aaa');
  });

  it('key 不看 ?token=：写入带、读出不带，照样命中', () => {
    // 正文里存的是裸路径，真正塞进 <img src> 的是 attachmentUrl() 拼过 token 的版本，
    // 而 token 会随登录态变。两种形态必须落在同一格，否则缓存等于没有。
    rememberPreview('/uploads/b.png?token=tok-1', 'blob:http://localhost/bbb');
    expect(localPreviewFor('/uploads/b.png')).toBe('blob:http://localhost/bbb');
    expect(localPreviewFor('/uploads/b.png?token=tok-2')).toBe('blob:http://localhost/bbb');
    expect(localPreviewFor('/uploads/b.png#frag')).toBe('blob:http://localhost/bbb');
  });

  it('只收 blob:，别的一律不收', () => {
    // 这张表的 key 来自用户手打的正文。值这一侧卡死在 blob: 上，
    // 就算将来有谁把不该进来的东西写进来，也换不出一个能执行的 URL。
    rememberPreview('/uploads/c.png', 'javascript:alert(1)');
    rememberPreview('/uploads/d.png', 'https://evil.example/x.png');
    rememberPreview('/uploads/e.png', 'data:text/html,<script>alert(1)</script>');
    expect(localPreviewFor('/uploads/c.png')).toBeNull();
    expect(localPreviewFor('/uploads/d.png')).toBeNull();
    expect(localPreviewFor('/uploads/e.png')).toBeNull();
  });

  it('空 key 不写，也不会把空字符串查出东西来', () => {
    rememberPreview('', 'blob:http://localhost/zzz');
    expect(localPreviewFor('')).toBeNull();
    expect(localPreviewFor('?token=x')).toBeNull();
  });

  it('同一个附件重记一次以后一个为准', () => {
    rememberPreview('/uploads/f.png', 'blob:http://localhost/old');
    rememberPreview('/uploads/f.png', 'blob:http://localhost/new');
    expect(localPreviewFor('/uploads/f.png')).toBe('blob:http://localhost/new');
  });
});
