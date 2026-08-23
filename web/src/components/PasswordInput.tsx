import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * 带「小眼睛」的密码输入框。
 *
 * 全站每一处密码/密钥输入都用这一个组件，不要在页面里各写一遍——仓库里已经因为
 * 同一件事重复实现吃过亏（issue #17 的三处上传校验）。
 *
 * 几条约束，改的时候别丢：
 * - 默认隐藏。切换只改 type，不动 value，输入中途切换不会丢字。
 * - 切换按钮必须 type="button"：登录页的输入框在 <form> 里，默认的 submit
 *   会让「看一眼密码」直接把表单提交出去。
 * - aria-label 跟着状态变（显示密码 / 隐藏密码），并用 aria-pressed 报当前是开是关。
 * - 按钮**不要**放进 <label> 里：它的 aria-label 含「密码」二字，落在 label 子树里会
 *   混进输入框的可访问名，e2e 的 getByLabel('密码') 会一下子匹配到两个元素。
 */
export type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

export function PasswordInput({ className = 'input', ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const label = visible ? '隐藏密码' : '显示密码';

  return (
    <span className="password-field">
      <input {...rest} className={className} type={visible ? 'text' : 'password'} />
      <button
        type="button"
        className="password-field__eye"
        aria-label={label}
        aria-pressed={visible}
        title={label}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </span>
  );
}
