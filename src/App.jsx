import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  AtSign,
  Check,
  ChevronDown,
  Download,
  FileText,
  FolderKanban,
  Inbox,
  Languages,
  LoaderCircle,
  Mail,
  Menu,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { translator } from './i18n';

const EMPTY_STATE = { language: 'en', projects: [], accounts: [], messages: [], drafts: [], audit: [] };

const providerPresets = {
  custom: { imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true },
  zoho: { imapHost: 'imap.zoho.com', imapPort: 993, imapSecure: true, smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true },
};

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}

function formatDate(value, language, withTime = false) {
  if (!value) return '';
  const date = new Date(value);
  const options = withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { hour: '2-digit', minute: '2-digit' };
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar-AE' : 'en-US', options).format(date);
}

function emailDisplay(value = '') {
  return value.replace(/<([^>]+)>/, '').trim() || value;
}

function Modal({ title, children, onClose, width = '560px' }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" style={{ '--modal-width': width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        </header>
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
        <label className="field full"><span>{t('projectName')}</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label className="field full"><span>Color</span><div className="color-row">{['#2d8cff', '#7c5cff', '#ff6b4a', '#15b886', '#f5a524', '#de4c8a'].map((item) => <button type="button" key={item} className={classNames('color-choice', color === item && 'selected')} style={{ background: item }} onClick={() => setColor(item)} aria-label={item}>{color === item && <Check size={16} />}</button>)}</div></label>
        <div className="modal-actions full"><button type="button" className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary" disabled={!name.trim()}>{t('createProject')}</button></div>
      </form>
    </Modal>
  );
}

function AccountModal({ t, projects, defaultProjectId, onClose, onSave }) {
  const [form, setForm] = useState({ projectId: defaultProjectId || projects[0]?.id || '', provider: 'custom', displayName: '', email: '', password: '', ...providerPresets.custom });
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const chooseProvider = (provider) => setForm((current) => ({ ...current, provider, ...providerPresets[provider] }));
  return (
    <Modal title={t('addAccount')} onClose={onClose} width="720px">
      <form className="modal-body form-grid two-columns" onSubmit={(event) => { event.preventDefault(); onSave(form); }}>
        <label className="field"><span>{t('project')}</span><select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} required>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span>{t('provider')}</span><select value={form.provider} onChange={(e) => chooseProvider(e.target.value)}><option value="custom">{t('custom')}</option><option value="gmail">{t('gmail')}</option><option value="zoho">{t('zoho')}</option></select></label>
        <label className="field"><span>{t('accountName')}</span><input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
        <label className="field"><span>{t('email')}</span><input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required /></label>
        <label className="field full"><span>{t('password')}</span><input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} required /><small>{t('passwordHelp')}</small></label>
        <label className="field"><span>{t('imapHost')}</span><input value={form.imapHost} onChange={(e) => set('imapHost', e.target.value)} required /></label>
        <label className="field"><span>{t('imapPort')}</span><input type="number" value={form.imapPort} onChange={(e) => set('imapPort', e.target.value)} required /></label>
        <label className="field"><span>{t('smtpHost')}</span><input value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} required /></label>
        <label className="field"><span>{t('smtpPort')}</span><input type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', e.target.value)} required /></label>
        <label className="checkbox-field"><input type="checkbox" checked={form.imapSecure} onChange={(e) => set('imapSecure', e.target.checked)} /> IMAP {t('secureConnection')}</label>
        <label className="checkbox-field"><input type="checkbox" checked={form.smtpSecure} onChange={(e) => set('smtpSecure', e.target.checked)} /> SMTP {t('secureConnection')}</label>
        <div className="notice full"><ShieldCheck size={18} /><span>{t('realMailNotice')}</span></div>
        <div className="modal-actions full"><button type="button" className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary">{t('saveAccount')}</button></div>
      </form>
    </Modal>
  );
}

function ComposeModal({ t, accounts, initial, onClose, onSave, onRequestSend }) {
  const [draft, setDraft] = useState({ id: initial?.id, accountId: initial?.accountId || accounts[0]?.id || '', to: initial?.to || '', cc: initial?.cc || '', bcc: initial?.bcc || '', subject: initial?.subject || '', body: initial?.body || '' });
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <Modal title={initial?.id ? t('draft') : t('newMessage')} onClose={onClose} width="820px">
      <div className="compose-form">
        <div className="compose-row"><span>{t('from')}</span><select value={draft.accountId} onChange={(e) => set('accountId', e.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName || account.email} · {account.email}</option>)}</select></div>
        <div className="compose-row"><span>{t('to')}</span><input value={draft.to} onChange={(e) => set('to', e.target.value)} autoFocus /></div>
        <div className="compose-row compact"><span>{t('cc')}</span><input value={draft.cc} onChange={(e) => set('cc', e.target.value)} /><span>{t('bcc')}</span><input value={draft.bcc} onChange={(e) => set('bcc', e.target.value)} /></div>
        <div className="compose-row"><span>{t('subject')}</span><input value={draft.subject} onChange={(e) => set('subject', e.target.value)} /></div>
        <textarea className="compose-body" value={draft.body} onChange={(e) => set('body', e.target.value)} placeholder={t('body')} />
        <div className="compose-footer"><div className="ai-policy"><Sparkles size={17} />{t('neverSendAutomatically')}</div><div className="button-row"><button className="button ghost" onClick={() => onSave(draft)}><FileText size={17} />{t('saveDraft')}</button><button className="button primary" disabled={!draft.accountId || !draft.to.trim()} onClick={() => onRequestSend(draft)}><Send size={17} />{t('send')}</button></div></div>
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
        <dl><div><dt>{t('from')}</dt><dd>{account?.email}</dd></div><div><dt>{t('to')}</dt><dd>{draft.to}</dd></div><div><dt>{t('subject')}</dt><dd>{draft.subject || '—'}</dd></div></dl>
        <div className="approval-preview">{draft.body || '—'}</div>
        <div className="modal-actions"><button className="button ghost" onClick={onClose}>{t('cancel')}</button><button className="button primary danger-safe" onClick={onApprove} disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={18} />}{t('approveSend')}</button></div>
      </div>
    </Modal>
  );
}

function MessageRow({ message, account, project, active, language, onClick }) {
  return (
    <button className={classNames('message-row', active && 'active', !message.read && 'unread')} onClick={onClick}>
      <div className="avatar" style={{ '--avatar-color': project?.color || '#2d8cff' }}>{emailDisplay(message.from).slice(0, 1).toUpperCase() || <Mail size={15} />}</div>
      <div className="message-row-content"><div className="message-line"><strong>{emailDisplay(message.from)}</strong><time>{formatDate(message.date, language)}</time></div><div className="message-subject">{message.important && <Star size={13} fill="currentColor" />}{message.subject}</div><div className="message-preview">{message.preview || account?.email}</div><div className="message-tags"><span style={{ '--tag-color': project?.color }}>{project?.name}</span><span><AtSign size={11} />{account?.email}</span></div></div>
    </button>
  );
}

function MessageReader({ message, loading, account, project, language, t, onDownload }) {
  if (loading) return <div className="reader-placeholder"><LoaderCircle className="spin" size={28} /><h2>{t('syncing')}</h2></div>;
  if (!message) return <div className="reader-placeholder"><div className="placeholder-orb"><Mail size={36} /></div><h2>{t('selectMessage')}</h2><p>{t('selectMessageHint')}</p></div>;
  const content = message.content || {};
  const cleanHtml = content.html ? DOMPurify.sanitize(content.html, { FORBID_TAGS: ['script', 'form', 'input', 'button', 'iframe', 'object', 'embed'], FORBID_ATTR: ['onclick', 'onerror', 'onload'] }) : '';
  return (
    <article className="reader">
      <header className="reader-header"><div className="reader-tags"><span style={{ '--tag-color': project?.color }}>{project?.name}</span><span><AtSign size={13} />{account?.email}</span>{message.important && <span className="important-tag"><Star size={13} fill="currentColor" />{t('important')}</span>}</div><h1>{message.subject}</h1><div className="sender-block"><div className="avatar large" style={{ '--avatar-color': project?.color }}>{emailDisplay(message.from).slice(0, 1).toUpperCase()}</div><div><strong>{content.from || message.from}</strong><span>{t('to')}: {content.to || message.to}</span></div><time>{formatDate(content.date || message.date, language, true)}</time></div></header>
      <section className="message-content">{cleanHtml ? <iframe title={message.subject} sandbox="" srcDoc={`<base target="_blank"><style>body{font-family:Arial,sans-serif;color:#20242a;line-height:1.55;margin:24px;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#0b66d4}</style>${cleanHtml}`} /> : <pre>{content.text || message.preview}</pre>}</section>
      {!!content.attachments?.length && <section className="attachments"><h3><Paperclip size={17} />{t('attachments')}</h3><div className="attachment-grid">{content.attachments.map((attachment) => <button key={attachment.id} onClick={() => onDownload(attachment)}><FileText size={22} /><span><strong>{attachment.filename}</strong><small>{Math.ceil(attachment.size / 1024)} KB</small></span><Download size={17} /></button>)}</div></section>}
    </article>
  );
}

export default function App() {
  const [state, setState] = useState(EMPTY_STATE);
  const [ready, setReady] = useState(false);
  const [selectedProject, setSelectedProject] = useState('all');
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [view, setView] = useState('inbox');
  const [selectedMessageId, setSelectedMessageId] = useState(null);
  const [fullMessage, setFullMessage] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [syncing, setSyncing] = useState({});
  const [modal, setModal] = useState(null);
  const [composeDraft, setComposeDraft] = useState(null);
  const [approvalDraft, setApprovalDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const language = state.language || 'en';
  const t = useMemo(() => translator(language), [language]);
  const api = window.emargy;

  const showToast = (message, kind = 'success') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 4200);
  };

  const run = async (operation, successMessage) => {
    try {
      const result = await operation();
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      showToast(error.message || t('error'), 'error');
      throw error;
    }
  };

  useEffect(() => {
    api.getState().then((next) => { setState(next); setReady(true); }).catch((error) => { showToast(error.message, 'error'); setReady(true); });
    return api.onSyncStatus((status) => setSyncing((current) => ({ ...current, [status.accountId]: status.status === 'syncing' })));
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }, [language]);

  const projectsById = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.id, p])), [state.projects]);
  const accountsById = useMemo(() => Object.fromEntries(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const visibleAccounts = state.accounts.filter((account) => selectedProject === 'all' || account.projectId === selectedProject);
  const visibleMessages = state.messages.filter((message) => {
    if (selectedProject !== 'all' && message.projectId !== selectedProject) return false;
    if (selectedAccount !== 'all' && message.accountId !== selectedAccount) return false;
    if (filter === 'unread' && message.read) return false;
    if (filter === 'important' && !message.important) return false;
    const query = search.trim().toLowerCase();
    return !query || [message.subject, message.from, message.to, message.preview, accountsById[message.accountId]?.email, projectsById[message.projectId]?.name].some((value) => String(value || '').toLowerCase().includes(query));
  });

  const openMessage = async (message) => {
    setSelectedMessageId(message.id);
    setLoadingMessage(true);
    setFullMessage(null);
    try {
      const result = await run(() => api.getMessage(message.id));
      setFullMessage(result);
      setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === result.id ? { ...item, read: true, preview: result.preview } : item) }));
    } finally {
      setLoadingMessage(false);
    }
  };

  const syncAccount = async (id) => {
    setSyncing((current) => ({ ...current, [id]: true }));
    try {
      const next = await run(() => api.syncAccount(id), t('saved'));
      setState(next);
    } finally {
      setSyncing((current) => ({ ...current, [id]: false }));
    }
  };

  const saveDraft = async (draft, keepCompose = false) => {
    const result = await run(() => api.saveDraft(draft), t('saved'));
    setState(result.state);
    if (!keepCompose) { setModal(null); setComposeDraft(null); }
    return result.draft;
  };

  const requestSend = async (draft) => {
    const saved = await saveDraft(draft, true);
    setApprovalDraft(saved);
  };

  const approveSend = async () => {
    setBusy(true);
    try {
      const result = await run(() => api.sendDraft(approvalDraft.id), t('sent'));
      setState(result.state);
      setApprovalDraft(null);
      setComposeDraft(null);
      setModal(null);
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <div className="splash"><div className="brand-mark"><Mail size={32} /></div><h1>Emargy Mail</h1><LoaderCircle className="spin" /></div>;

  const activeMessage = fullMessage || state.messages.find((message) => message.id === selectedMessageId);
  const activeAccount = activeMessage && accountsById[activeMessage.accountId];
  const activeProject = activeMessage && projectsById[activeMessage.projectId];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Mail size={21} /></div><strong>{t('appName')}</strong><span className="version">alpha</span></div>
        <div className="global-search"><Search size={18} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} /></div>
        <div className="top-actions"><button className="language-button" onClick={async () => setState(await api.setLanguage(language === 'ar' ? 'en' : 'ar'))}><Languages size={17} />{language === 'ar' ? 'English' : 'العربية'}</button><button className="button primary compose-top" onClick={() => state.accounts.length ? (setComposeDraft(null), setModal('compose')) : showToast(t('accountRequired'), 'error')}><PenLine size={17} />{t('newMessage')}</button></div>
      </header>

      <aside className="sidebar">
        <nav className="main-nav"><button className={classNames(view === 'inbox' && 'active')} onClick={() => setView('inbox')}><Inbox size={18} /><span>{t('inbox')}</span><b>{state.messages.filter((m) => !m.read).length}</b></button><button className={classNames(view === 'drafts' && 'active')} onClick={() => setView('drafts')}><FileText size={18} /><span>{t('drafts')}</span><b>{state.drafts.filter((d) => d.status === 'draft').length}</b></button><button className={classNames(view === 'audit' && 'active')} onClick={() => setView('audit')}><Activity size={18} /><span>{t('audit')}</span></button></nav>
        <div className="sidebar-section"><div className="section-title"><span>{t('projects')}</span><button onClick={() => setModal('project')}><Plus size={16} /></button></div><button className={classNames('project-item', selectedProject === 'all' && 'active')} onClick={() => { setSelectedProject('all'); setSelectedAccount('all'); }}><span className="project-dot all"><FolderKanban size={13} /></span><span>{t('allProjects')}</span></button>{state.projects.map((project) => <button key={project.id} className={classNames('project-item', selectedProject === project.id && 'active')} onClick={() => { setSelectedProject(project.id); setSelectedAccount('all'); }}><span className="project-dot" style={{ background: project.color }} /><span>{project.name}</span><b>{state.messages.filter((m) => m.projectId === project.id && !m.read).length || ''}</b></button>)}</div>
        <div className="sidebar-section accounts-section"><div className="section-title"><span>{t('accounts')}</span><button onClick={() => state.projects.length ? setModal('account') : setModal('project')}><Plus size={16} /></button></div><button className={classNames('account-item', selectedAccount === 'all' && 'active')} onClick={() => setSelectedAccount('all')}><span className="account-icon"><Inbox size={14} /></span><span>{t('inbox')}</span></button>{visibleAccounts.map((account) => <div className={classNames('account-item-wrap', selectedAccount === account.id && 'active')} key={account.id}><button className="account-item" onClick={() => setSelectedAccount(account.id)}><span className="account-icon"><AtSign size={14} /></span><span><strong>{account.displayName || account.email.split('@')[0]}</strong><small>{account.email}</small></span>{account.lastError && <AlertCircle className="account-error" size={14} />}</button><button className="account-sync" onClick={() => syncAccount(account.id)} title={account.lastError || t('sync')} disabled={syncing[account.id]}>{syncing[account.id] ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button></div>)}</div>
        <div className="sidebar-footer"><ShieldCheck size={15} /><span>{t('localFirst')}</span></div>
      </aside>

      <main className="workspace">
        {view === 'inbox' && <>
          <section className="message-list"><header className="list-header"><div><h2>{selectedProject === 'all' ? t('inbox') : projectsById[selectedProject]?.name}</h2><span>{visibleMessages.length} messages</span></div><button className="icon-button" onClick={() => Promise.all(visibleAccounts.map((account) => syncAccount(account.id)))} disabled={!visibleAccounts.length}><RefreshCw size={17} /></button></header><div className="filter-bar"><button className={classNames(filter === 'all' && 'active')} onClick={() => setFilter('all')}>{t('inbox')}</button><button className={classNames(filter === 'unread' && 'active')} onClick={() => setFilter('unread')}>{t('unread')}</button><button className={classNames(filter === 'important' && 'active')} onClick={() => setFilter('important')}><Star size={13} />{t('important')}</button></div><div className="messages-scroll">{visibleMessages.map((message) => <MessageRow key={message.id} message={message} account={accountsById[message.accountId]} project={projectsById[message.projectId]} active={message.id === selectedMessageId} language={language} onClick={() => openMessage(message)} />)}{!visibleMessages.length && <div className="empty-list"><Inbox size={30} /><h3>{t('noMessages')}</h3><p>{t('noMessagesHint')}</p>{!state.accounts.length && <button className="button primary" onClick={() => state.projects.length ? setModal('account') : setModal('project')}><Plus size={16} />{state.projects.length ? t('addAccount') : t('addProject')}</button>}</div>}</div></section>
          <section className="reader-pane"><MessageReader message={activeMessage} loading={loadingMessage} account={activeAccount} project={activeProject} language={language} t={t} onDownload={(attachment) => run(() => api.saveAttachment(attachment))} /></section>
        </>}
        {view === 'drafts' && <section className="single-view"><header className="single-header"><div><h1>{t('drafts')}</h1><p>{t('neverSendAutomatically')}</p></div><button className="button primary" onClick={() => state.accounts.length ? setModal('compose') : showToast(t('accountRequired'), 'error')}><PenLine size={17} />{t('newMessage')}</button></header><div className="draft-grid">{state.drafts.filter((draft) => draft.status === 'draft').map((draft) => <button key={draft.id} className="draft-card" onClick={() => { setComposeDraft(draft); setModal('compose'); }}><div className="draft-icon"><FileText size={20} /></div><div><span>{t('draft')}</span><h3>{draft.subject || `(${t('subject')})`}</h3><p>{draft.to || t('to')}</p><small>{formatDate(draft.updatedAt, language, true)}</small></div><ArrowRight size={17} className="direction-arrow" /></button>)}{!state.drafts.some((draft) => draft.status === 'draft') && <div className="empty-large"><FileText size={42} /><h2>{t('emptyDrafts')}</h2></div>}</div></section>}
        {view === 'audit' && <section className="single-view"><header className="single-header"><div><h1>{t('activityLog')}</h1><p>{t('localFirst')}</p></div></header><div className="audit-list">{state.audit.map((event) => <div key={event.id} className="audit-row"><div className="audit-icon"><ShieldCheck size={17} /></div><div><strong>{event.action}</strong><span>{Object.entries(event.details || {}).map(([key, value]) => `${key}: ${value}`).join(' · ')}</span></div><time>{formatDate(event.at, language, true)}</time></div>)}</div></section>}
      </main>

      {modal === 'project' && <ProjectModal t={t} onClose={() => setModal(null)} onSave={async (input) => { const next = await run(() => api.createProject(input), t('saved')); setState(next); setSelectedProject(next.projects.at(-1)?.id || 'all'); setModal(null); }} />}
      {modal === 'account' && <AccountModal t={t} projects={state.projects} defaultProjectId={selectedProject === 'all' ? state.projects[0]?.id : selectedProject} onClose={() => setModal(null)} onSave={async (input) => { const next = await run(() => api.addAccount(input), t('saved')); setState(next); setModal(null); }} />}
      {modal === 'compose' && <ComposeModal t={t} accounts={state.accounts} initial={composeDraft} onClose={() => { setModal(null); setComposeDraft(null); }} onSave={saveDraft} onRequestSend={requestSend} />}
      {approvalDraft && <ApprovalModal t={t} draft={approvalDraft} account={accountsById[approvalDraft.accountId]} onClose={() => setApprovalDraft(null)} onApprove={approveSend} busy={busy} />}
      {toast && <div className={classNames('toast', toast.kind)}>{toast.kind === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}{toast.message}</div>}
    </div>
  );
}

