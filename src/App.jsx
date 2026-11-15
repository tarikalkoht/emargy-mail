import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, LoaderCircle, Mail } from 'lucide-react';
import { translator } from './i18n';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import ThreadView, { buildReply } from './components/ThreadView';
import Composer from './components/Composer';
import AccountSetup from './components/AccountSetup';
import SettingsView from './components/SettingsView';
import { ActivityPage, DraftsPage, OutboxPage } from './components/Pages';
import { classNames } from './lib/format';

const api = window.emargy;
const PAGE = 150;
const EMPTY = { language: 'en', settings: { theme: 'system', density: 'comfortable', undoSeconds: 10 }, projects: [], accounts: [], folders: [], counts: { total: 0, projects: {}, accounts: {} }, signatures: [], drafts: [], outbox: [] };
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function scopeParams(scope) {
  switch (scope.kind) {
    case 'unified': return scope.role === 'flagged' ? { folderRole: 'any', forcedFilter: 'flagged' } : { folderRole: scope.role };
    case 'project': return { projectId: scope.projectId, folderRole: 'inbox' };
    case 'account': return { accountId: scope.accountId, folderRole: 'inbox' };
    case 'folder': return { folderId: scope.folderId };
    default: return { folderRole: 'inbox' };
  }
}

function isTyping(target) {
  return target?.closest?.('input, textarea, select, [contenteditable="true"], .composer, .modal');
}

function Toast({ toast, onClose }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!toast?.until) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [toast]);
  if (!toast) return null;
  const left = toast.until ? Math.max(0, Math.ceil((toast.until - now) / 1000)) : null;
  return (
    <div className={classNames('toast', toast.kind)} role="status">
      {toast.kind === 'error' ? <AlertTriangle size={17} /> : toast.until ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
      <span>{toast.message}{left !== null && left > 0 ? ` (${left})` : ''}</span>
      {toast.actionLabel && <button onClick={() => { toast.onAction(); onClose(); }}>{toast.actionLabel}</button>}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(EMPTY);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState('mail');
  const [scope, setScope] = useState({ kind: 'unified', role: 'inbox' });
  const [expanded, setExpanded] = useState(() => new Set());
  const [list, setList] = useState({ messages: [], total: 0 });
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selection, setSelection] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composer, setComposer] = useState(null);
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const toastTimer = useRef(null);
  const searchRef = useRef(null);
  const syncedFolders = useRef(new Set());
  const language = state.language || 'en';
  const t = useMemo(() => translator(language), [language]);

  const showToast = useCallback((message, kind = 'success', extra = {}) => {
    clearTimeout(toastTimer.current);
    setToast({ message, kind, ...extra });
    const duration = extra.until ? extra.until - Date.now() + 600 : kind === 'error' ? 7000 : 3500;
    toastTimer.current = setTimeout(() => setToast(null), duration);
  }, []);

  const guard = useCallback(async (work) => {
    try {
      return await work();
    } catch (error) {
      showToast(errorText(error), 'error');
      return null;
    }
  }, [showToast]);

  const params = scopeParams(scope);
  const refreshList = useCallback(async () => {
    const { forcedFilter, ...rest } = scopeParams(scope);
    const result = await api.listMessages({ ...rest, filter: forcedFilter || filter, query, limit });
    setList(result);
  }, [scope, filter, query, limit]);
  const refreshState = useCallback(async () => setState(await api.getState()), []);

  // Initial load and live updates from the sync engine.
  useEffect(() => {
    api.getState().then((next) => {
      setState(next);
      setExpanded(new Set(next.projects.map((p) => p.id)));
      setReady(true);
    }).catch((error) => { showToast(errorText(error), 'error'); setReady(true); });
  }, [showToast]);
  useEffect(() => { refreshList().catch(() => {}); }, [refreshList]);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setLimit(PAGE); }, 220); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const offStatus = api.onSyncStatus(({ accountId, status, error }) => setState((current) => ({ ...current, accounts: current.accounts.map((a) => (a.id === accountId ? { ...a, sync: { status, error } } : a)) })));
    const offMail = api.onMailChanged(() => { refreshList().catch(() => {}); refreshState().catch(() => {}); });
    const offOutbox = api.onOutboxChanged(() => refreshState().catch(() => {}));
    return () => { offStatus(); offMail(); offOutbox(); };
  }, [refreshList, refreshState]);

  // Theme, density and direction.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dir = language === 'ar' ? 'rtl' : 'ltr';
    root.dataset.density = state.settings?.density || 'comfortable';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { root.dataset.theme = state.settings?.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings?.theme || 'light'; };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [language, state.settings]);

  // Folders other than Inbox/Sent are synced the first time they are opened.
  useEffect(() => {
    if (scope.kind !== 'folder' || syncedFolders.current.has(scope.folderId)) return;
    const folder = state.folders.find((f) => f.id === scope.folderId);
    if (!folder || folder.role === 'inbox' || folder.role === 'sent') return;
    syncedFolders.current.add(scope.folderId);
    api.syncFolder(scope.folderId).then((next) => { setState(next); refreshList(); }).catch(() => {});
  }, [scope, state.folders, refreshList]);

  const projectsById = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.id, p])), [state.projects]);
  const accountsById = useMemo(() => Object.fromEntries(state.accounts.map((a) => [a.id, a])), [state.accounts]);
  const foldersById = useMemo(() => Object.fromEntries(state.folders.map((f) => [f.id, f])), [state.folders]);

  const title = useMemo(() => {
    if (scope.kind === 'unified') return { inbox: t('allInboxes'), flagged: t('flagged'), sent: t('allSent') }[scope.role];
    if (scope.kind === 'project') return projectsById[scope.projectId]?.name || '';
    if (scope.kind === 'account') return accountsById[scope.accountId]?.displayName || accountsById[scope.accountId]?.email || '';
    const folder = foldersById[scope.folderId];
    return folder ? `${t(`folder_${folder.role}`, null, folder.name)} — ${accountsById[folder.accountId]?.email || ''}` : '';
  }, [scope, t, projectsById, accountsById, foldersById]);
  const showAccount = scope.kind === 'unified' || (scope.kind === 'project' && state.accounts.filter((a) => a.projectId === scope.projectId).length > 1);

  const openScope = (next) => {
    setScope(next);
    setSelection(new Set());
    setSelectedId(null);
    setThread(null);
    setLimit(PAGE);
    if (composer?.inline) setComposer(null);
  };

  const openThread = async (message) => {
    setSelectedId(message.id);
    setComposer(null); // the composer saves its draft when it closes
    setThreadLoading(true);
    const result = await guard(() => api.openThread(message.id));
    setThreadLoading(false);
    if (result) {
      setThread(result);
      setList((current) => ({ ...current, messages: current.messages.map((m) => (m.id === message.id ? { ...m, read: true, threadUnread: false } : m)) }));
      refreshState().catch(() => {});
    }
  };

  const onRowOpen = (message, event) => {
    if (event?.ctrlKey || event?.metaKey) return toggleSelect(message.id);
    setSelection(new Set());
    return openThread(message);
  };
  const toggleSelect = (id) => setSelection((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const runAction = async (action, ids, folderId) => {
    if (!ids.length) return;
    const call = {
      read: () => api.markRead(ids, true), unread: () => api.markRead(ids, false), flag: () => api.setFlagged(ids, true), unflag: () => api.setFlagged(ids, false),
      archive: () => api.archive(ids), trash: () => api.trash(ids), move: () => api.moveTo(ids, folderId),
    }[action];
    const next = await guard(call);
    if (!next) return;
    setState(next);
    const removes = ['archive', 'trash', 'move'].includes(action);
    if (removes && thread?.messages.some((m) => ids.includes(m.id))) {
      const index = list.messages.findIndex((m) => m.id === selectedId);
      const following = list.messages.filter((m) => !ids.includes(m.id))[Math.max(0, index)] || null;
      setThread(null);
      setSelectedId(null);
      if (following) openThread(following);
    } else if (thread && !removes) {
      setThread((current) => current && ({ ...current, messages: current.messages.map((m) => (ids.includes(m.id) ? { ...m, read: action === 'read' ? true : action === 'unread' ? false : m.read, flagged: action === 'flag' ? true : action === 'unflag' ? false : m.flagged } : m)) }));
    }
    if (action === 'archive') showToast(t('archived'));
    if (action === 'trash') showToast(t('movedToTrash'));
    if (action === 'move') showToast(t('moved'));
    refreshList();
  };

  const rowAction = async (action, message) => {
    const ids = await guard(() => api.threadIds(message.id, ['archive', 'trash', 'move'].includes(action)));
    if (ids) await runAction(action, ids);
  };
  const threadAction = (action, ids, folderId) => {
    const messages = thread?.messages || [];
    // Archiving a conversation never moves your own sent copies out of Sent.
    const target = action === 'archive' ? messages.filter((m) => ids.includes(m.id) && m.folderRole !== 'sent').map((m) => m.id) : ids;
    return runAction(action, target, folderId);
  };
  const bulk = async (action) => {
    const all = [];
    for (const id of selection) {
      const ids = await guard(() => api.threadIds(id, ['archive', 'trash', 'move'].includes(action)));
      if (ids) all.push(...ids);
    }
    setSelection(new Set());
    await runAction(action, [...new Set(all)]);
  };

  const compose = (initial = {}) => {
    if (!state.accounts.length) return showToast(t('addAccountFirst'), 'error');
    const defaultAccount = scope.accountId || (scope.kind === 'folder' ? foldersById[scope.folderId]?.accountId : null)
      || (scope.kind === 'project' ? state.accounts.find((a) => a.projectId === scope.projectId)?.id : null);
    setView('mail');
    setComposer({ key: Date.now(), inline: false, initial: { mode: 'new', accountId: defaultAccount || state.accounts[0].id, focusTo: true, ...initial } });
    return null;
  };
  const reply = (mode, message) => {
    const initial = buildReply(mode, message, accountsById[message.accountId], t, language);
    setComposer({ key: Date.now(), inline: true, initial });
  };
  const openDraft = async (id) => {
    const draft = await guard(() => api.getDraft(id));
    if (draft) { setView('mail'); setThread(null); setSelectedId(null); setComposer({ key: Date.now(), inline: false, initial: { ...draft, mode: draft.inReplyTo ? 'reply' : 'new' } }); }
  };

  const onSent = (result) => {
    setComposer(null);
    setState(result.state);
    const waiting = result.sendAt > Date.now() + 500;
    if (!waiting) return showToast(t('sent'));
    return showToast(t('sending'), 'info', {
      until: result.sendAt,
      actionLabel: t('undo'),
      onAction: async () => {
        const undone = await guard(() => api.undoSend(result.outboxId));
        if (undone) {
          setState(undone.state);
          setView('mail');
          setComposer({ key: Date.now(), inline: false, initial: { ...undone.draft, mode: undone.draft.inReplyTo ? 'reply' : 'new' } });
        }
      },
    });
  };

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || !state.accounts.length) return;
      const messages = list.messages;
      const index = messages.findIndex((m) => m.id === selectedId);
      const last = thread?.messages?.[thread.messages.length - 1];
      const ids = thread?.messages?.map((m) => m.id) || [];
      const keys = {
        c: () => compose(),
        '/': () => searchRef.current?.focus(),
        j: () => messages[index + 1] && openThread(messages[index + 1]),
        k: () => index > 0 && openThread(messages[index - 1]),
        r: () => last && reply('reply', last),
        a: () => last && reply('replyAll', last),
        f: () => last && reply('forward', last),
        e: () => last && threadAction('archive', ids),
        '#': () => last && threadAction('trash', ids),
        Delete: () => last && threadAction('trash', ids),
        s: () => last && threadAction(thread.messages.some((m) => m.flagged) ? 'unflag' : 'flag', ids),
        u: () => last && threadAction('unread', ids),
        Escape: () => setSelection(new Set()),
      };
      const handler = keys[event.key];
      if (handler && view === 'mail') { event.preventDefault(); handler(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!ready) return <div className="splash"><Mail size={30} /><LoaderCircle className="spin" size={20} /></div>;

  if (!state.accounts.length) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="welcome-brand"><span className="brand-mark"><Mail size={22} /></span><strong>{t('appName')}</strong>
            <button className="link-button" onClick={async () => setState(await api.setLanguage(language === 'ar' ? 'en' : 'ar'))}>{language === 'ar' ? 'English' : 'العربية'}</button>
          </div>
          <h1>{t('welcomeTitle')}</h1>
          <p className="welcome-lead">{t('welcomeLead')}</p>
          <AccountSetup t={t} projects={state.projects} firstRun onDone={(next) => { setState(next); setExpanded(new Set(next.projects.map((p) => p.id))); }} />
        </div>
        <Toast toast={toast} onClose={() => setToast(null)} />
      </div>
    );
  }

  const composerNode = composer && (
    <Composer
      key={composer.key}
      t={t}
      accounts={state.accounts}
      signatures={state.signatures}
      settings={state.settings}
      initial={composer.initial}
      inline={composer.inline}
      onClose={() => { setComposer(null); refreshState().catch(() => {}); }}
      onSent={onSent}
      onToast={showToast}
    />
  );
  const threadProject = thread?.messages?.[0] && projectsById[thread.messages[0].projectId];
  const threadAccount = thread?.messages?.[0] && accountsById[thread.messages[0].accountId];

  return (
    <div className="app">
      <Sidebar
        t={t}
        state={state}
        view={view}
        scope={scope}
        expanded={expanded}
        onToggle={(id) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
        onOpen={openScope}
        onView={(next) => { setView(next); if (next !== 'mail') setComposer((c) => (c?.inline ? null : c)); }}
        onCompose={() => compose()}
        onAddProject={() => setView('settings-projects')}
        onAddAccount={() => setView('settings-accounts')}
      />
      {view === 'mail' && (
        <>
          <MessageList
            t={t}
            language={language}
            title={title}
            list={list}
            projectsById={projectsById}
            accountsById={accountsById}
            showAccount={showAccount}
            selectedId={selectedId}
            selection={selection}
            onOpen={onRowOpen}
            onToggle={toggleSelect}
            onClearSelection={() => setSelection(new Set())}
            onAction={rowAction}
            onBulk={bulk}
            onLoadMore={() => setLimit((n) => n + PAGE)}
            search={search}
            onSearch={setSearch}
            filter={params.forcedFilter || filter}
            onFilter={(key) => { setFilter(key); setLimit(PAGE); }}
            onSync={async () => { setSyncing(true); const next = await guard(() => api.syncAll()); if (next) setState(next); setSyncing(false); refreshList(); }}
            syncing={syncing || state.accounts.some((a) => a.sync?.status === 'syncing')}
            searchRef={searchRef}
          />
          <main className="reading-pane">
            {composer && !composer.inline ? composerNode : (
              <ThreadView
                t={t}
                language={language}
                thread={thread}
                loading={threadLoading}
                project={threadProject}
                account={threadAccount}
                folders={state.folders}
                onAction={threadAction}
                onReply={reply}
                onTrustSender={async (address) => {
                  await guard(() => api.trustImages(address));
                  setThread((current) => current && ({ ...current, messages: current.messages.map((m) => (m.content.fromAddress === address ? { ...m, imagesTrusted: true } : m)) }));
                }}
                composer={composer?.inline ? composerNode : null}
              />
            )}
          </main>
        </>
      )}
      {view === 'drafts' && <DraftsPage t={t} language={language} state={state} setState={setState} onOpenDraft={openDraft} />}
      {view === 'outbox' && <OutboxPage t={t} language={language} state={state} setState={setState} onToast={showToast} />}
      {view === 'activity' && <ActivityPage t={t} language={language} state={state} />}
      {view.startsWith('settings') && <SettingsView key={view} t={t} state={state} setState={setState} language={language} onToast={showToast} onView={setView} initialTab={view.split('-')[1] || 'general'} />}
      <Toast toast={toast} onClose={() => { clearTimeout(toastTimer.current); setToast(null); }} />
    </div>
  );
}
