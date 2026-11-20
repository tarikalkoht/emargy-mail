import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock, AlertTriangle, Archive, ArrowLeft, Bell, BellRing, Check, Copy, CornerUpLeft, Flag, FolderInput, Forward, Inbox, ListChecks, LoaderCircle, Mail, MailOpen, ReplyAll,
  ShieldAlert, ShieldCheck, Tag, Trash2, Users,
} from 'lucide-react';
import logoUrl from './assets/logo.png';
import TopBar from './components/TopBar';
import UpdateBar from './components/UpdateBar';
import { ContextMenu, FolderPicker } from './components/ContextMenu';
import Modal from './components/Modal';
import Logo from './components/Logo';
import EmptyScene from './components/EmptyScene';
import { translator } from './i18n';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import ThreadView, { buildReply } from './components/ThreadView';
import Composer from './components/Composer';
import AccountSetup from './components/AccountSetup';
import SettingsView from './components/SettingsView';
import { ActivityPage, DraftsPage, OutboxPage, RemindersPage } from './components/Pages';
import WhenPicker from './components/WhenPicker';
import { classNames, formatWhen } from './lib/format';

const api = window.emargy;
const PAGE = 150;
const EMPTY = { language: 'en', settings: { theme: 'system', density: 'comfortable', undoSeconds: 10 }, projects: [], accounts: [], folders: [], counts: { total: 0, projects: {}, accounts: {} }, signatures: [], drafts: [], outbox: [] };
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const TAB_ICONS = { primary: Inbox, promotions: Tag, social: Users, updates: Bell };

/** Views that show the inbox tabs (Gmail style): inboxes, not Important/Flagged/Sent or other folders. */
function tabbedScope(scope, foldersById) {
  if (scope.kind === 'unified') return scope.role === 'inbox';
  if (scope.kind === 'folder') return foldersById[scope.folderId]?.role === 'inbox';
  return scope.kind === 'project' || scope.kind === 'account';
}

function scopeParams(scope) {
  switch (scope.kind) {
    case 'unified':
      if (scope.role === 'flagged') return { folderRole: 'any', forcedFilter: 'flagged' };
      if (scope.role === 'important') return { folderRole: 'inbox', forcedFilter: 'important' };
      return { folderRole: scope.role };
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [serverSearch, setServerSearch] = useState(null);
  const serverSearchId = useRef(0);
  const [filter, setFilter] = useState('all');
  const [selection, setSelection] = useState(() => new Set());
  const [selectedId, setSelectedId] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [composer, setComposer] = useState(null);
  const [update, setUpdate] = useState(null);
  const [addingTo, setAddingTo] = useState(null);
  const [sceneImage, setSceneImage] = useState(null);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [toast, setToast] = useState(null);
  const [snoozing, setSnoozing] = useState(null); // { id, subject } of the conversation to snooze
  const [syncing, setSyncing] = useState(false);
  const [category, setCategory] = useState('primary');
  const [menu, setMenu] = useState(null);
  const [picker, setPicker] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [updateHidden, setUpdateHidden] = useState('');
  const logoImage = useRef(null);
  const [logoReady, setLogoReady] = useState(false);
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
  const foldersByIdEarly = useMemo(() => Object.fromEntries(state.folders.map((f) => [f.id, f])), [state.folders]);
  const tabbed = tabbedScope(scope, foldersByIdEarly) && state.settings?.inboxTabs !== false;
  const scopeFolders = useMemo(() => {
    if (params.folderId) return state.folders.filter((f) => f.id === params.folderId);
    const accounts = state.accounts.filter((a) => (!params.accountId || a.id === params.accountId) && (!params.projectId || a.projectId === params.projectId));
    const role = ['sent', 'archive', 'trash', 'junk', 'drafts', 'all'].includes(params.folderRole) ? params.folderRole : 'inbox';
    return state.folders.filter((f) => f.role === role && accounts.some((a) => a.id === f.accountId));
  }, [state.folders, state.accounts, params.folderId, params.accountId, params.projectId, params.folderRole]);
  const older = {
    available: scopeFolders.some((f) => !f.olderDone),
    loaded: scopeFolders.reduce((sum, f) => sum + (f.total || 0), 0),
    total: scopeFolders.reduce((sum, f) => sum + (f.serverTotal || 0), 0),
  };
  const loadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    const { forcedFilter, ...rest } = scopeParams(scope);
    const result = await guard(() => api.loadOlder(rest));
    setLoadingOlder(false);
    if (!result) return;
    setState(result.state);
    setLimit((n) => n + PAGE);
    refreshList();
    if (result.failed) showToast(t('olderFailed'), 'error');
  };
  const listRequest = useRef(0);
  const refreshList = useCallback(async () => {
    const { forcedFilter, ...rest } = scopeParams(scope);
    // A slower answer for a view you already left must not replace the current list.
    const request = ++listRequest.current;
    const result = await api.listMessages({ ...rest, filter: forcedFilter || filter, query, limit, category: tabbed ? category : undefined });
    if (request !== listRequest.current) return;
    setList(result);
  }, [scope, filter, query, limit, tabbed, category]);
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

  // Search the servers too (bodies and mail that was never downloaded), shortly after typing stops.
  useEffect(() => {
    const term = query.trim();
    const id = ++serverSearchId.current;
    if (term.length < 2) { setServerSearch(null); return undefined; }
    const timer = setTimeout(async () => {
      setServerSearch({ status: 'searching' });
      const { forcedFilter, ...rest } = scopeParams(scope);
      try {
        const result = await api.searchServer({ ...rest, query: term });
        if (id !== serverSearchId.current) return;
        setServerSearch({ status: 'done', ...result });
        refreshList().catch(() => {});
      } catch {
        if (id === serverSearchId.current) setServerSearch({ status: 'failed' });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [query, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const offStatus = api.onSyncStatus(({ accountId, status, error }) => setState((current) => ({ ...current, accounts: current.accounts.map((a) => (a.id === accountId ? { ...a, sync: { status, error } } : a)) })));
    const offMail = api.onMailChanged(() => { refreshList().catch(() => {}); refreshState().catch(() => {}); });
    const offOutbox = api.onOutboxChanged(() => refreshState().catch(() => {}));
    const offUpdate = api.onUpdateStatus(setUpdate);
    // Clicking an "important mail" notification opens that message.
    const offScope = api.onOpenScope((next) => { setView('mail'); setScope(next); setThread(null); setSelectedId(null); });
    const offOpen = api.onOpenMessage(({ id }) => {
      setView('mail');
      setScope({ kind: 'unified', role: 'important' });
      openThreadRef.current?.({ id });
    });
    const offView = api.onOpenView((next) => { if (next === 'reminders') setView('reminders'); });
    api.updateStatus().then(setUpdate).catch(() => {});
    return () => { offStatus(); offMail(); offOutbox(); offUpdate(); offOpen(); offScope(); offView(); };
  }, [refreshList, refreshState]);

  useEffect(() => {
    api.appInfo().then((info) => {
      setAppInfo(info);
      document.documentElement.dataset.titlebar = info.titleBar ? 'overlay' : 'native';
    }).catch(() => {});
    const image = new Image();
    image.onload = () => { logoImage.current = image; setLogoReady(true); };
    image.src = logoUrl;
    const offCompose = api.onComposeNew(() => composeRef.current?.());
    // Clicking the "new version" notification shows the banner again.
    const offUpdate = api.onOpenUpdate(() => setUpdateHidden(''));
    return () => { offCompose(); offUpdate(); };
  }, []);

  // The reader's own picture for empty screens (kept encrypted by the main process).
  const sceneKind = state.settings?.emptyScene || 'trays';
  useEffect(() => {
    if (sceneKind !== 'custom') { setSceneImage(null); return; }
    api.sceneImage().then(setSceneImage).catch(() => setSceneImage(null));
  }, [sceneKind, sceneVersion]);

  // Unread count on the taskbar button, and a red dot on the icon next to the clock.
  const badgeCount = state.settings?.taskbarBadge === false ? 0 : (state.counts?.total || 0);
  useEffect(() => {
    if (!badgeCount) { api.setBadge({}).catch(() => {}); return; }
    let trayImage;
    if (logoImage.current) {
      const tray = document.createElement('canvas');
      tray.width = 32;
      tray.height = 32;
      const tctx = tray.getContext('2d');
      tctx.drawImage(logoImage.current, 0, 0, 32, 32);
      tctx.fillStyle = '#ffffff';
      tctx.beginPath();
      tctx.arc(24, 8, 8, 0, Math.PI * 2);
      tctx.fill();
      tctx.fillStyle = '#e5484d';
      tctx.beginPath();
      tctx.arc(24, 8, 6, 0, Math.PI * 2);
      tctx.fill();
      trayImage = tray.toDataURL('image/png');
    }
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d92d20';
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${badgeCount > 99 ? 12 : badgeCount > 9 ? 15 : 18}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeCount > 99 ? '99+' : String(badgeCount), 16, 17);
    api.setBadge({ image: canvas.toDataURL('image/png'), label: `${badgeCount}`, trayImage }).catch(() => {});
  }, [badgeCount, logoReady]);

  // Theme, density and direction.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = language;
    root.dir = language === 'ar' ? 'rtl' : 'ltr';
    root.dataset.density = state.settings?.density || 'comfortable';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.theme = state.settings?.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings?.theme || 'light';
      api.setWindowTheme({ dark: root.dataset.theme === 'dark' }).catch(() => {});
    };
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
    if (scope.kind === 'unified') return { inbox: t('allInboxes'), flagged: t('flagged'), sent: t('allSent'), important: t('importantMail') }[scope.role];
    if (scope.kind === 'project') return projectsById[scope.projectId]?.name || '';
    if (scope.kind === 'account') return accountsById[scope.accountId]?.displayName || accountsById[scope.accountId]?.email || '';
    const folder = foldersById[scope.folderId];
    return folder ? `${t(`folder_${folder.role}`, null, folder.name)} — ${accountsById[folder.accountId]?.email || ''}` : '';
  }, [scope, t, projectsById, accountsById, foldersById]);
  const showAccount = scope.kind === 'unified' || (scope.kind === 'project' && state.accounts.filter((a) => a.projectId === scope.projectId).length > 1);

  const openScope = (next) => {
    setScope(next);
    setCategory('primary');
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
      openedThread.current = result;
      setThread(result);
      setList((current) => ({ ...current, messages: current.messages.map((m) => (m.id === message.id ? { ...m, read: true, threadUnread: false } : m)) }));
      refreshState().catch(() => {});
    }
  };

  const openedThread = useRef(null);
  const openThreadRef = useRef(null);
  openThreadRef.current = openThread;

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
      spam: () => api.markSpam(ids), notSpam: () => api.markNotSpam(ids), category: () => api.setCategory(ids, folderId),
    }[action];
    const next = await guard(call);
    if (!next) return;
    setState(next);
    const inJunk = (id) => list.messages.find((m) => m.id === id)?.folderRole === 'junk' || thread?.messages.find((m) => m.id === id)?.folderRole === 'junk';
    const removes = ['archive', 'trash', 'move', 'spam'].includes(action) || (action === 'notSpam' && ids.some(inJunk));
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
    if (action === 'spam') showToast(t('markedSpam'));
    if (action === 'notSpam') showToast(t('markedNotSpam'));
    if (action === 'category') showToast(t('categoryMoved', { tab: t(`tab_${folderId || 'primary'}`) }));
    if (thread && ['spam', 'notSpam'].includes(action) && !removes) {
      setThread((current) => current && ({ ...current, messages: current.messages.map((m) => (ids.includes(m.id) ? { ...m, trust: action === 'notSpam' ? '' : 'spam' } : m)) }));
    }
    refreshList();
  };

  const MOVING = ['archive', 'trash', 'move', 'spam', 'notSpam'];
  /** List rows stand for whole conversations: act on every message of each one. */
  const actOnRows = async (action, rowIds, extra) => {
    const all = [];
    for (const id of rowIds) {
      const ids = await guard(() => api.threadIds(id, MOVING.includes(action)));
      if (ids) all.push(...ids);
    }
    await runAction(action, [...new Set(all)], extra);
  };
  const rowAction = (action, message) => actOnRows(action, [message.id]);
  const threadAction = (action, ids, folderId) => {
    const messages = thread?.messages || [];
    // Archiving a conversation never moves your own sent copies out of Sent.
    const target = action === 'archive' ? messages.filter((m) => ids.includes(m.id) && m.folderRole !== 'sent').map((m) => m.id) : ids;
    return runAction(action, target, folderId);
  };
  const bulk = async (action, extra) => {
    const rows = [...selection];
    setSelection(new Set());
    await actOnRows(action, rows, extra);
  };
  const dropMessages = async (rowIds, folderId) => {
    setSelection(new Set());
    await actOnRows('move', rowIds, folderId);
  };

  /** Right-click on a conversation in the list. */
  const rowMenuItems = (message) => {
    const rows = selection.has(message.id) ? [...selection] : [message.id];
    const many = rows.length > 1;
    const unread = message.threadUnread ?? !message.read;
    const flagged = message.threadFlagged ?? message.flagged;
    const junk = message.folderRole === 'junk';
    const replyFromRow = async (mode) => {
      await openThread(message);
      const last = openedThread.current?.messages?.at(-1);
      if (last) reply(mode, last);
    };
    const act = (action, extra) => () => actOnRows(action, rows, extra);
    return [
      !many && { label: t('open'), icon: MailOpen, onClick: () => openThread(message) },
      !many && message.folderRole !== 'sent' && { label: t('reply'), icon: CornerUpLeft, onClick: () => replyFromRow('reply') },
      !many && { label: t('replyAll'), icon: ReplyAll, onClick: () => replyFromRow('replyAll') },
      !many && { label: t('forward'), icon: Forward, onClick: () => replyFromRow('forward') },
      !many && { separator: true },
      { label: unread ? t('markRead') : t('markUnread'), icon: unread ? MailOpen : Mail, onClick: act(unread ? 'read' : 'unread') },
      { label: flagged ? t('unflag') : t('flag'), icon: Flag, onClick: act(flagged ? 'unflag' : 'flag') },
      !many && message.folderRole === 'inbox' && { label: t('snoozeEllipsis'), icon: AlarmClock, hint: 'B', onClick: () => setSnoozing({ id: message.id, threadKey: message.threadKey }) },
      !many && message.folderRole === 'sent' && { label: t('remindIfNoReply'), icon: BellRing, onClick: () => remindIfNoReply(message.id, 3) },
      { separator: true },
      { label: t('moveToEllipsis'), icon: FolderInput, onClick: () => setPicker({ x: menu?.x ?? 0, y: menu?.y ?? 0, rows }) },
      tabbed && !many && { heading: t('moveToTab') },
      ...(tabbed && !many ? ['primary', 'promotions', 'social', 'updates'].map((key) => ({
        key: `tab-${key}`, label: t(`tab_${key}`), icon: TAB_ICONS[key], checked: (message.category || 'primary') === key,
        onClick: () => (message.category === key ? null : runAction('category', [message.id], key)),
      })) : []),
      { separator: true },
      junk || ['spam', 'suspicious'].includes(message.trust)
        ? { label: t('notSpam'), icon: ShieldCheck, onClick: act('notSpam') }
        : { label: t('reportSpam'), icon: ShieldAlert, onClick: act('spam') },
      { label: t('archive'), icon: Archive, hint: 'E', onClick: act('archive') },
      { label: t('delete'), icon: Trash2, hint: 'Del', danger: true, onClick: act('trash') },
      { separator: true },
      { label: selection.has(message.id) ? t('deselect') : t('select'), icon: ListChecks, onClick: () => toggleSelect(message.id) },
      !many && message.fromAddress && { label: t('copySender'), icon: Copy, onClick: () => api.copyText(message.fromAddress).then(() => showToast(t('copied'))) },
    ];
  };

  const composeRef = useRef(null);
  const compose = (initial = {}) => {
    if (!state.accounts.length) return showToast(t('addAccountFirst'), 'error');
    const defaultAccount = scope.accountId || (scope.kind === 'folder' ? foldersById[scope.folderId]?.accountId : null)
      || (scope.kind === 'project' ? state.accounts.find((a) => a.projectId === scope.projectId)?.id : null);
    setView('mail');
    setComposer({ key: Date.now(), inline: false, initial: { mode: 'new', accountId: defaultAccount || state.accounts[0].id, focusTo: true, ...initial } });
    return null;
  };
  composeRef.current = () => compose();
  const reply = (mode, message, options = {}) => {
    const initial = buildReply(mode, message, accountsById[message.accountId], t, language, options.prefill);
    setComposer({ key: Date.now(), inline: true, initial });
  };
  const openDraft = async (id) => {
    const draft = await guard(() => api.getDraft(id));
    if (draft) { setView('mail'); setThread(null); setSelectedId(null); setComposer({ key: Date.now(), inline: false, initial: { ...draft, mode: draft.inReplyTo ? 'reply' : 'new' } }); }
  };

  const snoozeUntil = async (until) => {
    const target = snoozing;
    setSnoozing(null);
    const next = await guard(() => api.snooze({ messageId: target.id, until }));
    if (!next) return;
    setState(next);
    if (thread?.messages?.some((m) => m.id === target.id || m.threadKey === target.threadKey)) { setThread(null); setSelectedId(null); }
    setSelection(new Set());
    refreshList();
    showToast(t('snoozedUntil', { when: formatWhen(until, language) }));
  };
  const remindIfNoReply = async (messageId, days) => {
    const next = await guard(() => api.remindIfNoReply({ messageId, days }));
    if (next) { setState(next); showToast(t('reminderSet', { n: days })); }
  };

  const reopenDraft = (draft) => {
    setView('mail');
    setComposer({ key: Date.now(), inline: false, initial: { ...draft, mode: draft.inReplyTo ? 'reply' : 'new' } });
  };
  const editScheduled = async (outboxId) => {
    const undone = await guard(() => api.undoSend(outboxId));
    if (undone) { setState(undone.state); reopenDraft(undone.draft); }
  };

  const onSent = (result) => {
    setComposer(null);
    setState(result.state);
    if (result.scheduled) {
      return showToast(t('scheduledFor', { when: formatWhen(result.sendAt, language) }), 'success', {
        actionLabel: t('cancel'),
        onAction: () => editScheduled(result.outboxId),
      });
    }
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
        b: () => last && thread.messages.some((m) => m.folderRole === 'inbox') && setSnoozing({ id: last.id, threadKey: last.threadKey }),
        Escape: () => { setSelection(new Set()); setMenu(null); },
      };
      if (event.key === 'Escape' && view !== 'mail' && !addingTo && !document.querySelector('.modal')) { event.preventDefault(); setView('mail'); return; }
      const handler = keys[event.key];
      if (handler && view === 'mail') { event.preventDefault(); handler(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!ready) return <div className="splash"><Mail size={30} /><LoaderCircle className="spin" size={20} /></div>;

  if (!state.accounts.length) {
    return (
      <div className="app-shell">
      <TopBar t={t} showSearch={false} />
      <div className="welcome">
        <div className="welcome-card">
          <div className="welcome-brand"><Logo size={34} /><strong>{t('appName')}</strong>
            <button className="link-button" onClick={async () => setState(await api.setLanguage(language === 'ar' ? 'en' : 'ar'))}>{language === 'ar' ? 'English' : 'العربية'}</button>
          </div>
          <h1>{t('welcomeTitle')}</h1>
          <p className="welcome-lead">{t('welcomeLead')}</p>
          <AccountSetup t={t} projects={state.projects} firstRun onDone={(next) => { setState(next); setExpanded(new Set(next.projects.map((p) => p.id))); }} />
        </div>
        <Toast toast={toast} onClose={() => setToast(null)} />
      </div>
      </div>
    );
  }

  const composerNode = composer && (
    <Composer
      key={composer.key}
      t={t}
      language={language}
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
    <div className="app-shell">
    <TopBar t={t} search={search} onSearch={(value) => { setSearch(value); if (view !== 'mail') setView('mail'); }} searchRef={searchRef} scopeLabel={scope.kind === 'unified' && scope.role === 'inbox' ? '' : title} />
    {update && ['ready', 'available'].includes(update.state) && updateHidden !== update.version && (
      <UpdateBar t={t} update={update} onLater={() => setUpdateHidden(update.version)} onError={(error) => showToast(errorText(error), 'error')} />
    )}
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
        onAddAccount={(projectId) => setAddingTo(projectId)}
        onReorderAccounts={async (ids) => { const next = await guard(() => api.reorderAccounts(ids)); if (next) setState(next); }}
        onReorderProjects={async (ids) => { const next = await guard(() => api.reorderProjects(ids)); if (next) setState(next); }}
        onDropMessages={dropMessages}
        update={update}
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
            onBulkMove={(event) => { const box = event.currentTarget.getBoundingClientRect(); setPicker({ x: box.left, y: box.bottom + 4, rows: [...selection] }); }}
            category={category}
            onCategory={(key) => { setCategory(key); setLimit(PAGE); setSelection(new Set()); }}
            onRowMenu={(message, event) => setMenu({ x: event.clientX, y: event.clientY, message })}
            junkView={scope.kind === 'folder' && foldersById[scope.folderId]?.role === 'junk'}
            onSelectAll={() => setSelection(new Set(list.messages.map((m) => m.id)))}
            older={older}
            loadingOlder={loadingOlder}
            onLoadOlder={loadOlder}
            serverSearch={serverSearch}
            importantView={scope.kind === 'unified' && scope.role === 'important'}
            aiAlerts={Boolean(state.settings.aiAlerts)}
            onEnableAlerts={async () => { const next = await guard(() => api.updateSettings({ aiAlerts: true })); if (next) { setState(next); showToast(t('aiAlertsOn')); } }}
            onMarkAllRead={async () => {
              const { forcedFilter, ...rest } = scopeParams(scope);
              const result = await guard(() => api.markAllRead(rest));
              if (!result) return;
              setState(result.state);
              refreshList();
              showToast(result.count ? t('markedAllRead', { n: result.count }) : t('nothingUnread'));
            }}
            onLoadMore={() => setLimit((n) => n + PAGE)}
            search={search}
            filter={params.forcedFilter || filter}
            onFilter={(key) => { setFilter(key); setLimit(PAGE); }}
            onSync={async () => { setSyncing(true); const next = await guard(() => api.syncAll()); if (next) setState(next); setSyncing(false); refreshList(); }}
            syncing={syncing || state.accounts.some((a) => a.sync?.status === 'syncing')}
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
                state={state}
                onAction={threadAction}
                onSnooze={(message) => setSnoozing({ id: message.id, threadKey: message.threadKey })}
                onRemind={remindIfNoReply}
                onReply={reply}
                onToast={showToast}
                onTrustSender={async (address) => {
                  await guard(() => api.trustImages(address));
                  setThread((current) => current && ({ ...current, messages: current.messages.map((m) => (m.content.fromAddress === address ? { ...m, imagesTrusted: true } : m)) }));
                }}
                composer={composer?.inline ? composerNode : null}
                empty={(
                  <EmptyScene
                    t={t}
                    kind={sceneKind}
                    image={sceneImage}
                    name={state.accounts[0]?.displayName}
                    unread={state.counts.total}
                    important={state.counts.important}
                    onOpenImportant={() => openScope({ kind: 'unified', role: 'important' })}
                    onCustomize={() => setView('settings-appearance')}
                  />
                )}
              />
            )}
          </main>
        </>
      )}
      {view !== 'mail' && (
        <div className="page-shell">
          <button className="back-button" onClick={() => setView('mail')} title="Esc"><ArrowLeft size={16} className="flip-rtl" />{t('backToMail')}</button>
          {view === 'drafts' && <DraftsPage t={t} language={language} state={state} setState={setState} onOpenDraft={openDraft} />}
          {view === 'outbox' && <OutboxPage t={t} language={language} state={state} setState={setState} onToast={showToast} onEdit={editScheduled} />}
          {view === 'reminders' && (
            <RemindersPage
              t={t}
              language={language}
              state={state}
              setState={setState}
              onToast={showToast}
              onOpen={(id) => { setView('mail'); openThreadRef.current?.({ id }); }}
            />
          )}
          {view === 'activity' && <ActivityPage t={t} language={language} state={state} />}
          {view.startsWith('settings') && <SettingsView key={view} t={t} state={state} setState={setState} language={language} onToast={showToast} onView={setView} onAddAccount={setAddingTo} onSceneChanged={() => setSceneVersion((n) => n + 1)} initialTab={view.split('-')[1] || 'general'} />}
        </div>
      )}
      {addingTo && (
        <Modal title={t('addAccountTo', { project: projectsById[addingTo]?.name || '' })} onClose={() => setAddingTo(null)} width="560px">
          <div className="modal-body">
            <AccountSetup t={t} projects={state.projects} defaultProjectId={addingTo} lockProject onCancel={() => setAddingTo(null)} onDone={(next) => { setState(next); setAddingTo(null); setExpanded((current) => new Set([...current, addingTo])); }} />
          </div>
        </Modal>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={rowMenuItems(menu.message)} onClose={() => setMenu(null)} />}
      {snoozing && <WhenPicker t={t} language={language} title={t('snoozeTitle')} hint={t('snoozeHint')} confirmLabel={t('snooze')} onPick={snoozeUntil} onClose={() => setSnoozing(null)} />}
      {picker && (
        <FolderPicker
          x={picker.x}
          y={picker.y}
          t={t}
          state={state}
          currentFolderIds={[...new Set(picker.rows.map((id) => list.messages.find((m) => m.id === id)?.folderId).filter(Boolean))]}
          onClose={() => setPicker(null)}
          onPick={(folderId) => { setSelection(new Set()); actOnRows('move', picker.rows, folderId); }}
        />
      )}
      <Toast toast={toast} onClose={() => { clearTimeout(toastTimer.current); setToast(null); }} />
    </div>
    </div>
  );
}
