import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ChevronDown, Download, FileText, Flag, Forward, FolderInput, ImageOff, LoaderCircle, Mail, MailOpen, Paperclip, Reply, ReplyAll, Trash2,
} from 'lucide-react';
import { prepareEmailHtml, sanitizeForEditor } from '../emailHtml';
import { classNames, displayName, escapeHtml, formatFullDate, formatListDate, formatSize, initial, parseAddresses, senderHue, textToHtml } from '../lib/format';

function MessageFrame({ html, title }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    let observer;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      setHeight(Math.max(80, doc.documentElement.scrollHeight + 4));
      if (!observer) {
        observer = new ResizeObserver(() => setHeight(Math.max(80, doc.documentElement.scrollHeight + 4)));
        observer.observe(doc.body);
      }
    };
    frame.addEventListener('load', measure);
    measure();
    return () => { frame.removeEventListener('load', measure); observer?.disconnect(); };
  }, [html]);
  // Scripts never run (no allow-scripts). Same-origin only lets the app measure the height.
  return <iframe ref={ref} className="message-frame" title={title} style={{ height }} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={html} />;
}

function Avatar({ value, size = 36 }) {
  return <span className="avatar" style={{ '--hue': senderHue(value), width: size, height: size }} aria-hidden="true">{initial(value)}</span>;
}

function ThreadMessage({ message, t, language, expanded, onToggle, onTrustSender, onReply }) {
  const [showOnce, setShowOnce] = useState(false);
  const [details, setDetails] = useState(false);
  const content = message.content;
  const allowRemote = Boolean(message.imagesTrusted || showOnce);
  const prepared = useMemo(() => (expanded && content.html ? prepareEmailHtml(content.html, { allowRemote, inlineImages: content.inlineImages }) : null), [expanded, content, allowRemote]);
  const sender = parseAddresses(content.from)[0];

  if (!expanded) {
    return (
      <button className="thread-message collapsed" onClick={onToggle}>
        <Avatar value={content.from} size={30} />
        <strong dir="auto">{displayName(content.from)}</strong>
        <span className="collapsed-preview" dir="auto">{content.preview}</span>
        <time>{formatListDate(content.date, language)}</time>
      </button>
    );
  }
  return (
    <article className="thread-message">
      <header className="message-head">
        <Avatar value={content.from} />
        <div className="message-who">
          <button className="sender-line" onClick={onToggle}>
            <strong dir="auto">{sender?.name || sender?.address || content.from}</strong>
            {sender?.name && <span className="sender-address">{sender.address}</span>}
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
        <button className="icon-button quiet" onClick={() => onReply('reply', message)} title={t('reply')} aria-label={t('reply')}><Reply size={16} /></button>
      </header>
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

export function buildReply(mode, message, account, t, language) {
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
    html: `<p></p><div data-quote="true"><p>${escapeHtml(wrote)}</p><blockquote>${original}</blockquote></div>`,
    focusTo: false,
  };
}

export default function ThreadView({ t, language, thread, loading, project, account, folders, onAction, onReply, onTrustSender, composer }) {
  const [expanded, setExpanded] = useState(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const bottomRef = useRef(null);
  const messages = thread?.messages || [];
  const last = messages[messages.length - 1];

  useEffect(() => {
    // Open the newest message and every unread one, like a real conversation view.
    setExpanded(new Set(messages.filter((m, i) => i === messages.length - 1 || !m.read).map((m) => m.id)));
    setMoveOpen(false);
  }, [thread]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (composer) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [composer]);

  if (loading) return <div className="pane-empty"><LoaderCircle className="spin" size={26} /></div>;
  if (!thread || !messages.length) {
    return (
      <div className="pane-empty">
        <Mail size={34} strokeWidth={1.4} />
        <h2>{t('selectConversation')}</h2>
        <p>{t('selectConversationHint')}</p>
      </div>
    );
  }
  const ids = messages.map((m) => m.id);
  const flagged = messages.some((m) => m.flagged);
  const moveTargets = folders.filter((f) => f.accountId === last.accountId && f.id !== last.folderId);

  return (
    <div className="thread">
      <div className="thread-toolbar" role="toolbar">
        <button className="tool-text" onClick={() => onReply('reply', last)}><Reply size={16} />{t('reply')}</button>
        <button className="tool-text" onClick={() => onReply('replyAll', last)}><ReplyAll size={16} />{t('replyAll')}</button>
        <button className="tool-text" onClick={() => onReply('forward', last)}><Forward size={16} />{t('forward')}</button>
        <span className="tool-sep" />
        <button className="icon-button quiet" onClick={() => onAction('archive', ids)} title={`${t('archive')} (E)`} aria-label={t('archive')}><Archive size={17} /></button>
        <button className="icon-button quiet" onClick={() => onAction('trash', ids)} title={`${t('delete')} (Del)`} aria-label={t('delete')}><Trash2 size={17} /></button>
        <button className={classNames('icon-button quiet', flagged && 'flag-on')} onClick={() => onAction(flagged ? 'unflag' : 'flag', ids)} title={`${flagged ? t('unflag') : t('flag')} (S)`} aria-label={t('flag')}><Flag size={17} /></button>
        <button className="icon-button quiet" onClick={() => onAction('unread', ids)} title={`${t('markUnread')} (U)`} aria-label={t('markUnread')}><MailOpen size={17} /></button>
        <span className="tool-menu">
          <button className="icon-button quiet" onClick={() => setMoveOpen(!moveOpen)} title={t('moveTo')} aria-label={t('moveTo')}><FolderInput size={17} /></button>
          {moveOpen && (
            <div className="menu">
              {moveTargets.map((folder) => <button key={folder.id} onClick={() => { setMoveOpen(false); onAction('move', ids, folder.id); }}>{t(`folder_${folder.role}`, null, folder.name)}</button>)}
            </div>
          )}
        </span>
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
        <div className="thread-messages">
          {messages.map((message) => (
            <ThreadMessage
              key={message.id}
              message={message}
              t={t}
              language={language}
              expanded={expanded.has(message.id)}
              onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}
              onTrustSender={onTrustSender}
              onReply={onReply}
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
