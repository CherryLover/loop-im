import { initialOf } from '../lib/md';
import { attachmentUrl } from '../lib/api';

interface AvatarProps {
  name: string;
  url?: string | null;
  size?: number;
  radius?: number;
  isAI?: boolean;
  /** Presence dot colour; omit to hide the dot. */
  dot?: 'online' | 'offline' | null;
  label?: string;
}

export function Avatar({ name, url, size = 32, radius = 10, isAI, dot, label }: AvatarProps) {
  const fontSize = size <= 22 ? 10 : size <= 28 ? 11 : size <= 36 ? 12.5 : 15;
  return (
    <span
      className={`avatar${isAI ? ' avatar--ai' : ''}`}
      style={{ width: size, height: size, borderRadius: radius, fontSize }}
    >
      {/* 头像也存在对象存储里，回源同样要凭据（头像是全员可见的，但仍然要求登录）。 */}
      {url ? <img src={attachmentUrl(url)} alt={name} /> : (label ?? initialOf(name))}
      {dot ? <span className="avatar__dot" style={{ background: dot === 'online' ? 'var(--calm)' : 'var(--faint)' }} /> : null}
    </span>
  );
}

export const AiBadge = () => <span className="tag-ai">AI</span>;
