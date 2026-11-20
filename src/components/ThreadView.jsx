import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlarmClock, Archive, BellRing, ChevronDown, Download, FileText, Flag, Forward, FolderInput, ImageOff, Languages, LoaderCircle, Mail, MailOpen, Paperclip, Reply, ReplyAll, ShieldAlert, ShieldCheck, Sparkles, Trash2,
} from 'lucide-react';
import { DeliveryBadge, TrustBadge } from './MessageList';
import AiPanel from './AiPanel';
import { FolderPicker } from './ContextMenu';
import { prepareEmailHtml, sanitizeForEditor } from '../emailHtml';
import { classNames, displayName, escapeHtml, formatFullDate, formatListDate, formatSize, initial, paragraphsToHtml, parseAddresses, senderHue, textToHtml } from '../lib/format';

function MessageFrame({ html, title }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    // Only a number is accepted, and only from this exact frame.
    const onMessage = (event) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const value = event.data?.emargyFrameHeight;
      if (!Number.isFinite(value)) return;
      setHeight(Math.min(Math.max(60, value + 4), 200_000));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // Opaque origin (no allow-same-origin): the email cannot reach the app. Its own scripts
  // are stripped and blocked by CSP; only the hash-allowed height reporter runs.
  return <iframe ref={ref} className="message-frame" title={title} style={{ height }} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={html} />;
}

function Avatar({ value, size = 36, pictures }) {
  const picture = pictures?.get(parseAddresses(value)[0]?.address?.toLowerCase());
  if (picture) return <img className="avatar has-picture" src={picture} width={size} height={size} alt="" aria-hidden="true" />;
  return <span className="avatar" style={{ '--hue': senderHue(value), width: size, height: size }} aria-hidden="true">{initial(value)}</span>;
}

function ThreadMessage({ message, pictures, t, language, expanded, onToggle, onTrustSender, onReply, onTranslate, onMoveToJunk, onNotSpam }) {
  const [showOnce, setShowOnce] = useState(false);
  const [details, setDetails] = useState(false);
  const content = message.content;
  const allowRemote = Boolean(message.imagesTrusted || showOnce);
  const prepared = useMemo(() => (expanded && content.html ? prepareEmailHtml(content.html, { allowRemote, inlineImages: content.inlineImages }) : null), [expanded, content, allowRemote]);
  const sender = parseAddresses(content.from)[0];

  if (!expanded) {
    return (
      <button className="thread-message collapsed" onClick={onToggle}>
        <Avatar value={content.from} size={30} pictures={pictures} />
        <strong dir="auto">{displayName(content.from)}</strong>
        <span className="collapsed-preview" dir="auto">{content.preview}</span>
        <time>{formatListDate(content.date, language)}</time>
      </button>
    );
  }
  return (
    <article className="thread-message">
      <header className="message-head">
        <Avatar value={content.from} pictures={pictures} />
        <div className="message-who">
          <button className="sender-line" onClick={onToggle}>
            <strong dir="auto">{sender?.name || sender?.address || content.from}</strong>
            {sender?.name && <span className="sender-address">{sender.address}</span>}
            <TrustBadge trust={message.trust} t={t} />
            {message.folderRole === 'sent' && <DeliveryBadge delivery={message.delivery} t={t} />}
          </button>
          <button className="recipients-line" onClick={() => setDetails(!details)} dir="auto">
            {t('toLabel')} {parseAddresses(content.to).map((a) => a.name || a.address).join(', ') || '—'}<ChevronDown size={13} />
          </button>
          {details && (
            <dl className="message-details">
              <dt>{t('from')}</dt><dd dir="auto">{content.from}</dd>
              <dt>{t('to')}</dt><dd dir="auto">{content.to}</dd>
              {content.cc && <><dt>{t('cc')}</dt><dd dir="auto">{content.cc}</dd></>}
              {content.replyTo && <><dt>{t('replyToLabel')}</dt><dd dir="auto">{content.replyTo}</dd></>}
              <dt>{t('date')}</dt><dd>{formatFullDate(content.date, language)}</dd>
            </dl>
          )}
        </div>
        <time className="message-time" title={formatFullDate(content.date, language)}>{formatListDate(content.date, language)}</time>
        <button className="icon-button quiet" onClick={() => onTranslate(message)} title={t('aiTranslate')} aria-label={t('aiTranslate')}><Languages size={16} /></button>
        <button className="icon-button quiet" onClick={() => onReply('reply', message)} title={t('reply')} aria-label={t('reply')}><Reply size={16} /></button>
      </header>
      {(['spam', 'suspicious'].includes(message.trust) || message.folderRole === 'junk') && (
        <div className={classNames('trust-warning', message.trust)} role="alert">
          <ShieldAlert size={17} />
          <span>{t(message.trust === 'suspicious' ? 'suspiciousWarning' : 'spamWarning')}</span>
          <button className="primary" onClick={() => onNotSpam(message)}><ShieldCheck size={14} />{t('notSpam')}</button>
          {onMoveToJunk && <button onClick={() => onMoveToJunk(message)}>{t('moveToJunk')}</button>}
        </div>
      )}
      {message.aiImportant && message.aiNote && !['spam', 'suspicious'].includes(message.trust) && (
        <div className="ai-note"><Sparkles size={15} /><strong>{t(`category_${message.aiNote.category}`)}</strong><span dir="auto">{message.aiNote.reason}</span></div>
      )}
      {prepared?.blockedCount > 0 && !allowRemote && (
        <div className="privacy-note">
          <ImageOff size={16} />
          <span>{t('imagesBlocked', { n: prepared.blockedCount })}</span>
          <button onClick={() => setShowOnce(true)}>{t('showImages')}</button>
          <button onClick={() => onTrustSender(content.fromAddress)}>{t('alwaysShowImages')}</button>
        </div>
      )}
      <div className="message-body">
        {prepared ? <MessageFrame html={prepared.srcDoc} title={content.subject} /> : <div className="plain-body" dir="auto">{content.text}</div>}
      </div>
      {!!content.attachments?.length && (
        <div className="attachment-strip">
          {content.attachments.map((attachment) => (
            <button key={attachment.index} className="file-pill" onClick={() => window.emargy.saveAttachment({ messageId: message.id, index: attachment.index })} title={t('download')}>
              <FileText size={15} /><span dir="auto">{attachment.filename}</span><small>{formatSize(attachment.size)}</small><Download size={14} />
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

export function buildReply(mode, message, account, t, language, prefill = '') {
  const content = message.content;
  const mine = (address) => account && address.toLowerCase() === account.email.toLowerCase();
  const others = (value) => parseAddresses(value).filter((a) => !mine(a.address)).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
  const original = sanitizeForEditor(content.html) || textToHtml(content.text);
  const subject = content.subject || '';
  if (mode === 'forward') {
    const header = [
      `<p>${escapeHtml(t('forwardedHeader'))}</p>`,
      `<p>${escapeHtml(t('from'))}: ${escapeHtml(content.from)}<br>${escapeHtml(t('date'))}: ${escapeHtml(formatFullDate(content.date, language))}<br>`
        + `${escapeHtml(t('subject'))}: ${escapeHtml(subject)}<br>${escapeHtml(t('to'))}: ${escapeHtml(content.to)}</p>`,
    ].join('');
    return {
      mode, accountId: message.accountId, subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
      html: `<p></p><div data-quote="true">${header}${original}</div>`, focusTo: true,
      forwardAttachments: content.attachments?.length ? message.id : null,
    };
  }
  const replyTarget = content.replyTo || content.from;
  const to = mode === 'replyAll' ? [...new Set([...others(replyTarget), ...others(content.to)])] : others(replyTarget);
  const cc = mode === 'replyAll' ? others(content.cc).filter((a) => !to.includes(a)) : [];
  const wrote = t('onWrote', { date: formatFullDate(content.date, language), from: displayName(content.from) });
  return {
    mode,
    accountId: message.accountId,
    to: (to.length ? to : parseAddresses(replyTarget).map((a) => a.address)).join(', '),
    cc: cc.join(', '),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: content.messageId,
    references: [content.references, content.messageId].filter(Boolean).join(' '),
    html: `${prefill ? paragraphsToHtml(prefill) : '<p></p>'}<div data-quote="true"><p>${escapeHtml(wrote)}</p><blockquote>${original}</blockquote></div>`,
    focusTo: false,
  };
}

function messageText(message) {
  const c = message.content;
  return `From: ${c.from}
Date: ${c.date}
Subject: ${c.subject || ''}

${c.text || ''}`;
}

export default function ThreadView({ t, language, thread, loading, project, account, folders, state, onAction, onSnooze, onRemind, onReply, onTrustSender, onToast, composer, empty }) {
  const [expanded, setExpanded] = useState(new Set());
  const [moveAt, setMoveAt] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);
  // Mail you sent shows the sending account's own picture.
  const pictures = useMemo(() => new Map((state?.accounts || []).filter((a) => a.picture).map((a) => [String(a.email).toLowerCase(), a.picture])), [state?.accounts]);
  const [job, setJob] = useState(null);
  const jobId = useRef(0);
  const bottomRef = useRef(null);
  const messages = thread?.messages || [];
  const last = messages[messages.length - 1];

  useEffect(() => {
    // Open the newest message and every unread one, like a real conversation view.
    setExpanded(new Set(messages.filter((m, i) => i === messages.length - 1 || !m.read).map((m) => m.id)));
    setMoveAt(null);
    setAiOpen(false);
    jobId.current += 1; // a late answer for the previous conversation is ignored
    if (job?.running) window.emargy.aiCancel();
    setJob(null);
  }, [thread]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (composer) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [composer]);

  if (loading) return <div className="pane-empty"><LoaderCircle className="spin" size={26} /></div>;
  if (!thread || !messages.length) {
    if (empty) return empty;
    return (
      <div className="pane-empty">
        <Mail size={34} strokeWidth={1.4} />
        <h2>{t('selectConversation')}</h2>
        <p>{t('selectConversationHint')}</p>
      </div>
    );
  }
  const ids = messages.map((m) => m.id);
  const runAi = async (task, title, text, target = language) => {
    setAiOpen(false);
    if (job?.running) return;
    const id = ++jobId.current;
    setJob({ task, title, running: true });
    try {
      const result = await window.emargy.aiRun({ task, text, language: target });
      if (id === jobId.current) setJob({ task, title, text: result.text, label: result.label });
    } catch (error) {
      const message = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (id === jobId.current) setJob(message === 'Cancelled.' ? null : { task, title, error: message });
    }
  };
  const conversation = () => messages.slice(-8).map(messageText).join('\n\n-----\n\n');
  // Only the message itself: headers would be translated too and get in the way.
  const translate = (message, target = language) => runAi('translate', t(target === 'ar' ? 'aiTranslateToArabic' : 'aiTranslateToEnglish'), message.content.text || message.content.subject || '', target);
  const cancelAi = () => { jobId.current += 1; setJob(null); window.emargy.aiCancel(); };
  const flagged = messages.some((m) => m.flagged);
  const inJunk = messages.every((m) => m.folderRole === 'junk');

  return (
    <div className="thread">
      <div className="thread-toolbar" role="toolbar">
        <button className="tool-text" onClick={() => onReply('reply', last)}><Reply size={16} />{t('reply')}</button>
        <button className="tool-text" onClick={() => onReply('replyAll', last)}><ReplyAll size={16} />{t('replyAll')}</button>
        <button className="tool-text" onClick={() => onReply('forward', last)}><Forward size={16} />{t('forward')}</button>
        <span className="tool-sep" />
        <span className="tool-menu">
          <button className={classNames('tool-text', 'ai-button', job?.running && 'busy')} onClick={() => setAiOpen(!aiOpen)} aria-expanded={aiOpen}>
            {job?.running ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{t('aiAssistant')}
          </button>
          {aiOpen && (
            <div className="menu">
              <button onClick={() => runAi('summarize', t('aiSummary'), conversation())}>{t('aiSummarize')}</button>
              <button onClick={() => runAi('reply', t('aiSuggestedReply'), conversation())}>{t('aiSuggestReply')}</button>
              <button onClick={() => translate(last, 'ar')}>{t('aiTranslateToArabic')}</button>
              <button onClick={() => translate(last, 'en')}>{t('aiTranslateToEnglish')}</button>
            </div>
          )}
        </span>
        <span className="tool-sep" />
        <button className="icon-button quiet" onClick={() => onAction('archive', ids)} title={`${t('archive')} (E)`} aria-label={t('archive')}><Archive size={17} /></button>
        <button className="icon-button quiet" onClick={() => onAction('trash', ids)} title={`${t('delete')} (Del)`} aria-label={t('delete')}><Trash2 size={17} /></button>
        <button className={classNames('icon-button quiet', flagged && 'flag-on')} onClick={() => onAction(flagged ? 'unflag' : 'flag', ids)} title={`${flagged ? t('unflag') : t('flag')} (S)`} aria-label={t('flag')}><Flag size={17} /></button>
        <button className="icon-button quiet" onClick={() => onAction('unread', ids)} title={`${t('markUnread')} (U)`} aria-label={t('markUnread')}><MailOpen size={17} /></button>
        {onSnooze && messages.some((m) => m.folderRole === 'inbox') && (
          <button className="icon-button quiet" onClick={() => onSnooze(last)} title={`${t('snooze')} (B)`} aria-label={t('snooze')}><AlarmClock size={17} /></button>
        )}
        {onRemind && (
          <span className="tool-menu">
            <button className="icon-button quiet" onClick={() => setRemindOpen(!remindOpen)} title={t('remindIfNoReply')} aria-label={t('remindIfNoReply')} aria-expanded={remindOpen}><BellRing size={17} /></button>
            {remindOpen && (
              <div className="menu">
                <span className="menu-note">{t('remindIfNoReply')}</span>
                {[1, 3, 5, 7, 14].map((n) => <button key={n} onClick={() => { setRemindOpen(false); onRemind(last.id, n); }}>{t('afterDays', { n })}</button>)}
              </div>
            )}
          </span>
        )}
        <button className="icon-button quiet" onClick={(e) => { const box = e.currentTarget.getBoundingClientRect(); setMoveAt(moveAt ? null : { x: box.left, y: box.bottom + 4 }); }} title={t('moveTo')} aria-label={t('moveTo')}><FolderInput size={17} /></button>
        <button className={classNames('icon-button quiet', inJunk && 'flag-on')} onClick={() => onAction(inJunk ? 'notSpam' : 'spam', ids)} title={inJunk ? t('notSpam') : t('reportSpam')} aria-label={inJunk ? t('notSpam') : t('reportSpam')}>{inJunk ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}</button>
        {moveAt && state && (
          <FolderPicker x={moveAt.x} y={moveAt.y} t={t} state={state} currentFolderIds={[...new Set(messages.map((m) => m.folderId))]} onClose={() => setMoveAt(null)} onPick={(folderId) => onAction('move', ids, folderId)} />
        )}
      </div>
      <div className="thread-scroll">
        <header className="thread-head">
          <h1 dir="auto">{last.content.subject || t('noSubject')}</h1>
          <div className="thread-meta">
            {project && <span className="project-tag" style={{ '--project': project.color }}>{project.name}</span>}
            {account && <span className="account-tag">{account.email}</span>}
            {messages.length > 1 && <span className="count-tag">{t('messagesInThread', { n: messages.length })}</span>}
            {messages.some((m) => m.hasAttachments) && <Paperclip size={14} className="muted-icon" />}
          </div>
        </header>
        <AiPanel t={t} job={job} onToast={onToast} onClose={() => setJob(null)} onCancel={cancelAi} onUseReply={(text) => { onReply('reply', last, { prefill: text }); setJob(null); }} />
        <div className="thread-messages">
          {messages.map((message) => (
            <ThreadMessage
              key={message.id}
              message={message}
              pictures={pictures}
              t={t}
              language={language}
              expanded={expanded.has(message.id)}
              onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}
              onTrustSender={onTrustSender}
              onReply={onReply}
              onTranslate={(m) => translate(m)}
              onNotSpam={(m) => onAction('notSpam', [m.id])}
              onMoveToJunk={(() => {
                const junk = folders.find((f) => f.accountId === message.accountId && f.role === 'junk');
                return junk && message.folderId !== junk.id ? () => onAction('move', [message.id], junk.id) : null;
              })()}
            />
          ))}
        </div>
        {composer}
        {!composer && (
          <div className="quick-reply">
            <button onClick={() => onReply('reply', last)}><Reply size={16} />{t('reply')}</button>
            <button onClick={() => onReply('replyAll', last)}><ReplyAll size={16} />{t('replyAll')}</button>
            <button onClick={() => onReply('forward', last)}><Forward size={16} />{t('forward')}</button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
