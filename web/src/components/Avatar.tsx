import { initialOf } from '../lib/md';

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
      {url ? <img src={url} alt={name} /> : (label ?? initialOf(name))}
      {dot ? <span className="avatar__dot" style={{ background: dot === 'online' ? 'var(--calm)' : 'var(--faint)' }} /> : null}
    </span>
  );
}

export const AiBadge = () => <span className="tag-ai">AI</span>;
