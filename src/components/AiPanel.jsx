import { Copy, LoaderCircle, Reply, Sparkles, X } from 'lucide-react';

/** Shows what the assistant is doing and its answer. Nothing leaves this panel unless the reader uses it. */
export default function AiPanel({ t, job, onClose, onCancel, onUseReply, onToast }) {
  if (!job) return null;
  const copy = async () => {
    await window.emargy.copyText(job.text);
    onToast(t('copied'));
  };
  return (
    <section className="ai-panel" aria-live="polite" aria-label={t('aiAssistant')}>
      <header>
        <Sparkles size={16} />
        <strong>{job.title}</strong>
        {job.label && <small>{t('aiVia', { name: job.label })}</small>}
        <button className="icon-button quiet" onClick={job.running ? onCancel : onClose} title={job.running ? t('cancel') : t('close')} aria-label={job.running ? t('cancel') : t('close')}><X size={15} /></button>
      </header>
      {job.running && <p className="ai-running"><LoaderCircle className="spin" size={15} />{t('aiWorking')}</p>}
      {job.error && <p className="form-error">{job.error}</p>}
      {job.text && (
        // Each paragraph finds its own direction, so Arabic and English lines both read correctly.
        <div className="ai-result">{job.text.split(/\n\s*\n/).map((block, i) => <p key={i} dir="auto">{block}</p>)}</div>
      )}
      {job.text && (
        <footer>
          {job.task === 'reply' && <button className="button primary small" onClick={() => onUseReply(job.text)}><Reply size={14} />{t('aiUseReply')}</button>}
          <button className="button ghost small" onClick={copy}><Copy size={14} />{t('copy')}</button>
        </footer>
      )}
    </section>
  );
}
