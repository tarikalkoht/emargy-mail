import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowRight, AtSign, Check, Clock, Download, FileText, Flag, FolderKanban, Forward, ImageOff,
  Inbox, Languages, LoaderCircle, Lock, Mail, MailOpen, Paperclip, PenLine, Plus, RefreshCw, Reply, ReplyAll,
  RotateCcw, Search, Send, Settings, ShieldCheck, Star, Trash2, X,
} from 'lucide-react';
import { translator } from './i18n';
import { prepareEmailHtml } from './emailHtml';

const EMPTY_STATE = { language: 'en', projects: [], accounts: [], counts: { total: 0, projects: {}, accounts: {} }, drafts: [], outbox: [] };
const PAGE_SIZE = 200;

const providerPresets = {
  custom: { imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false },
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true },
};

const api = window.emargy;

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

function formatDate(value, language, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  const locale = language === 'ar' ? 'ar-AE' : 'en-US';
  if (withTime) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

function emailDisplay(value = '') {
  return value.replace(/<([^>]+)>/, '').replace(/"/g, '').trim() || value;
}

function splitAddresses(value = '') {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((item) => item.trim()).filter(Boolean);
}

function quote(text = '') {
  return text.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function Modal({ title, children, onClose, width = '560px' }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" style={{ '--modal-width': width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>
        {children}
      </section>
    </div>
  );
}

function ProjectModal({ t, onClose, onSave }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2d8cff');
  return (
    <Modal title={t('addProject')} onClose={onClose}>
      <form className="modal-body form-grid" onSubmit={(event) => { event.preventDefault(); onSave({ name, color }); }}>
        <label className="field full"><span>{t('projectName')}</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
        <div className="field full"><span>{t('color')}</span><div className="color-row">{['#2d8cff', '#7c5cff', '#ff6b4a', '#15b886', '#f5a524', '#de4c8a'].map((item) => <button type="button" key={item} className={classNames('color-choice', color === item && 'selected')} style={{ background: item }} onClick={() => setColor(item)} aria-label={item}>{color === item && <Check size={16} />}</button>)}</div></div>
        <div className="modal-actions full"><button type="button" className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={!name.trim()}>{t('createProject')}</button></div>
      </form>
    </Modal>
  );
}

function AccountModal({ t, projects, defaultProjectId, onClose, onSave }) {
  const [form, setForm] = useState({ projectId: defaultProjectId || projects[0]?.id || '', provider: 'custom', displayName: '', email: '', username: '', password: '', ...providerPresets.custom });
  const [busy, setBusy] = useState(false);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const chooseProvider = (provider) => setForm((current) => ({ ...current, provider, ...providerPresets[provider] }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try { await onSave(form); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('addAccount')} onClose={onClose} width="720px">
      <form className="modal-body form-grid two-columns" onSubmit={submit}>
        <label className="field"><span>{t('project')}</span><select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} required>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span>{t('provider')}</span><select value={form.provider} onChange={(e) => chooseProvider(e.target.value)}>{['custom', 'gmail', 'outlook', 'zoho'].map((p) => <option key={p} value={p}>{t(p)}</option>)}</select></label>
        <label className="field"><span>{t('accountName')}</span><input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
        <label className="field"><span>{t('email')}</span><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required /></label>
        <label className="field"><span>{t('password')}</span><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => set('password', e.target.value)} required /></label>
        <label className="field"><span>{t('username')}</span><input value={form.username} onChange={(e) => set('username', e.target.value)} /></label>
        <small className="field-help full">{t('passwordHelp')}</small>
        <label className="field"><span>{t('imapHost')}</span><input value={form.imapHost} onChange={(e) => set('imapHost', e.target.value)} required /></label>
        <label className="field"><span>{t('imapPort')}</span><input type="number" value={form.imapPort} onChange={(e) => set('imapPort', e.target.value)} required /></label>
        <label className="field"><span>{t('smtpHost')}</span><input value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} required /></label>
        <label className="field"><span>{t('smtpPort')}</span><input type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} required /></label>
        <label className="checkbox-field"><input type="checkbox" checked={form.imapSecure} onChange={(e) => set('imapSecure', e.target.checked)} /> IMAP {t('secureConnection')}</label>
        <label className="checkbox-field"><input type="checkbox" checked={form.smtpSecure} onChange={(e) => set('smtpSecure', e.target.checked)} /> SMTP {t('secureConnection')}</label>
        <div className="notice full"><ShieldCheck size={18} /><span>{t('realMailNotice')}</span></div>
        <div className="modal-actions full"><button type="button" className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={16} />{t('testingConnection')}</> : t('saveAccount')}</button></div>
      </form>
    </Modal>
  );
}

function ComposeModal({ t, accounts, initial, onClose, onSave, onRequestSend }) {
  const [draft, setDraft] = useState({
    id: initial?.id, accountId: initial?.accountId || accounts[0]?.id || '', to: initial?.to || '', cc: initial?.cc || '', bcc: initial?.bcc || '',
    subject: initial?.subject || '', body: initial?.body || '', inReplyTo: initial?.inReplyTo || '', references: initial?.references || '', attachments: initial?.attachments || [],
  });
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const addFiles = async () => {
    const files = await api.pickFiles();
    if (files.length) setDraft((current) => ({ ...current, attachments: [...current.attachments, ...files] }));
  };
  return (
    <Modal title={initial?.id ? t('draft') : t('newMessage')} onClose={onClose} width="820px">
      <div className="compose-form">
        <div className="compose-row"><span>{t('from')}</span><select value={draft.accountId} onChange={(e) => set('accountId', e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName || account.email} · {account.email}</option>)}</select></div>
        <div className="compose-row"><span>{t('to')}</span><input value={draft.to} onChange={(e) => set('to', e.target.value)} autoFocus={!draft.to} /></div>
        <div className="compose-row compact"><span>{t('cc')}</span><input value={draft.cc} onChange={(e) => set('cc', e.target.value)} /><span>{t('bcc')}</span><input value={draft.bcc} onChange={(e) => set('bcc', e.target.value)} /></div>
        <div className="compose-row"><span>{t('subject')}</span><input value={draft.subject} onChange={(e) => set('subject', e.target.value)} /></div>
        <textarea className="compose-body" dir="auto" value={draft.body} onChange={(e) => set('body', e.target.value)} placeholder={t('body')} autoFocus={Boolean(draft.to)} />
        {!!draft.attachments.length && <div className="compose-attachments">{draft.attachments.map((file, index) => <span key={`${file.filename}-${index}`}><Paperclip size={13} />{file.filename}<small>{Math.ceil(file.size / 1024)} KB</small><button onClick={() => set('attachments', draft.attachments.filter((_, i) => i !== index))} aria-label={t('remove')}><X size={13} /></button></span>)}</div>}
        <div className="compose-footer">
          <div className="ai-policy"><ShieldCheck size={17} />{t('neverSendAutomatically')}</div>
          <div className="button-row">
            <button className="button ghost" onClick={addFiles}><Paperclip size={16} />{t('attachFiles')}</button>
            <button className="button ghost" onClick={() => onSave(draft)}><FileText size={17} />{t('saveDraft')}</button>
            <button className="button primary" disabled={!draft.accountId || !draft.to.trim()} onClick={() => onRequestSend(draft)}><Send size={17} />{t('send')}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ApprovalModal({ t, draft, account, onClose, onApprove, busy }) {
  return (
    <Modal title={t('approveTitle')} onClose={onClose} width="640px">
      <div className="modal-body approval">
        <div className="approval-icon"><ShieldCheck size={28} /></div>
        <p>{t('approveText')}</p>
        <dl>
          <div><dt>{t('from')}</dt><dd>{account?.email}</dd></div>
          <div><dt>{t('to')}</dt><dd>{draft.to}</dd></div>
          {draft.cc && <div><dt>{t('cc')}</dt><dd>{draft.cc}</dd></div>}
          {draft.bcc && <div><dt>{t('bcc')}</dt><dd>{draft.bcc}</dd></div>}
          <div><dt>{t('subject')}</dt><dd>{draft.subject || '—'}</dd></div>
          {!!draft.attachments?.length && <div><dt>{t('attachments')}</dt><dd>{draft.attachments.map((f) => f.filename).join(', ')}</dd></div>}
        </dl>
        <div className="approval-preview" dir="auto">{draft.body || '—'}</div>
        <div className="modal-actions"><button className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary" onClick={onApprove} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}{t('approveSend')}</button></div>
      </div>
    </Modal>
  );
}

function MessageRow({ message, account, project, active, language, onClick }) {
  return (
    <button className={classNames('message-row', active && 'active', !message.read && 'unread')} onClick={onClick}>
      <div className="avatar" style={{ '--avatar-color': project?.color || '#2d8cff' }}>{emailDisplay(message.folderRole === 'sent' ? message.to : message.from).slice(0, 1).toUpperCase() || <Mail size={15} />}</div>
      <div className="message-row-content">
        <div className="message-line"><strong dir="auto">{emailDisplay(message.folderRole === 'sent' ? message.to : message.from)}</strong><time>{formatDate(message.date, language)}</time></div>
        <div className="message-subject" dir="auto">{message.important && <Star size={13} fill="currentColor" />}{message.flagged && <Flag size={12} />}{message.hasAttachments && <Paperclip size={12} />}{message.subject}</div>
        <div className="message-preview" dir="auto">{message.preview || ' '}</div>
        <div className="message-tags"><span style={{ '--tag-color': project?.color }}>{project?.name}</span><span><AtSign size={11} />{account?.email}</span></div>
      </div>
    </button>
  );
}

function MessageReader({ message, loading, account, project, language, t, onReply, onDelete, onMarkUnread, onDownload, onTrustSender }) {
  const [showImagesOnce, setShowImagesOnce] = useState(false);
  useEffect(() => setShowImagesOnce(false), [message?.id]);
  const content = message?.content;
  const allowRemote = Boolean(message?.imagesTrusted || showImagesOnce);
  const prepared = useMemo(() => (content?.html ? prepareEmailHtml(content.html, { allowRemote, inlineImages: content.inlineImages }) : null), [content, allowRemote]);

  if (loading) return <div className="reader-placeholder"><LoaderCircle className="spin" size={28} /></div>;
  if (!message || !content) return <div className="reader-placeholder"><div className="placeholder-orb"><Mail size={36} /></div><h2>{t('selectMessage')}</h2><p>{t('selectMessageHint')}</p></div>;
  return (
    <article className="reader">
      <header className="reader-header">
        <div className="reader-top">
          <div className="reader-tags"><span style={{ '--tag-color': project?.color }}>{project?.name}</span><span><AtSign size={13} />{account?.email}</span>{message.important && <span className="important-tag"><Star size={13} fill="currentColor" />{t('important')}</span>}</div>
          <div className="reader-actions">
            <button className="icon-button" title={t('reply')} onClick={() => onReply('reply')}><Reply size={16} /></button>
            <button className="icon-button" title={t('replyAll')} onClick={() => onReply('replyAll')}><ReplyAll size={16} /></button>
            <button className="icon-button" title={t('forward')} onClick={() => onReply('forward')}><Forward size={16} /></button>
            <button className="icon-button" title={t('markUnread')} onClick={onMarkUnread}><MailOpen size={16} /></button>
            <button className="icon-button danger" title={t('delete')} onClick={onDelete}><Trash2 size={16} /></button>
          </div>
        </div>
        <h1 dir="auto">{content.subject}</h1>
        <div className="sender-block"><div className="avatar large" style={{ '--avatar-color': project?.color }}>{emailDisplay(content.from).slice(0, 1).toUpperCase()}</div><div><strong dir="auto">{content.from}</strong><span dir="auto">{t('to')}: {content.to}{content.cc ? ` · ${t('cc')}: ${content.cc}` : ''}</span></div><time>{formatDate(content.date, language, true)}</time></div>
      </header>
      {prepared?.blockedCount > 0 && !allowRemote && (
        <div className="privacy-banner"><ImageOff size={17} /><span>{t('imagesBlocked', { n: prepared.blockedCount })}</span><button onClick={() => setShowImagesOnce(true)}>{t('showImages')}</button><button onClick={() => onTrustSender(content.fromAddress)}>{t('alwaysShowImages')}</button></div>
      )}
      <section className="message-content">{prepared ? <iframe title={content.subject} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={prepared.srcDoc} /> : <pre dir="auto">{content.text}</pre>}</section>
      {!!content.attachments?.length && <section className="attachments"><h3><Paperclip size={17} />{t('attachments')}</h3><div className="attachment-grid">{content.attachments.map((attachment) => <button key={attachment.index} onClick={() => onDownload(attachment)}><FileText size={22} /><span><strong>{attachment.filename}</strong><small>{Math.ceil(attachment.size / 1024)} KB</small></span><Download size={17} /></button>)}</div></section>}
    </article>
  );
}

function statusLabel(t, status) {
  return { syncing: t('syncing'), connecting: t('connecting'), offline: t('offline'), error: t('error'), idle: t('connected') }[status] || status;
}

export default function App() {
  const [state, setState] = useState(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [selectedProject, setSelectedProject] = useState('all');
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [view, setView] = useState('inbox');
  const [list, setList] = useState({ messages: [], total: 0 });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selectedId, setSelectedId] = useState(null);
  const [openMessage, setOpenMessage] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(null);
  const [composeDraft, setComposeDraft] = useState(null);
  const [approvalDraft, setApprovalDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [audit, setAudit] = useState([]);
  const language = state.language || 'en';
  const t = useMemo(() => translator(language), [language]);
  const toastTimer = useRef(null);

  const showToast = useCallback((message, kind = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const run = useCallback(async (operation, successMessage) => {
    try {
      const result = await operation();
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      showToast(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      throw error;
    }
  }, [showToast]);

  const folderRole = view === 'sent' ? 'sent' : 'inbox';
  const refreshList = useCallback(async () => {
    if (view !== 'inbox' && view !== 'sent') return;
    const result = await api.listMessages({ projectId: selectedProject, accountId: selectedAccount, folderRole, filter, query, limit });
    setList(result);
  }, [view, selectedProject, selectedAccount, folderRole, filter, query, limit]);
  const refreshState = useCallback(async () => setState(await api.getState()), []);

  useEffect(() => {
    api.getState().then((next) => { setState(next); setReady(true); }).catch((error) => { showToast(error.message, 'error'); setReady(true); });
  }, [showToast]);
  useEffect(() => { refreshList().catch(() => {}); }, [refreshList]);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setLimit(PAGE_SIZE); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const offStatus = api.onSyncStatus(({ accountId, status, error }) => setState((current) => ({ ...current, accounts: current.accounts.map((a) => (a.id === accountId ? { ...a, sync: { status, error } } : a)) })));
    const offMail = api.onMailChanged(() => { refreshList().catch(() => {}); refreshState().catch(() => {}); });
    const offOutbox = api.onOutboxChanged(() => refreshState().catch(() => {}));
    return () => { offStatus(); offMail(); offOutbox(); };
  }, [refreshList, refreshState]);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }, [language]);
  useEffect(() => { if (view === 'audit') api.listAudit().then(setAudit).catch(() => {}); }, [view, state]);

  const projectsById = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.id, p])), [state.projects]);
  const accountsById = useMemo(() => Object.fromEntries(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const visibleAccounts = state.accounts.filter((account) => selectedProject === 'all' || account.projectId === selectedProject);
  const pendingOutbox = state.outbox.filter((item) => item.status !== 'sent').length;

  const selectMessage = async (message) => {
    setSelectedId(message.id);
    setLoadingMessage(true);
    setOpenMessage(null);
    try {
      const result = await run(() => api.openMessage(message.id));
      setOpenMessage(result);
      setList((current) => ({ ...current, messages: current.messages.map((m) => (m.id === message.id ? { ...m, read: true, preview: result.content.preview } : m)) }));
      refreshState().catch(() => {});
    } finally {
      setLoadingMessage(false);
    }
  };

  const compose = (initial = null) => {
    if (!state.accounts.length) return showToast(t('accountRequired'), 'error');
    setComposeDraft(initial);
    setModal('compose');
  };

  const replyTo = (mode) => {
    const content = openMessage.content;
    const account = accountsById[openMessage.accountId];
    const mine = (address) => account && address.toLowerCase().includes(account.email.toLowerCase());
    const header = t('onWrote', { date: formatDate(content.date, language, true), from: content.from });
    if (mode === 'forward') {
      return compose({
        accountId: openMessage.accountId,
        subject: /^fwd?:/i.test(content.subject) ? content.subject : `Fwd: ${content.subject}`,
        body: `\n\n${t('forwardedHeader')}\n${t('from')}: ${content.from}\n${t('subject')}: ${content.subject}\n${t('to')}: ${content.to}\n\n${content.text}`,
      });
    }
    const to = mode === 'replyAll' ? [content.replyTo || content.from, ...splitAddresses(content.to)].filter((a) => !mine(a)) : [content.replyTo || content.from];
    const cc = mode === 'replyAll' ? splitAddresses(content.cc).filter((a) => !mine(a)) : [];
    return compose({
      accountId: openMessage.accountId,
      to: [...new Set(to)].join(', '),
      cc: cc.join(', '),
      subject: /^re:/i.test(content.subject) ? content.subject : `Re: ${content.subject}`,
      body: `\n\n${header}\n${quote(content.text)}`,
      inReplyTo: content.messageId,
      references: [content.references, content.messageId].filter(Boolean).join(' '),
    });
  };

  const saveDraft = async (draft) => {
    const result = await run(() => api.saveDraft(draft), t('saved'));
    setState(result.state);
    setModal(null);
    setComposeDraft(null);
  };

  const approveSend = async () => {
    setBusy(true);
    try {
      const result = await run(() => api.approveAndSend(approvalDraft));
      setState(result.state);
      const item = result.state.outbox.find((entry) => entry.id === result.outboxId);
      showToast(item?.status === 'sent' ? t('sentOk') : t('queued'), item?.status === 'sent' ? 'success' : 'warning');
      setApprovalDraft(null);
      setComposeDraft(null);
      setModal(null);
    } finally {
      setBusy(false);
    }
  };

  const deleteOpen = async () => {
    if (!window.confirm(t('deleteConfirm'))) return;
    await run(() => api.deleteMessage(openMessage.id));
    setOpenMessage(null);
    setSelectedId(null);
    refreshList();
    refreshState();
  };

  const syncAll = () => run(() => api.syncAll()).then(setState).catch(() => {});

  if (!ready) return <div className="splash"><div className="brand-mark"><Mail size={32} /></div><h1>Emargy Mail</h1><LoaderCircle className="spin" /></div>;

  const navItems = [
    { key: 'inbox', icon: Inbox, label: t('inbox'), badge: state.counts.total },
    { key: 'sent', icon: Send, label: t('sent') },
    { key: 'drafts', icon: FileText, label: t('drafts'), badge: state.drafts.length },
    { key: 'outbox', icon: Clock, label: t('outbox'), badge: pendingOutbox },
    { key: 'audit', icon: Activity, label: t('audit') },
    { key: 'settings', icon: Settings, label: t('settings') },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Mail size={21} /></div><strong>{t('appName')}</strong><span className="version"><Lock size={9} /> local</span></div>
        <div className="global-search"><Search size={18} /><input value={search} onChange={(e) => { setSearch(e.target.value); if (view !== 'inbox' && view !== 'sent') setView('inbox'); }} placeholder={t('search')} dir="auto" /></div>
        <div className="top-actions">
          <button className="language-button" onClick={async () => setState(await api.setLanguage(language === 'ar' ? 'en' : 'ar'))}><Languages size={17} />{language === 'ar' ? 'English' : 'العربية'}</button>
          <button className="button primary compose-top" onClick={() => compose()}><PenLine size={17} />{t('newMessage')}</button>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="main-nav">{navItems.map(({ key, icon: Icon, label, badge }) => <button key={key} className={classNames(view === key && 'active')} onClick={() => { setView(key); setOpenMessage(null); setSelectedId(null); }}><Icon size={18} /><span>{label}</span>{badge ? <b>{badge}</b> : <i />}</button>)}</nav>
        <div className="sidebar-section">
          <div className="section-title"><span>{t('projects')}</span><button onClick={() => setModal('project')} title={t('addProject')}><Plus size={16} /></button></div>
          <button className={classNames('project-item', selectedProject === 'all' && 'active')} onClick={() => { setSelectedProject('all'); setSelectedAccount('all'); }}><span className="project-dot all"><FolderKanban size={13} /></span><span>{t('allProjects')}</span></button>
          {state.projects.map((project) => <button key={project.id} className={classNames('project-item', selectedProject === project.id && 'active')} onClick={() => { setSelectedProject(project.id); setSelectedAccount('all'); }}><span className="project-dot" style={{ background: project.color }} /><span>{project.name}</span><b>{state.counts.projects[project.id] || ''}</b></button>)}
        </div>
        <div className="sidebar-section accounts-section">
          <div className="section-title"><span>{t('accounts')}</span><button onClick={() => (state.projects.length ? setModal('account') : setModal('project'))} title={t('addAccount')}><Plus size={16} /></button></div>
          <button className={classNames('account-item', selectedAccount === 'all' && 'active')} onClick={() => setSelectedAccount('all')}><span className="account-icon"><Inbox size={14} /></span><span>{t('all')}</span></button>
          {visibleAccounts.map((account) => {
            const status = account.sync?.status || 'idle';
            return (
              <div className={classNames('account-item-wrap', selectedAccount === account.id && 'active')} key={account.id}>
                <button className="account-item" onClick={() => setSelectedAccount(account.id)} title={account.sync?.error || statusLabel(t, status)}>
                  <span className={classNames('account-icon', `status-${status}`)}><AtSign size={14} /></span>
                  <span><strong>{account.displayName || account.email.split('@')[0]}</strong><small>{account.email}</small></span>
                  {(status === 'error' || status === 'offline') && <AlertCircle className="account-error" size={14} />}
                  {!!state.counts.accounts[account.id] && <b className="account-count">{state.counts.accounts[account.id]}</b>}
                </button>
                <button className="account-sync" onClick={() => run(() => api.syncAccount(account.id)).then(setState).catch(() => {})} title={t('sync')} disabled={status === 'syncing' || status === 'connecting'}>{status === 'syncing' || status === 'connecting' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
              </div>
            );
          })}
        </div>
        <div className="sidebar-footer"><ShieldCheck size={15} /><span>{t('dataLocation')}</span></div>
      </aside>

      <main className="workspace">
        {(view === 'inbox' || view === 'sent') && <>
          <section className="message-list">
            <header className="list-header"><div><h2>{selectedProject === 'all' ? (view === 'sent' ? t('sent') : t('inbox')) : projectsById[selectedProject]?.name}</h2><span>{t('messagesCount', { n: list.total })}</span></div><button className="icon-button" onClick={syncAll} title={t('syncAll')} disabled={!state.accounts.length}><RefreshCw size={17} /></button></header>
            <div className="filter-bar">{[['all', t('all')], ['unread', t('unread')], ['important', t('important')], ['flagged', t('flagged')]].map(([key, label]) => <button key={key} className={classNames(filter === key && 'active')} onClick={() => { setFilter(key); setLimit(PAGE_SIZE); }}>{label}</button>)}</div>
            <div className="messages-scroll">
              {list.messages.map((message) => <MessageRow key={message.id} message={message} account={accountsById[message.accountId]} project={projectsById[message.projectId]} active={message.id === selectedId} language={language} onClick={() => selectMessage(message)} />)}
              {list.total > list.messages.length && <button className="load-more" onClick={() => setLimit((value) => value + PAGE_SIZE)}>{t('loadMore')}</button>}
              {!list.messages.length && <div className="empty-list"><Inbox size={30} /><h3>{t('noMessages')}</h3><p>{t('noMessagesHint')}</p>{!state.accounts.length && <button className="button primary" onClick={() => (state.projects.length ? setModal('account') : setModal('project'))}><Plus size={16} />{state.projects.length ? t('addAccount') : t('addProject')}</button>}</div>}
            </div>
          </section>
          <section className="reader-pane">
            <MessageReader
              message={openMessage}
              loading={loadingMessage}
              account={openMessage && accountsById[openMessage.accountId]}
              project={openMessage && projectsById[openMessage.projectId]}
              language={language}
              t={t}
              onReply={replyTo}
              onDelete={deleteOpen}
              onMarkUnread={async () => { await run(() => api.markRead(openMessage.id, false)); setOpenMessage(null); setSelectedId(null); refreshList(); refreshState(); }}
              onDownload={(attachment) => run(() => api.saveAttachment({ messageId: openMessage.id, index: attachment.index })).catch(() => {})}
              onTrustSender={async (address) => { await run(() => api.trustImages(address)); setOpenMessage((current) => ({ ...current, imagesTrusted: true })); }}
            />
          </section>
        </>}

        {view === 'drafts' && <section className="single-view">
          <header className="single-header"><div><h1>{t('drafts')}</h1><p>{t('neverSendAutomatically')}</p></div><button className="button primary" onClick={() => compose()}><PenLine size={17} />{t('newMessage')}</button></header>
          <div className="draft-grid">
            {state.drafts.map((draft) => <div key={draft.id} className="draft-card"><div className="draft-icon"><FileText size={20} /></div><button className="draft-open" onClick={async () => compose(await api.getDraft(draft.id))}><span>{t('draft')}</span><h3 dir="auto">{draft.subject || `(${t('subject')})`}</h3><p>{draft.to || t('to')}{draft.attachmentCount ? ` · ${draft.attachmentCount} 📎` : ''}</p><small>{formatDate(draft.updatedAt, language, true)}</small></button><button className="icon-button danger" title={t('delete')} onClick={async () => setState(await api.deleteDraft(draft.id))}><Trash2 size={15} /></button></div>)}
            {!state.drafts.length && <div className="empty-large"><FileText size={42} /><h2>{t('emptyDrafts')}</h2></div>}
          </div>
        </section>}

        {view === 'outbox' && <section className="single-view">
          <header className="single-header"><div><h1>{t('outbox')}</h1><p>{t('neverSendAutomatically')}</p></div></header>
          <div className="audit-list">
            {state.outbox.map((item) => <div key={item.id} className={classNames('audit-row', `outbox-${item.status}`)}>
              <div className="audit-icon">{item.status === 'sent' ? <Check size={17} /> : item.status === 'failed' ? <AlertCircle size={17} /> : <Clock size={17} />}</div>
              <div><strong dir="auto">{item.subject || '—'} · {item.to}</strong><span>{t({ queued: 'statusQueued', sending: 'statusSending', sent: 'statusSent', failed: 'statusFailed' }[item.status])} · {accountsById[item.accountId]?.email}{item.status === 'queued' && item.attempts ? ` · ${t('nextAttempt')}: ${formatDate(item.nextAttemptAt, language, true)}` : ''}{item.attempts ? ` · ${t('attempts')}: ${item.attempts}` : ''}{item.lastError && item.status !== 'sent' ? ` · ${item.lastError}` : ''}</span></div>
              <div className="row-actions">{item.status === 'failed' && <button className="button ghost" onClick={async () => setState(await run(() => api.retryOutbox(item.id)))}><RotateCcw size={14} />{t('retry')}</button>}{item.status !== 'sending' && <button className="icon-button" title={t('remove')} onClick={async () => setState(await run(() => api.removeOutbox(item.id)))}><X size={15} /></button>}</div>
            </div>)}
            {!state.outbox.length && <div className="empty-large"><Clock size={42} /><h2>{t('emptyOutbox')}</h2></div>}
          </div>
        </section>}

        {view === 'audit' && <section className="single-view">
          <header className="single-header"><div><h1>{t('activityLog')}</h1><p>{t('dataLocation')}</p></div></header>
          <div className="audit-list">{audit.map((event) => <div key={event.id} className="audit-row"><div className="audit-icon"><ShieldCheck size={17} /></div><div><strong>{event.action}</strong><span>{Object.entries(event.details || {}).map(([key, value]) => `${key}: ${value}`).join(' · ')}</span></div><time>{formatDate(event.at, language, true)}</time></div>)}</div>
        </section>}

        {view === 'settings' && <section className="single-view">
          <header className="single-header"><div><h1>{t('settings')}</h1><p>{t('realMailNotice')}</p></div><button className="button primary" onClick={() => (state.projects.length ? setModal('account') : setModal('project'))}><Plus size={16} />{t('addAccount')}</button></header>
          <div className="settings-grid">
            <div className="settings-card security-card">
              <h3><ShieldCheck size={18} />{t('securityTitle')}</h3>
              <ul>{['sec1', 'sec2', 'sec3', 'sec4', 'sec5', 'sec6', 'sec7'].map((key) => <li key={key}><Check size={14} />{t(key)}</li>)}</ul>
            </div>
            <div className="settings-card">
              <h3><AtSign size={18} />{t('accounts')}</h3>
              {state.accounts.map((account) => <div key={account.id} className="settings-row"><span className={classNames('status-dot', `status-${account.sync?.status || 'idle'}`)} /><div><strong>{account.displayName || account.email}</strong><small>{account.email} · {projectsById[account.projectId]?.name} · {account.sync?.error || statusLabel(t, account.sync?.status || 'idle')}</small></div><button className="icon-button danger" title={t('deleteAccount')} onClick={async () => { if (window.confirm(t('deleteAccountConfirm'))) setState(await run(() => api.deleteAccount(account.id))); }}><Trash2 size={15} /></button></div>)}
              {!state.accounts.length && <p className="muted">{t('noAccounts')}</p>}
              <h3 className="spaced"><FolderKanban size={18} />{t('projects')}</h3>
              {state.projects.map((project) => <div key={project.id} className="settings-row"><span className="status-dot" style={{ background: project.color }} /><div><strong>{project.name}</strong></div><button className="icon-button danger" title={t('deleteProject')} onClick={async () => setState(await run(() => api.deleteProject(project.id)))}><Trash2 size={15} /></button></div>)}
            </div>
          </div>
        </section>}
      </main>

      {modal === 'project' && <ProjectModal t={t} onClose={() => setModal(null)} onSave={async (input) => { const next = await run(() => api.createProject(input), t('saved')); setState(next); setSelectedProject(next.projects.at(-1)?.id || 'all'); setModal(null); }} />}
      {modal === 'account' && <AccountModal t={t} projects={state.projects} defaultProjectId={selectedProject === 'all' ? state.projects[0]?.id : selectedProject} onClose={() => setModal(null)} onSave={async (input) => { const next = await run(() => api.addAccount(input), t('saved')); setState(next); setModal(null); }} />}
      {modal === 'compose' && <ComposeModal t={t} accounts={state.accounts} initial={composeDraft} onClose={() => { setModal(null); setComposeDraft(null); }} onSave={saveDraft} onRequestSend={(draft) => setApprovalDraft(draft)} />}
      {approvalDraft && <ApprovalModal t={t} draft={approvalDraft} account={accountsById[approvalDraft.accountId]} onClose={() => setApprovalDraft(null)} onApprove={approveSend} busy={busy} />}
      {toast && <div className={classNames('toast', toast.kind)}>{toast.kind === 'error' ? <AlertCircle size={18} /> : toast.kind === 'warning' ? <Clock size={18} /> : <Check size={18} />}{toast.message}</div>}
    </div>
  );
}
