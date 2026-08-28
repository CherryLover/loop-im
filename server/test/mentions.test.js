// @ 解析：名字互为前缀、正文里出现邮箱时不能误标提及。
// 误标不只是通知错人 —— parseMentions 的结果决定「@我」未读（将来还有 AI 用户的触发），
// 一次误匹配等于打扰错人。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentions } from '../src/mentions.js';

const sortIds = (ids) => [...ids].sort();

const roster = [
  { id: 'u_li', name: '李' },
  { id: 'u_liming', name: '李明' },
  { id: 'u_zhou', name: 'zhou' },
  { id: 'u_ann', name: 'Ann' },
  { id: 'u_anna', name: 'Anna' },
  { id: 'u_liming_en', name: 'Li Ming' },
];

describe('@ 解析 · 前缀名', () => {
  it('@李明 只标记李明，不连带标记李', () => {
    assert.deepEqual(parseMentions('@李明 你好', roster), ['u_liming']);
    assert.deepEqual(parseMentions('@李明的接口好了吗', roster), ['u_liming']);
  });

  it('@李 只标记李', () => {
    assert.deepEqual(parseMentions('@李 你好', roster), ['u_li']);
  });

  it('同一条消息里两个前缀名各归各的', () => {
    assert.deepEqual(sortIds(parseMentions('@李 @李明 同步一下', roster)), ['u_li', 'u_liming']);
  });

  it('英文名互为前缀时最长命中，右边是字母数字时不截断命中', () => {
    assert.deepEqual(parseMentions('@Anna 看下这个', roster), ['u_anna']);
    assert.deepEqual(parseMentions('@Ann 看下这个', roster), ['u_ann']);
    assert.deepEqual(parseMentions('@Annabelle 在吗', roster), []);
    assert.deepEqual(sortIds(parseMentions('@Ann @Anna 一起看', roster)), ['u_ann', 'u_anna']);
  });

  it('带连字符的名字整体命中（hapi Agent 用户的命名约定）', () => {
    const withAgent = [...roster, { id: 'ai-claude', name: 'Claude-Code', role: 'ai' }];
    assert.deepEqual(parseMentions('@Claude-Code 帮我看看 CI', withAgent), ['ai-claude']);
    assert.deepEqual(parseMentions('@claude-code 大小写不敏感', withAgent), ['ai-claude']);
    assert.deepEqual(parseMentions('@Claude-Coder 不是它', withAgent), []);
  });
});

describe('@ 解析 · 邮箱不是提及', () => {
  it('正文里的邮箱地址不会误标成提及', () => {
    assert.deepEqual(parseMentions('发到 zhou@example.com 那边', roster), []);
    assert.deepEqual(parseMentions('li.ming+work@example.com 抄送我', roster), []);
  });

  it('邮箱和真提及可以同时出现，只认真提及', () => {
    assert.deepEqual(parseMentions('@李明 发到 zhou@example.com 那边', roster), ['u_liming']);
  });
});

describe('@ 解析 · 带空格的名字', () => {
  it('原样写和去掉空格写都能命中', () => {
    assert.deepEqual(parseMentions('@Li Ming 看下这个', roster), ['u_liming_en']);
    assert.deepEqual(parseMentions('@LiMing 看下这个', roster), ['u_liming_en']);
  });
});

describe('@ 解析 · 全员', () => {
  it('四种写法都还在', () => {
    for (const body of ['@全员 站会推迟', '@所有人 注意', '@everyone heads up', '@all heads up']) {
      assert.deepEqual(parseMentions(body, roster), ['all'], body);
    }
  });

  it('@allow 这种只是以 all 开头的词不算 @全员', () => {
    assert.deepEqual(parseMentions('走 @allowlist 那条路', roster), []);
  });
});

describe('@ 解析 · 大小写与空结果', () => {
  it('大小写不敏感', () => {
    assert.deepEqual(parseMentions('@ANNA 看一下', roster), ['u_anna']);
    assert.deepEqual(parseMentions('@ALL 注意', roster), ['all']);
    assert.deepEqual(parseMentions('@EVERYONE 注意', roster), ['all']);
  });

  it('没有 @ 或者 @ 的是陌生名字时返回空', () => {
    assert.deepEqual(parseMentions('周五能发版吗？', roster), []);
    assert.deepEqual(parseMentions('@王五 在吗', roster), []);
    assert.deepEqual(parseMentions('', roster), []);
  });
});
