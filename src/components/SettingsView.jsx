import { useEffect, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import RichEditor from './RichEditor';
import AccountSetup, { ColorPicker, PROJECT_COLORS } from './AccountSetup';
import Modal from './Modal';
import { classNames } from '../lib/format';

const api = window.emargy;
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const TABS = ['general', 'accounts', 'signatures', 'projects', 'security'];

function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="setting-toggle">
      <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div className="setting-row">
      <strong>{label}</strong>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([key, text]) => <button key={key} role="radio" aria-checked={value === key} className={classNames(value === key && 'on')} onClick={() => onChange(key)}>{text}</button>)}
      </div>
    </div>
  );
}

function General({ t, state, setState, language }) {
  const s = state.settings;
  const update = async (changes) => setState(await api.updateSettings(changes));
  return (
    <div className="settings-section">
      <Segmented label={t('language')} value={language} options={[['ar', 'العربية'], ['en', 'English']]} onChange={async (v) => setState(await api.setLanguage(v))} />
      <Segmented label={t('theme')} value={s.theme} options={[['system', t('themeSystem')], ['light', t('themeLight')], ['dark', t('themeDark')]]} onChange={(v) => update({ theme: v })} />
      <Segmented label={t('density')} value={s.density} options={[['comfortable', t('densityComfortable')], ['compact', t('densityCompact')]]} onChange={(v) => update({ density: v })} />
      <div className="setting-row">
        <span><strong>{t('undoSend')}</strong><small>{t('undoSendHint')}</small></span>
        <select value={s.undoSeconds} onChange={(e) => update({ undoSeconds: Number(e.target.value) })}>
          {[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n ? t('seconds', { n }) : t('off')}</option>)}
        </select>
      </div>
      <Toggle label={t('confirmBeforeSend')} hint={t('confirmBeforeSendHint')} checked={s.confirmBeforeSend} onChange={(v) => update({ confirmBeforeSend: v })} />
      <Toggle label={t('markReadOnOpen')} checked={s.markReadOnOpen} onChange={(v) => update({ markReadOnOpen: v })} />
      <Toggle label={t('notifications')} hint={t('notificationsHint')} checked={s.notifications} onChange={(v) => update({ notifications: v })} />
    </div>
  );
}

function AccountCard({ t, account, state, setState, onToast, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const [form, setForm] = useState({ displayName: account.displayName || '', projectId: account.projectId, signatureNew: account.signatureNew || '', signatureReply: account.signatureReply || '', password: '' });
  const [busy, setBusy] = useState(false);
  const status = account.sync?.status || 'idle';
  const project = state.projects.find((p) => p.id === account.projectId);
  const save = async () => {
    setBusy(true);
    try {
      setState(await api.updateAccount(account.id, { ...form, password: form.password || undefined }));
      setForm((f) => ({ ...f, password: '' }));
      onToast(t('saved'));
    } catch (error) {
      onToast(errorText(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t('deleteAccountConfirm'))) return;
    setState(await api.deleteAccount(account.id));
  };
  return (
    <article className={classNames('settings-card', 'collapsible', open && 'open')}>
      <header>
        <button className="card-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={classNames('status-dot', `s-${status}`)} />
          <span className="card-title"><strong dir="auto">{account.displayName || account.email}</strong><small>{account.email} · {account.imapHost}</small></span>
          {project && <span className="project-tag" style={{ '--project': project.color }}>{project.name}</span>}
          <ChevronDown size={16} className="card-chevron" />
        </button>
        <button className="icon-button quiet" onClick={() => api.syncAccount(account.id).then(setState).catch((e) => onToast(errorText(e), 'error'))} title={t('syncNow')} aria-label={t('syncNow')}><RefreshCw size={15} /></button>
      </header>
      {account.sync?.error && <p className="form-error">{account.sync.error}</p>}
      {open && (<>
      <div className="card-grid">
        <label className="field"><span>{t('yourName')}</span><input dir="auto" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        <label className="field"><span>{t('project')}</span><select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span>{t('signatureNew')}</span><select value={form.signatureNew} onChange={(e) => setForm({ ...form, signatureNew: e.target.value })}><option value="">{t('noSignature')}</option>{state.signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>{t('signatureReply')}</span><select value={form.signatureReply} onChange={(e) => setForm({ ...form, signatureReply: e.target.value })}><option value="">{t('noSignature')}</option>{state.signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field wide"><span>{t('changePassword')}</span><input type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={t('changePasswordHint')} /></label>
      </div>
      <footer>
        <button className="button ghost danger-text" onClick={remove}><Trash2 size={15} />{t('deleteAccount')}</button>
        <button className="button primary" onClick={save} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{t('saveChanges')}</button>
      </footer>
      </>)}
    </article>
  );
}

function Signatures({ t, state, setState, onToast }) {
  const [editing, setEditing] = useState(null);
  const [html, setHtml] = useState('');
  useEffect(() => { if (editing) setHtml(editing.html || ''); }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    try {
      setState(await api.saveSignature({ id: editing.id, name: editing.name, html }));
      onToast(t('saved'));
      setEditing(null);
    } catch (error) {
      onToast(errorText(error), 'error');
    }
  };
  return (
    <div className="settings-section">
      <p className="section-hint">{t('signaturesHint')}</p>
      <div className="signature-list">
        {state.signatures.map((signature) => (
          <div key={signature.id} className={classNames('signature-item', editing?.id === signature.id && 'on')}>
            <button onClick={() => setEditing({ ...signature })} dir="auto">{signature.name}</button>
            <button className="icon-button quiet" onClick={async () => setState(await api.deleteSignature(signature.id))} aria-label={t('delete')}><Trash2 size={15} /></button>
          </div>
        ))}
        <button className="button ghost" onClick={() => setEditing({ name: t('signatureDefaultName'), html: '' })}><Plus size={15} />{t('newSignature')}</button>
      </div>
      {editing && (
        <div className="signature-editor">
          <label className="field"><span>{t('signatureName')}</span><input dir="auto" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          <RichEditor key={editing.id || 'new'} t={t} compact content={editing.html || '<p></p>'} onChange={setHtml} placeholder={t('signaturePlaceholder')} onError={(m) => onToast(m, 'error')} />
          <div className="setup-actions">
            <button className="button ghost" onClick={() => setEditing(null)}>{t('cancel')}</button>
            <button className="button primary" onClick={save}><Check size={15} />{t('saveSignature')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Projects({ t, state, setState, onToast }) {
  const [project, setProject] = useState({ name: '', color: PROJECT_COLORS[1] });
  const add = async (event) => {
    event.preventDefault();
    try {
      setState(await api.createProject(project));
      setProject({ name: '', color: PROJECT_COLORS[(state.projects.length + 2) % PROJECT_COLORS.length] });
    } catch (error) {
      onToast(errorText(error), 'error');
    }
  };
  return (
    <div className="settings-section">
      {state.projects.map((p) => {
        const count = state.accounts.filter((a) => a.projectId === p.id).length;
        return (
          <div key={p.id} className="project-line" style={{ '--project': p.color }}>
            <span className="project-swatch" />
            <strong dir="auto">{p.name}</strong>
            <small>{t('accountsCount', { n: count })}</small>
            <button className="icon-button quiet" disabled={count > 0} title={count ? t('deleteProjectBlocked') : t('delete')} onClick={async () => setState(await api.deleteProject(p.id))}><Trash2 size={15} /></button>
          </div>
        );
      })}
      <form className="project-add" onSubmit={add}>
        <input dir="auto" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} placeholder={t('projectNameExample')} />
        <ColorPicker t={t} value={project.color} onChange={(color) => setProject({ ...project, color })} />
        <button className="button primary" disabled={!project.name.trim()}><Plus size={15} />{t('addProject')}</button>
      </form>
    </div>
  );
}

function Security({ t, onView }) {
  return (
    <div className="settings-section">
      <ul className="security-list">
        {['sec1', 'sec2', 'sec3', 'sec4', 'sec5', 'sec6', 'sec7'].map((key) => <li key={key}><ShieldCheck size={16} />{t(key)}</li>)}
      </ul>
      <p className="section-hint">{t('dataLocation')}</p>
      <button className="button ghost" onClick={() => onView('activity')}>{t('openActivity')}</button>
    </div>
  );
}

export default function SettingsView({ t, state, setState, language, onToast, onView, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);
  const [adding, setAdding] = useState(false);
  return (
    <div className="page">
      <header className="page-head"><h1>{t('settings')}</h1></header>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist">
          {TABS.map((key) => <button key={key} role="tab" aria-selected={tab === key} className={classNames(tab === key && 'on')} onClick={() => setTab(key)}>{t(`tab_${key}`)}</button>)}
        </div>
        <div className="settings-panel">
          {tab === 'general' && <General t={t} state={state} setState={setState} language={language} />}
          {tab === 'accounts' && (
            <div className="settings-section">
              {state.accounts.map((account) => <AccountCard key={account.id} t={t} account={account} state={state} setState={setState} onToast={onToast} defaultOpen={state.accounts.length === 1} />)}
              <button className="button primary" onClick={() => setAdding(true)}><Plus size={15} />{t('addAccount')}</button>
            </div>
          )}
          {tab === 'signatures' && <Signatures t={t} state={state} setState={setState} onToast={onToast} />}
          {tab === 'projects' && <Projects t={t} state={state} setState={setState} onToast={onToast} />}
          {tab === 'security' && <Security t={t} onView={onView} />}
        </div>
      </div>
      {adding && (
        <Modal title={t('addAccount')} onClose={() => setAdding(false)} width="560px">
          <div className="modal-body"><AccountSetup t={t} projects={state.projects} onCancel={() => setAdding(false)} onDone={(next) => { setState(next); setAdding(false); }} /></div>
        </Modal>
      )}
    </div>
  );
}
