import type { Message } from './types';

/**
 * Adds a confirmed message to a thread: drops the optimistic copy it replaces,
 * ignores duplicates (the sender gets it over both HTTP and SSE) and keeps the
 * thread in send order, with anything still in flight at the bottom.
 */
export function mergeMessage(list: Message[], message: Message): Message[] {
  if (list.some((m) => m.id === message.id)) return list;
  const withoutOptimistic = list.filter((m) => !(m.pending && m.senderId === message.senderId && m.body === message.body));
  return [...withoutOptimistic, message].sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
    return a.createdAt - b.createdAt;
  });
}
