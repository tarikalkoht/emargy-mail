import {
  Activity, AlertOctagon, Archive, ChevronDown, Clock, FileText, Sparkles, Flag, Folder, Inbox, Layers, PenSquare, Plus, Send, Settings, Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { classNames } from '../lib/format';
import { DRAG_TYPE } from './MessageList';
import AccountAvatar from './AccountAvatar';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash', 'custom'];
const ROLE_ICON = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, all: Layers, junk: AlertOctagon, trash: Trash2, custom: Folder };

function sameScope(a, b) {
  return a && b && a.kind === b.kind && a.role === b.role && a.projectId === b.projectId && a.accountId === b.accountId && a.folderId === b.folderId;
}

/** Messages dragged from the list can be dropped on a folder (or an account = its inbox). */
function dropProps(folderId, onDropMessages, setOver, over) {
  if (!folderId || !onDropMessages) return {};
  const accepts = (event) => [...event.dataTransfer.types].includes(DRAG_TYPE);
  return {
    'data-drop': over === folderId ? 'over' : undefined,
    onDragOver: (event) => { if (!accepts(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(folderId); },
    onDragLeave: () => setOver((current) => (current === folderId ? null : current)),
    onDrop: (event) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(null);
      try { onDropMessages(JSON.parse(event.dataTransfer.getData(DRAG_TYPE)), folderId); } catch { /* not ours */ }
    },
  };
}

function NavItem({ icon: Icon, label, count, active, onClick, depth = 0, tone, drop }) {
  return (
    <button className={classNames('nav-item', active && 'active', tone)} style={{ '--depth': depth }} onClick={onClick} aria-current={active ? 'page' : undefined} {...drop}>
      {Icon && <Icon size={16} />}
      <span className="nav-label" dir="auto">{label}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );
}

/** New global order after dropping `dragId` onto `targetId` (two accounts of one project, or two projects). */
export function moveAccount(accounts, dragId, targetId) {
  const ids = accounts.map((a) => a.id);
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  ids.splice(from, 1);
  ids.splice(to, 0, dragId);
  return ids;
}

export default function Sidebar({ t, state, view, scope, expanded, onToggle, onOpen, onView, onCompose, onAddProject, onAddAccount, onReorderAccounts, onReorderProjects, onDropMessages, update }) {
  const [dragging, setDragging] = useState(null);
  const [draggingProject, setDraggingProject] = useState(null);
  const [projectTarget, setProjectTarget] = useState(null);
  const [over, setOver] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const { projects, accounts, folders, counts, drafts, outbox } = state;
  const pending = outbox.filter((item) => item.status === 'queued' || item.status === 'failed').length;
  const failed = outbox.some((item) => item.status === 'failed');
  const isMail = view === 'mail';
  const open = (next) => { onView('mail'); onOpen(next); };

  return (
    <nav className="sidebar" aria-label={t('navigation')}>
      <button className="compose-button" onClick={onCompose}><PenSquare size={17} />{t('newMessage')}</button>

      <div className="nav-group">
        <NavItem icon={Inbox} label={t('allInboxes')} count={counts.total} active={isMail && sameScope(scope, { kind: 'unified', role: 'inbox' })} onClick={() => open({ kind: 'unified', role: 'inbox' })} />
        <NavItem icon={Sparkles} label={t('importantMail')} count={counts.important} tone="important" active={isMail && sameScope(scope, { kind: 'unified', role: 'important' })} onClick={() => open({ kind: 'unified', role: 'important' })} />
        <NavItem icon={Flag} label={t('flagged')} active={isMail && sameScope(scope, { kind: 'unified', role: 'flagged' })} onClick={() => open({ kind: 'unified', role: 'flagged' })} />
        <NavItem icon={Send} label={t('allSent')} active={isMail && sameScope(scope, { kind: 'unified', role: 'sent' })} onClick={() => open({ kind: 'unified', role: 'sent' })} />
        <NavItem icon={FileText} label={t('drafts')} count={drafts.length} active={view === 'drafts'} onClick={() => onView('drafts')} />
        {(pending > 0 || view === 'outbox') && <NavItem icon={Clock} label={t('outbox')} count={pending} tone={failed ? 'warn' : ''} active={view === 'outbox'} onClick={() => onView('outbox')} />}
      </div>

      <div className="nav-heading">
        <span>{t('projects')}</span>
        <button className="icon-button quiet tiny" onClick={onAddProject} title={t('addProject')} aria-label={t('addProject')}><Plus size={15} /></button>
      </div>
      <div className="nav-tree">
        {projects.map((project) => {
          const projectAccounts = accounts.filter((a) => a.projectId === project.id);
          const projectOpen = expanded.has(project.id);
          return (
            <div key={project.id} className={classNames('tree-project', draggingProject === project.id && 'dragging', projectTarget === project.id && draggingProject !== project.id && 'drop-target')} style={{ '--project': project.color }}>
              <div
                className={classNames('project-tab', isMail && sameScope(scope, { kind: 'project', projectId: project.id }) && 'active')}
                draggable
                title={t('dragToReorder')}
                onDragStart={(e) => { setDraggingProject(project.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', project.id); }}
                onDragEnd={() => { setDraggingProject(null); setProjectTarget(null); }}
                onDragOver={(e) => { if (draggingProject) { e.preventDefault(); setProjectTarget(project.id); } }}
                onDrop={(e) => {
                  if (!draggingProject) return;
                  e.preventDefault();
                  const order = moveAccount(projects, draggingProject, project.id);
                  setDraggingProject(null);
                  setProjectTarget(null);
                  if (order) onReorderProjects?.(order);
                }}
              >
                <button className="tab-toggle" onClick={() => onToggle(project.id)} aria-expanded={projectOpen} aria-label={project.name}><ChevronDown size={14} /></button>
                <button className="tab-name" onClick={() => open({ kind: 'project', projectId: project.id })} dir="auto">{project.name}</button>
                {counts.projects[project.id] ? <span className="nav-count">{counts.projects[project.id]}</span> : null}
              </div>
              {projectOpen && (
                <div className="tree-children">
                  {projectAccounts.map((account) => {
                    const accountOpen = expanded.has(account.id);
                    const status = account.sync?.status || 'idle';
                    const accountFolders = folders.filter((f) => f.accountId === account.id)
                      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
                    return (
                      <div
                        key={account.id}
                        className={classNames('tree-account', dragging === account.id && 'dragging', dropTarget === account.id && dragging !== account.id && 'drop-target')}
                        draggable
                        title={t('dragToReorder')}
                        onDragStart={(e) => { setDragging(account.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', account.id); }}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                        onDragOver={(e) => {
                          const source = accounts.find((a) => a.id === dragging);
                          if (source && source.projectId === account.projectId) { e.preventDefault(); setDropTarget(account.id); }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const order = moveAccount(accounts, dragging, account.id);
                          setDragging(null);
                          setDropTarget(null);
                          if (order) onReorderAccounts(order);
                        }}
                      >
                        <div className={classNames('account-line', isMail && sameScope(scope, { kind: 'account', accountId: account.id }) && 'active')} {...dropProps(accountFolders.find((f) => f.role === 'inbox')?.id, onDropMessages, setOver, over)}>
                          <button className="tab-toggle" onClick={() => onToggle(account.id)} aria-expanded={accountOpen} aria-label={account.email}><ChevronDown size={13} /></button>
                          <button className="account-name" onClick={() => open({ kind: 'account', accountId: account.id })} title={account.sync?.error || account.email}>
                            <span className="avatar-status"><AccountAvatar account={account} size={20} /><span className={classNames('status-dot', `s-${status}`)} /></span>
                            <span dir="auto">{account.displayName || account.email}</span>
                          </button>
                          {counts.accounts[account.id] ? <span className="nav-count">{counts.accounts[account.id]}</span> : null}
                        </div>
                        {accountOpen && accountFolders.map((folder) => (
                          <NavItem
                            key={folder.id}
                            depth={1}
                            icon={ROLE_ICON[folder.role] || Folder}
                            label={t(`folder_${folder.role}`, null, folder.name)}
                            count={folder.role === 'inbox' || folder.role === 'custom' ? folder.unread : 0}
                            active={isMail && sameScope(scope, { kind: 'folder', folderId: folder.id })}
                            onClick={() => open({ kind: 'folder', folderId: folder.id, accountId: account.id })}
                            drop={folder.role === 'drafts' || folder.role === 'all' ? null : dropProps(folder.id, onDropMessages, setOver, over)}
                          />
                        ))}
                      </div>
                    );
                  })}
                  <button className="add-account-line" onClick={() => onAddAccount(project.id)}><Plus size={13} />{t('addAccount')}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="nav-footer">
        <NavItem icon={Settings} label={t('settings')} active={view.startsWith('settings')} onClick={() => onView('settings')} />
        <NavItem icon={Activity} label={t('activity')} active={view === 'activity'} onClick={() => onView('activity')} />
      </div>
    </nav>
  );
}
