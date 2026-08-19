export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      <span className="toast__dot" />
      <span className="toast__text">{text}</span>
    </div>
  );
}
