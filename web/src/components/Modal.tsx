import type { ReactNode } from 'react';
import { useEffect } from 'react';

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  width?: number;
}

export function Modal({ onClose, children, width = 400 }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }}>{children}</div>
    </div>
  );
}
