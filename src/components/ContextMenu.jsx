import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, AlertOctagon, Check, FileText, Folder, Inbox, Layers, Search, Send, Trash2 } from 'lucide-react';
import { classNames } from '../lib/format';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash', 'custom'];
const ROLE_ICON = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, all: Layers, junk: AlertOctagon, trash: Trash2, custom: Folder };

/** Keep a floating panel inside the window, opening up/left when there is no room. */
function usePlacement(x, y) {
  const ref = useRef(null);
  const [place, setPlace] = useState({ left: x, top: y, ready: false });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    const top = y + box.height > window.innerHeight - 8 ? Math.max(8, y - box.height) : y;
    setPlace({ left, top, ready: true });
  }, [x, y]);
  return [ref, place];
}

function useDismiss(ref, onClose) {
  useEffect(() => {
    const down = (event) => { if (!ref.current?.contains(event.target)) onClose(); };
    const key = (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const away = () => onClose();
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }, [ref, onClose]);
}

/**
 * Right-click menu. items: { label, icon, onClick, danger, disabled, checked, hint } or { separator: true }
 * or { heading: 'text' }.
 */
export function ContextMenu({ x, y, items, onClose }) {
  const [ref, place] = usePlacement(x, y);
  useDismiss(ref, onClose);
  useEffect(() => { ref.current?.querySelector('button:not(:disabled)')?.focus(); }, [ref]);
  const onKeyDown = (event) => {
    const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
  };
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: place.left, top: place.top, visibility: place.ready ? 'visible' : 'hidden' }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      {items.filter(Boolean).map((item, index) => {
        if (item.separator) return <div key={`s${index}`} className="menu-separator" role="separator" />;
        if (item.heading) return <div key={`h${index}`} className="menu-heading">{item.heading}</div>;
        const Icon = item.icon;
        return (
          <button
            key={item.key || item.label}
            role="menuitem"
            className={classNames(item.danger && 'danger', item.checked && 'checked')}
            disabled={item.disabled}
            onClick={() => { onClose(); item.onClick?.(); }}
          >
            <span className="menu-icon">{item.checked ? <Check size={15} /> : Icon ? <Icon size={15} /> : null}</span>
            <span className="menu-label">{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

/** Choose any folder of any account, with a filter box (used by "Move to…"). */
export function FolderPicker({ x, y, t, state, currentFolderIds = [], onPick, onClose }) {
  const [ref, place] = usePlacement(x, y);
  const [filter, setFilter] = useState('');
  useDismiss(ref, onClose);
  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return state.projects.flatMap((project) => state.accounts.filter((a) => a.projectId === project.id).map((account) => ({
      project,
      account,
      folders: state.folders
        .filter((f) => f.accountId === account.id && f.role !== 'drafts' && f.role !== 'all')
        .map((f) => ({ ...f, label: t(`folder_${f.role}`, null, f.name) }))
        .filter((f) => !needle || f.label.toLowerCase().includes(needle) || account.email.toLowerCase().includes(needle) || (account.displayName || '').toLowerCase().includes(needle))
        .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.label.localeCompare(b.label)),
    }))).filter((g) => g.folders.length);
  }, [state, filter, t]);
  return (
    <div ref={ref} className="context-menu folder-picker" role="dialog" aria-label={t('moveTo')} style={{ left: place.left, top: place.top, visibility: place.ready ? 'visible' : 'hidden' }}>
      <div className="picker-search">
        <Search size={14} />
        <input autoFocus dir="auto" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('findFolder')} aria-label={t('findFolder')}
          onKeyDown={(e) => { if (e.key === 'Enter') { const first = groups[0]?.folders.find((f) => !currentFolderIds.includes(f.id)); if (first) { onClose(); onPick(first.id); } } }} />
      </div>
      <div className="picker-list">
        {groups.map(({ project, account, folders }) => (
          <div key={account.id} className="picker-group" style={{ '--project': project.color }}>
            <div className="menu-heading"><span className="picker-dot" />{account.displayName || account.email}<small>{account.displayName ? account.email : project.name}</small></div>
            {folders.map((folder) => {
              const Icon = ROLE_ICON[folder.role] || Folder;
              const here = currentFolderIds.includes(folder.id);
              return (
                <button key={folder.id} disabled={here} onClick={() => { onClose(); onPick(folder.id); }}>
                  <span className="menu-icon"><Icon size={15} /></span>
                  <span className="menu-label" dir="auto">{folder.label}</span>
                  {here && <small className="menu-here">{t('currentFolder')}</small>}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && <div className="menu-note">{t('noFolders')}</div>}
      </div>
    </div>
  );
}
