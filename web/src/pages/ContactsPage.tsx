import { useMemo, useState } from 'react';
import { KeyRound, Search, UserMinus, UserPlus, Users } from 'lucide-react';
import { Avatar, AiBadge } from '../components/Avatar';
import { ResetPasswordModal } from '../modals/ResetPasswordModal';
import { DisableUserModal } from '../modals/DisableUserModal';
import type { User } from '../lib/types';

interface ContactsPageProps {
  me: User;
  users: User[];
  isAdmin: boolean;
  onChat: (userId: string) => void;
  onAddContact: () => void;
  onCreateGroup: () => void;
  /** 停用 / 恢复之后回调，让上层刷新名单并给一条提示。 */
  onUserChanged?: (message: string) => void;
}

export function ContactsPage({ me, users, isAdmin, onChat, onAddContact, onCreateGroup, onUserChanged }: ContactsPageProps) {
  const [query, setQuery] = useState('');
  // 忘了密码的成员只能靠管理员在这里重置，所以入口就放在名单里每个人身上。
  const [resetting, setResetting] = useState<User | null>(null);
  // 停用 / 恢复的入口同理。停用的人仍然留在这份名单里（停用不是删除），
  // 只是标成「已停用」——管理员要能看见他、也要能把他放回来。
  const [switching, setSwitching] = useState<User | null>(null);

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
                  {u.disabled ? <span className="tag-off">已停用</span> : null}
                </div>
                <div className="contact__email">{u.email}</div>
              </div>
              <div className="contact__right">
                <span className="contact__status">
                  {/* 停用的人恒为离线，也不再显示「在线 / 离线」这一档——他根本连不上来 */}
                  <span className={`dot ${!u.disabled && u.online ? 'dot--online' : 'dot--offline'}`} />
                  {u.disabled ? '已停用' : u.isAI ? '常驻在线' : u.online ? '在线' : '离线'}
                </span>
                {isAdmin && !u.isAI ? (
                  <>
                    <button
                      type="button"
                      className="contact__chat"
                      title={`重置 ${u.name} 的密码`}
                      onClick={() => setResetting(u)}
                    >
                      <KeyRound size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                      重置密码
                    </button>
                    <button
                      type="button"
                      className="contact__chat"
                      title={u.disabled ? `恢复 ${u.name} 的账号` : `停用 ${u.name} 的账号`}
                      onClick={() => setSwitching(u)}
                    >
                      {u.disabled
                        ? <UserPlus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                        : <UserMinus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />}
                      {u.disabled ? '恢复账号' : '停用账号'}
                    </button>
                  </>
                ) : null}
                <button type="button" className="contact__chat" onClick={() => onChat(u.id)}>去聊天</button>
              </div>
            </div>
          ))}
          {list.length === 0 ? <div className="convos__empty">没有匹配的成员。</div> : null}
        </div>
      </div>

      {resetting ? <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} /> : null}

      {switching ? (
        <DisableUserModal
          user={switching}
          onClose={() => setSwitching(null)}
          onDone={(message) => {
            setSwitching(null);
            onUserChanged?.(message);
          }}
        />
      ) : null}
    </div>
  );
}
