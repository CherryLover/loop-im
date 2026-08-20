import '@testing-library/jest-dom/vitest';

// jsdom 不实现滚动相关的 API，而消息列表挂载/收到新消息时就会用到。
// 放在全局 setup 里，省得每个渲染 MessageList 的用例各打一次桩。
Element.prototype.scrollIntoView = () => {};
