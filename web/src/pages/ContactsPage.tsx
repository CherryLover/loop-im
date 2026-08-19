import { useMemo, useState } from 'react';
import { Search, UserPlus, Users } from 'lucide-react';
import { Avatar, AiBadge } from '../components/Avatar';
import type { User } from '../lib/types';

interface ContactsPageProps {
  me: User;
  users: User[];
  isAdmin: boolean;
  onChat: (userId: string) => void;
  onAddContact: () => void;
  onCreateGroup: () => void;
}

export function ContactsPage({ me, users, isAdmin, onChat, onAddContact, onCreateGroup }: ContactsPageProps) {
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => u.id !== me.id)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users, me.id, query]);

  return (
    <div className="page">
      <div className="contacts">
        <div>
          <div className="page__title">联系人</div>
          <div className="page__hint">
            {isAdmin
              ? '系统内全部成员。管理员可开通新成员，或选 2–3 人建群。'
              : '系统内全部成员，点击即可直接发起对话。'}
          </div>
        </div>

        <div className="contacts__bar">
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 11, color: 'var(--faint)' }} />
            <input
              className="input"
              style={{ paddingLeft: 31 }}
              placeholder="搜索姓名或邮箱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {isAdmin ? (
            <>
              <button type="button" className="btn" style={{ borderColor: 'var(--border2)', borderRadius: 10, padding: '9px 13px', fontSize: 13 }} onClick={onAddContact}>
                <UserPlus size={14} />
                添加联系人
              </button>
              <button type="button" className="btn" style={{ borderColor: 'var(--border2)', borderRadius: 10, padding: '9px 13px', fontSize: 13 }} onClick={onCreateGroup}>
                <Users size={14} />
                建群
              </button>
            </>
          ) : null}
        </div>

        <div className="list-card">
          {list.map((u) => (
            <div key={u.id} className="contact">
              <Avatar name={u.name} url={u.avatarUrl} isAI={u.isAI} size={36} radius={11} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="contact__name">{u.name}</span>
                  {u.isAI ? <AiBadge /> : null}
                </div>
                <div className="contact__email">{u.email}</div>
              </div>
              <div className="contact__right">
                <span className="contact__status">
                  <span className={`dot ${u.online ? 'dot--online' : 'dot--offline'}`} />
                  {u.isAI ? '常驻在线' : u.online ? '在线' : '离线'}
                </span>
                <button type="button" className="contact__chat" onClick={() => onChat(u.id)}>去聊天</button>
              </div>
            </div>
          ))}
          {list.length === 0 ? <div className="convos__empty">没有匹配的成员。</div> : null}
        </div>
      </div>
    </div>
  );
}
