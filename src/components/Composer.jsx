import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, LoaderCircle, Paperclip, Send, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import RichEditor, { setSignature } from './RichEditor';
import RecipientInput from './RecipientInput';
import Modal from './Modal';
import { classNames, formatSize, paragraphsToHtml, parseAddresses } from '../lib/format';

const api = window.emargy;
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function signatureFor(account, signatures, mode) {
  const id = mode === 'new' ? account?.signatureNew : account?.signatureReply;
  return signatures.find((s) => s.id === id) || null;
}

export default function Composer({ t, accounts, signatures, settings, initial, inline = false, onClose, onSent, onToast }) {
  const mode = initial?.mode || 'new';
  const [fields, setFields] = useState(() => ({
    accountId: initial?.accountId || accounts[0]?.id || '',
    to: initial?.to || '', cc: initial?.cc || '', bcc: initial?.bcc || '', subject: initial?.subject || '',
    inReplyTo: initial?.inReplyTo || '', references: initial?.references || '',
  }));
  const [attachments, setAttachments] = useState(initial?.attachments || []);
  const [showCopies, setShowCopies] = useState(Boolean(initial?.cc || initial?.bcc));
  const [draftId, setDraftId] = useState(initial?.id || null);
  const [saveState, setSaveState] = useState(initial?.id ? 'saved' : 'idle');
  const [signatureId, setSignatureId] = useState(() => signatureFor(accounts.find((a) => a.id === (initial?.accountId || accounts[0]?.id)), signatures, mode)?.id || '');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sigMenu, setSigMenu] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const editorRef = useRef(null);
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const htmlRef = useRef(initial?.html || '');
  const textRef = useRef('');
  const account = accounts.find((a) => a.id === fields.accountId);

  const snapshot = useCallback(() => ({
    ...fields, id: draftId || undefined, attachments, html: htmlRef.current, body: textRef.current,
  }), [fields, draftId, attachments]);
  // Closing the composer any way (switching message, changing view) never loses work.
  const latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => () => {
    if (dirty.current && latest.current().accountId) api.saveDraft(latest.current()).catch(() => {});
  }, []);

  const saveDraft = useCallback(async () => {
    if (!dirty.current || !fields.accountId) return draftId;
    dirty.current = false;
    setSaveState('saving');
    try {
      const result = await api.saveDraft(snapshot());
      setDraftId(result.draft.id);
      setSaveState('saved');
      return result.draft.id;
    } catch (error) {
      setSaveState('idle');
      onToast(errorText(error), 'error');
      return draftId;
    }
  }, [fields.accountId, draftId, snapshot, onToast]);

  const touch = () => {
    dirty.current = true;
    setSaveState('pending');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveDraft(), 2500);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    if (!initial?.forwardAttachments) return;
    api.forwardAttachments(initial.forwardAttachments).then((files) => setAttachments((current) => [...current, ...files])).catch((error) => onToast(errorText(error), 'error'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key, value) => { setFields((current) => ({ ...current, [key]: value })); touch(); };

  const onReady = (editor) => {
    editorRef.current = editor;
    let hasSignature = false;
    editor.state.doc.forEach((node) => { if (node.type.name === 'signatureBlock') hasSignature = true; });
    if (!initial?.id && !hasSignature) {
      const signature = signatureFor(account, signatures, mode);
      if (signature) setSignature(editor, signature.html);
    }
    // Inserting the signature is not an edit: an untouched reply is not kept as a draft.
    htmlRef.current = editor.getHTML();
    textRef.current = editor.getText({ blockSeparator: '\n' });
    clearTimeout(saveTimer.current);
    dirty.current = false;
    setSaveState(initial?.id ? 'saved' : 'idle');
    if (!initial?.focusTo) editor.commands.focus('start');
  };

  const changeAccount = (accountId) => {
    const next = accounts.find((a) => a.id === accountId);
    const signature = signatureFor(next, signatures, mode);
    setSignatureId(signature?.id || '');
    setSignature(editorRef.current, signature?.html || '');
    set('accountId', accountId);
  };

  const chooseSignature = (id) => {
    setSignatureId(id);
    setSignature(editorRef.current, signatures.find((s) => s.id === id)?.html || '');
    setSigMenu(false);
    touch();
  };

  // Works on the selection, or on what the writer typed (above the signature and the quote).
  const writeWithAi = async (task, target = 'en') => {
    setAiMenu(false);
    const editor = editorRef.current;
    if (!editor || aiBusy) return;
    let { from, to, empty } = editor.state.selection;
    if (empty) {
      let end = null;
      editor.state.doc.forEach((node, offset) => {
        if (end === null && ['signatureBlock', 'quoteBlock'].includes(node.type.name)) end = offset;
      });
      from = 0;
      to = end ?? editor.state.doc.content.size;
    }
    const text = editor.state.doc.textBetween(from, to, '\n\n').trim();
    if (!text) return onToast(t('aiWriteFirst'), 'error');
    setAiBusy(true);
    editor.setEditable(false);
    try {
      const result = await api.aiRun({ task, text, language: target });
      editor.setEditable(true);
      editor.chain().focus().insertContentAt({ from, to }, paragraphsToHtml(result.text)).run();
      onToast(t('aiDone', { name: result.label }));
    } catch (error) {
      const message = errorText(error);
      if (message !== 'Cancelled.') onToast(message, 'error');
    } finally {
      editor.setEditable(true);
      setAiBusy(false);
    }
  };

  const addFiles = async () => {
    try {
      const files = await api.pickFiles();
      if (files.length) { setAttachments((current) => [...current, ...files]); touch(); }
    } catch (error) {
      onToast(errorText(error), 'error');
    }
  };

  const recipients = parseAddresses([fields.to, fields.cc, fields.bcc].join(','));
  const send = async () => {
    if (!recipients.length) return onToast(t('addRecipient'), 'error');
    if (settings.confirmBeforeSend && !confirming) return setConfirming(true);
    clearTimeout(saveTimer.current);
    setSending(true);
    try {
      const result = await api.send(snapshot());
      dirty.current = false; // sent: closing must not re-create the draft
      onSent(result);
    } catch (error) {
      onToast(errorText(error), 'error');
      setSending(false);
      setConfirming(false);
    }
  };

  const close = async () => {
    clearTimeout(saveTimer.current);
    const changed = dirty.current;
    await saveDraft();
    if (changed) onToast(t('draftSaved'));
    onClose();
  };

  const discard = async () => {
    clearTimeout(saveTimer.current);
    dirty.current = false;
    if (draftId) await api.deleteDraft(draftId).catch(() => {});
    onClose();
  };

  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); send(); }
    if (event.key === 'Escape' && !confirming) { event.preventDefault(); close(); }
  };

  const totalSize = attachments.reduce((sum, f) => sum + (f.size || 0), 0);
  const title = { new: t('newMessage'), reply: t('reply'), replyAll: t('replyAll'), forward: t('forward') }[mode];

  return (
    <section className={classNames('composer', inline && 'inline')} onKeyDown={onKeyDown} aria-label={title}>
      <header className="composer-head">
        <h2>{title}</h2>
        <span className={classNames('save-state', saveState)}>{{ saving: t('saving'), saved: t('draftSaved'), pending: '', idle: '' }[saveState]}</span>
        <button className="icon-button quiet" onClick={close} title={t('closeAndSave')} aria-label={t('closeAndSave')}><X size={18} /></button>
      </header>
      <div className="composer-fields">
        <label className="field-row">
          <span className="field-label">{t('from')}</span>
          <select dir="auto" value={fields.accountId} onChange={(e) => changeAccount(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} — ${a.email}` : a.email}</option>)}
          </select>
        </label>
        <div className="field-row-wrap">
          <RecipientInput t={t} label={t('to')} value={fields.to} onChange={(v) => set('to', v)} autoFocus={initial?.focusTo ?? !fields.to} />
          {!showCopies && <button type="button" className="link-button" onClick={() => setShowCopies(true)}>{t('ccBcc')}</button>}
        </div>
        {showCopies && <RecipientInput t={t} label={t('cc')} value={fields.cc} onChange={(v) => set('cc', v)} />}
        {showCopies && <RecipientInput t={t} label={t('bcc')} value={fields.bcc} onChange={(v) => set('bcc', v)} />}
        <label className="field-row">
          <span className="field-label">{t('subject')}</span>
          <input dir="auto" value={fields.subject} onChange={(e) => set('subject', e.target.value)} />
        </label>
      </div>
      <RichEditor
        t={t}
        content={initial?.html || '<p></p>'}
        onChange={(html, editor) => { htmlRef.current = html; textRef.current = editor.getText({ blockSeparator: '\n' }); touch(); }}
        onReady={onReady}
        placeholder={t('writeMessage')}
        onError={(m) => onToast(m, 'error')}
      />
      {!!attachments.length && (
        <div className="attachment-strip">
          {attachments.map((file, index) => (
            <span key={`${file.filename}-${index}`} className="file-pill">
              <Paperclip size={14} /><span dir="auto">{file.filename}</span><small>{formatSize(file.size)}</small>
              <button type="button" onClick={() => { setAttachments(attachments.filter((_, i) => i !== index)); touch(); }} aria-label={t('remove')}><X size={13} /></button>
            </span>
          ))}
          <small className="muted">{formatSize(totalSize)} / 25 MB</small>
        </div>
      )}
      <footer className="composer-foot">
        <button className="button primary" onClick={send} disabled={sending || !fields.accountId}>
          {sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{t('send')}
        </button>
        <button className="button ghost" onClick={addFiles}><Paperclip size={16} />{t('attach')}</button>
        <span className="tool-menu">
          <button className="button ghost" onClick={() => setSigMenu(!sigMenu)}>{signatures.find((s) => s.id === signatureId)?.name || t('noSignature')}<ChevronDown size={14} /></button>
          {sigMenu && (
            <div className="menu up">
              <button onClick={() => chooseSignature('')}>{t('noSignature')}</button>
              {signatures.map((s) => <button key={s.id} className={classNames(s.id === signatureId && 'checked')} onClick={() => chooseSignature(s.id)}>{s.name}</button>)}
              {!signatures.length && <span className="menu-note">{t('createSignatureHint')}</span>}
            </div>
          )}
        </span>
        <span className="tool-menu">
          <button className={classNames('button ghost', 'ai-button')} onClick={() => (aiBusy ? api.aiCancel() : setAiMenu(!aiMenu))} title={aiBusy ? t('cancel') : t('aiWritingHelp')} aria-expanded={aiMenu}>
            {aiBusy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{aiBusy ? t('aiWorking') : t('aiAssistant')}
          </button>
          {aiMenu && (
            <div className="menu up">
              <button onClick={() => writeWithAi('improve')}>{t('aiImprove')}</button>
              <button onClick={() => writeWithAi('translateDraft', 'ar')}>{t('aiTranslateToArabic')}</button>
              <button onClick={() => writeWithAi('translateDraft', 'en')}>{t('aiTranslateToEnglish')}</button>
              <span className="menu-note">{t('aiSelectionHint')}</span>
            </div>
          )}
        </span>
        <span className="foot-hint">{t('sendShortcut')}</span>
        <button className="icon-button quiet danger" onClick={discard} title={t('discard')} aria-label={t('discard')}><Trash2 size={17} /></button>
      </footer>
      {confirming && (
        <Modal title={t('confirmSendTitle')} onClose={() => setConfirming(false)} width="560px">
          <div className="modal-body confirm-send">
            <ShieldCheck size={26} className="confirm-icon" />
            <dl>
              <dt>{t('from')}</dt><dd>{account?.email}</dd>
              <dt>{t('to')}</dt><dd dir="auto">{[fields.to, fields.cc, fields.bcc].filter(Boolean).join(', ')}</dd>
              <dt>{t('subject')}</dt><dd dir="auto">{fields.subject || t('noSubject')}</dd>
              {!!attachments.length && <><dt>{t('attachments')}</dt><dd>{attachments.length}</dd></>}
            </dl>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setConfirming(false)}>{t('keepEditing')}</button>
              <button className="button primary" autoFocus onClick={send} disabled={sending}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{t('send')}</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
