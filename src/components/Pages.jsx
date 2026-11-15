import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, FileText, Paperclip, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import { classNames, displayName, formatFullDate, formatListDate } from '../lib/format';

const api = window.emargy;

export function DraftsPage({ t, language, state, setState, onOpenDraft }) {
  const accounts = Object.fromEntries(state.accounts.map((a) => [a.id, a]));
  return (
    <div className="page">
      <header className="page-head"><h1>{t('drafts')}</h1><p>{t('draftsHint')}</p></header>
      <div className="page-list">
        {state.drafts.map((draft) => (
          <div key={draft.id} className="page-row">
            <button className="page-row-main" onClick={() => onOpenDraft(draft.id)}>
              <FileText size={17} className="muted-icon" />
              <span className="page-row-text">
                <strong dir="auto">{draft.subject || t('noSubject')}</strong>
                <small dir="auto">{draft.to ? `${t('toLabel')} ${displayName(draft.to)}` : t('noRecipients')} · {accounts[draft.accountId]?.email}</small>
              </span>
              {draft.attachmentCount > 0 && <Paperclip size={14} className="muted-icon" />}
              <time>{formatListDate(draft.updatedAt, language)}</time>
            </button>
            <button className="icon-button quiet" onClick={async () => setState(await api.deleteDraft(draft.id))} title={t('delete')} aria-label={t('delete')}><Trash2 size={15} /></button>
          </div>
        ))}
        {!state.drafts.length && <div className="page-empty"><FileText size={30} strokeWidth={1.4} /><h3>{t('noDrafts')}</h3></div>}
      </div>
    </div>
  );
}

export function OutboxPage({ t, language, state, setState, onToast }) {
  const accounts = Object.fromEntries(state.accounts.map((a) => [a.id, a]));
  const label = { queued: t('statusQueued'), sending: t('statusSending'), sent: t('statusSent'), failed: t('statusFailed') };
  const act = (fn) => fn().then(setState).catch((e) => onToast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'));
  return (
    <div className="page">
      <header className="page-head"><h1>{t('outbox')}</h1><p>{t('outboxHint')}</p></header>
      <div className="page-list">
        {state.outbox.map((item) => (
          <div key={item.id} className={classNames('page-row', `out-${item.status}`)}>
            <div className="page-row-main static">
              {item.status === 'sent' ? <Check size={17} className="ok-icon" /> : item.status === 'failed' ? <AlertTriangle size={17} className="warn-icon" /> : <Clock size={17} className="muted-icon" />}
              <span className="page-row-text">
                <strong dir="auto">{item.subject || t('noSubject')}</strong>
                <small dir="auto">
                  {label[item.status]} · {t('toLabel')} {displayName(item.to)} · {accounts[item.accountId]?.email}
                  {item.status === 'queued' && item.attempts > 0 && ` · ${t('nextAttempt')} ${formatListDate(item.nextAttemptAt, language)}`}
                </small>
                {item.lastError && item.status !== 'sent' && <small className="error-text">{item.lastError}</small>}
              </span>
              <time>{formatListDate(item.sentAt || item.createdAt, language)}</time>
            </div>
            {item.status === 'failed' && <button className="button ghost small" onClick={() => act(() => api.retryOutbox(item.id))}><RotateCcw size={14} />{t('retry')}</button>}
            {item.status !== 'sending' && <button className="icon-button quiet" onClick={() => act(() => api.removeOutbox(item.id))} title={t('remove')} aria-label={t('remove')}><X size={15} /></button>}
          </div>
        ))}
        {!state.outbox.length && <div className="page-empty"><Clock size={30} strokeWidth={1.4} /><h3>{t('outboxEmpty')}</h3></div>}
      </div>
    </div>
  );
}

const ACTION_KEYS = {
  'message.approved_by_user': 'act_send_requested', 'message.sent': 'act_sent', 'message.send_failed': 'act_send_failed',
  'message.send_retry_scheduled': 'act_retry', 'message.send_undone': 'act_undone', 'message.deleted': 'act_deleted', 'message.archived': 'act_archived',
  'account.created': 'act_account_added', 'account.deleted': 'act_account_deleted', 'account.updated': 'act_account_updated',
  'project.created': 'act_project_added', 'project.deleted': 'act_project_deleted', 'images.sender_trusted': 'act_images_trusted',
  'attachment.saved': 'act_attachment_saved', 'storage.migrated_from_prototype': 'act_migrated', 'outbox.removed': 'act_outbox_removed',
};

export function ActivityPage({ t, language, state }) {
  const [entries, setEntries] = useState([]);
  useEffect(() => { api.listAudit().then(setEntries).catch(() => {}); }, [state]);
  const describe = (entry) => {
    const d = entry.details || {};
    return [d.subject, d.to, d.email, d.name, d.sender, d.filename, d.count && t('countItems', { n: d.count }), d.error].filter(Boolean).join(' — ');
  };
  return (
    <div className="page">
      <header className="page-head"><h1>{t('activity')}</h1><p>{t('activityHint')}</p></header>
      <div className="page-list">
        {entries.map((entry) => (
          <div key={entry.id} className="page-row">
            <div className="page-row-main static">
              <ShieldCheck size={16} className="muted-icon" />
              <span className="page-row-text"><strong>{t(ACTION_KEYS[entry.action], null, entry.action)}</strong><small dir="auto">{describe(entry)}</small></span>
              <time title={formatFullDate(entry.at, language)}>{formatListDate(entry.at, language)}</time>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
