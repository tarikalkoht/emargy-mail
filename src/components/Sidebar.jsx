import {
  Activity, AlertOctagon, Archive, ChevronDown, Clock, Download, FileText, Flag, Folder, Inbox, Layers, PenSquare, Plus, Send, Settings, Trash2,
} from 'lucide-react';
import { classNames } from '../lib/format';

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash', 'custom'];
const ROLE_ICON = { inbox: Inbox, drafts: FileText, sent: Send, archive: Archive, all: Layers, junk: AlertOctagon, trash: Trash2, custom: Folder };

function sameScope(a, b) {
  return a && b && a.kind === b.kind && a.role === b.role && a.projectId === b.projectId && a.accountId === b.accountId && a.folderId === b.folderId;
}

function NavItem({ icon: Icon, label, count, active, onClick, depth = 0, tone }) {
  return (
    <button className={classNames('nav-item', active && 'active', tone)} style={{ '--depth': depth }} onClick={onClick} aria-current={active ? 'page' : undefined}>
      {Icon && <Icon size={16} />}
      <span className="nav-label" dir="auto">{label}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );
}

export default function Sidebar({ t, state, view, scope, expanded, onToggle, onOpen, onView, onCompose, onAddProject, onAddAccount, update }) {
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
            <div key={project.id} className="tree-project" style={{ '--project': project.color }}>
              <div className={classNames('project-tab', isMail && sameScope(scope, { kind: 'project', projectId: project.id }) && 'active')}>
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
                      <div key={account.id} className="tree-account">
                        <div className={classNames('account-line', isMail && sameScope(scope, { kind: 'account', accountId: account.id }) && 'active')}>
                          <button className="tab-toggle" onClick={() => onToggle(account.id)} aria-expanded={accountOpen} aria-label={account.email}><ChevronDown size={13} /></button>
                          <button className="account-name" onClick={() => open({ kind: 'account', accountId: account.id })} title={account.sync?.error || account.email}>
                            <span className={classNames('status-dot', `s-${status}`)} />
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
        {update?.state === 'ready' && (
          <div className="update-banner" role="status">
            <Download size={15} />
            <span>{t('updateReady', { version: update.version })}</span>
            <button className="button primary small" onClick={() => window.emargy.installUpdate()}>{t('updateRestart')}</button>
          </div>
        )}
        {update?.state === 'available' && (
          <div className="update-banner" role="status">
            <Download size={15} />
            <span>{t('updateAvailable', { version: update.version })}</span>
            <button className="button ghost small" onClick={() => window.emargy.openHelp('releases')}>{t('updateDownload')}</button>
          </div>
        )}
        <NavItem icon={Settings} label={t('settings')} active={view.startsWith('settings')} onClick={() => onView('settings')} />
        <NavItem icon={Activity} label={t('activity')} active={view === 'activity'} onClick={() => onView('activity')} />
      </div>
    </nav>
  );
}
