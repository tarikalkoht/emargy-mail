import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, children, onClose, width = '520px' }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" style={{ '--modal-width': width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header"><h2>{title}</h2><button className="icon-button quiet" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
        {children}
      </section>
    </div>
  );
}
