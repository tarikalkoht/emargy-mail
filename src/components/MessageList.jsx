import { Archive, BadgeCheck, CheckCheck, Flag, Inbox, ListChecks, LoaderCircle, Mail, MailOpen, Paperclip, RefreshCw, Search, ShieldAlert, Sparkles, Trash2, X } from 'lucide-react';
import { classNames, displayName, formatListDate } from '../lib/format';

const FILTERS = ['all', 'unread', 'important', 'flagged', 'attachments', 'spam'];

export function TrustBadge({ trust, t }) {
  if (trust === 'spam') return <span className="trust-badge spam" title={t('trustSpamHint')}><ShieldAlert size={12} />{t('trustSpam')}</span>;
  if (trust === 'suspicious') return <span className="trust-badge suspicious" title={t('trustSuspiciousHint')}><ShieldAlert size={12} />{t('trustSuspicious')}</span>;
  if (trust === 'verified') return <span className="trust-verified" title={t('trustVerifiedHint')} aria-label={t('trustVerified')}><BadgeCheck size={14} /></span>;
  return null;
}

function Row({ message, project, account, showAccount, active, selected, selecting, language, t, onOpen, onToggle, onAction }) {
  const unread = message.threadUnread ?? !message.read;
  const flagged = message.threadFlagged ?? message.flagged;
  const who = message.folderRole === 'sent' ? `${t('toLabel')} ${displayName(message.to)}` : displayName(message.from);
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={classNames('row', unread && 'unread', active && 'active', selected && 'selected', ['spam', 'suspicious'].includes(message.trust) && 'untrusted')}
      style={{ '--project': project?.color || 'var(--line-strong)' }}
      onClick={(event) => onOpen(message, event)}
    >
      <span className="row-tab" aria-hidden="true" />
      <label className={classNames('row-check', selecting && 'visible')} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(message.id)} aria-label={t('select')} />
      </label>
      <div className="row-main">
        <div className="row-top">
          <span className="row-from" dir="auto">{who}</span>
          <TrustBadge trust={message.trust} t={t} />
          {message.threadCount > 1 && <span className="row-count">{message.threadCount}</span>}
          <time>{formatListDate(message.date, language)}</time>
        </div>
        {message.aiImportant && message.aiNote && !['spam', 'suspicious'].includes(message.trust) && (
          <div className="row-ai" title={message.aiNote.reason}><Sparkles size={12} /><strong>{t(`category_${message.aiNote.category}`)}</strong><span dir="auto">{message.aiNote.reason}</span></div>
        )}
        <div className="row-subject" dir="auto">
          {flagged && <Flag size={13} className="flag-icon" />}
          {message.hasAttachments && <Paperclip size={13} className="clip-icon" />}
          <span>{message.subject || t('noSubject')}</span>
        </div>
        <div className="row-preview" dir="auto">{message.preview || ' '}</div>
        {showAccount && (
          <div className="row-where">
            <span className="row-project">{project?.name}</span>
            <span className="row-account">{account?.email}</span>
          </div>
        )}
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => onAction('archive', message)} title={t('archive')} aria-label={t('archive')}><Archive size={15} /></button>
        <button onClick={() => onAction('trash', message)} title={t('delete')} aria-label={t('delete')}><Trash2 size={15} /></button>
        <button onClick={() => onAction(unread ? 'read' : 'unread', message)} title={unread ? t('markRead') : t('markUnread')} aria-label={unread ? t('markRead') : t('markUnread')}>{unread ? <MailOpen size={15} /> : <Mail size={15} />}</button>
        <button className={classNames(flagged && 'on')} onClick={() => onAction(flagged ? 'unflag' : 'flag', message)} title={flagged ? t('unflag') : t('flag')} aria-label={t('flag')}><Flag size={15} /></button>
      </div>
    </div>
  );
}

export default function MessageList({
  t, language, title, list, projectsById, accountsById, showAccount, selectedId, selection, onOpen, onToggle, onClearSelection,
  onAction, onBulk, onLoadMore, search, onSearch, filter, onFilter, onSync, syncing, searchRef, onSelectAll, onMarkAllRead,
  importantView, aiAlerts, onEnableAlerts,
}) {
  const selecting = selection.size > 0;
  const allSelected = list.messages.length > 0 && list.messages.every((m) => selection.has(m.id));
  return (
    <section className="list-pane" aria-label={title}>
      <div className="list-search">
        <Search size={16} />
        <input ref={searchRef} dir="auto" value={search} onChange={(e) => onSearch(e.target.value)} placeholder={t('searchPlaceholder')} aria-label={t('search')} />
        {search && <button className="icon-button quiet tiny" onClick={() => onSearch('')} aria-label={t('clear')}><X size={14} /></button>}
      </div>
      {selecting ? (
        <div className="list-head bulk">
          <label className="select-all" title={t('selectAll')}>
            <input type="checkbox" checked={allSelected} onChange={() => (allSelected ? onClearSelection() : onSelectAll())} aria-label={t('selectAll')} />
          </label>
          <strong>{t('selectedCount', { n: selection.size })}</strong>
          <span className="bulk-actions">
            <button className="button ghost small" onClick={() => onBulk('read')}><MailOpen size={15} />{t('markRead')}</button>
            <button className="icon-button quiet" onClick={() => onBulk('unread')} title={t('markUnread')} aria-label={t('markUnread')}><Mail size={16} /></button>
            <button className="icon-button quiet" onClick={() => onBulk('archive')} title={t('archive')} aria-label={t('archive')}><Archive size={16} /></button>
            <button className="icon-button quiet" onClick={() => onBulk('trash')} title={t('delete')} aria-label={t('delete')}><Trash2 size={16} /></button>
            <button className="icon-button quiet" onClick={() => onBulk('flag')} title={t('flag')} aria-label={t('flag')}><Flag size={16} /></button>
            <button className="icon-button quiet" onClick={onClearSelection} title={t('clear')} aria-label={t('clear')}><X size={16} /></button>
          </span>
        </div>
      ) : (
        <div className="list-head">
          <div className="list-title">
            <h1 dir="auto">{title}</h1>
            <span>{search ? t('resultsCount', { n: list.total }) : t('conversationsCount', { n: list.total })}</span>
          </div>
          <button className="icon-button quiet" onClick={onSelectAll} disabled={!list.messages.length} title={t('selectMessages')} aria-label={t('selectMessages')}><ListChecks size={16} /></button>
          <button className="icon-button quiet" onClick={onMarkAllRead} title={t('markAllRead')} aria-label={t('markAllRead')}><CheckCheck size={16} /></button>
          <button className="icon-button quiet" onClick={onSync} title={t('syncNow')} aria-label={t('syncNow')}>{syncing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
        </div>
      )}
      {importantView && !aiAlerts && (
        <div className="ai-cta">
          <Sparkles size={16} />
          <span>{t('aiAlertsCta')}</span>
          <button className="button primary small" onClick={onEnableAlerts}>{t('aiAlertsEnable')}</button>
        </div>
      )}
      <div className="filters" role="tablist">
        {(importantView ? [] : FILTERS).map((key) => <button key={key} role="tab" aria-selected={filter === key} className={classNames(filter === key && 'on')} onClick={() => onFilter(key)}>{t(`filter_${key}`)}</button>)}
      </div>
      <div className="rows" role="listbox" aria-label={title}>
        {list.messages.map((message) => (
          <Row
            key={message.id}
            message={message}
            project={projectsById[message.projectId]}
            account={accountsById[message.accountId]}
            showAccount={showAccount}
            active={message.id === selectedId}
            selected={selection.has(message.id)}
            selecting={selecting}
            language={language}
            t={t}
            onOpen={onOpen}
            onToggle={onToggle}
            onAction={onAction}
          />
        ))}
        {list.total > list.messages.length && <button className="load-more" onClick={onLoadMore}>{t('loadMore')}</button>}
        {!list.messages.length && (
          <div className="list-empty">
            <Inbox size={30} strokeWidth={1.4} />
            <h3>{search ? t('noResults') : filter !== 'all' ? t('nothingMatches') : t('emptyFolder')}</h3>
            <p>{search ? t('noResultsHint') : t('emptyFolderHint')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
