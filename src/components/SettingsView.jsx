import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { SceneArt } from './EmptyScene';
import RichEditor from './RichEditor';
import { ColorPicker, PROJECT_COLORS } from './AccountSetup';
import { classNames } from '../lib/format';

const api = window.emargy;
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const TABS = ['general', 'notifications', 'appearance', 'accounts', 'signatures', 'projects', 'security'];

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

function UpdateSetting({ t, enabled, onChange }) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    api.updateStatus().then(setStatus).catch(() => {});
    return api.onUpdateStatus(setStatus);
  }, []);
  const label = status && {
    checking: t('updateChecking'),
    current: t('updateCurrent'),
    downloading: t('updateDownloading', { version: status.version }),
    ready: t('updateReady', { version: status.version }),
    available: t('updateAvailable', { version: status.version }),
    error: t('updateError', { error: status.error }),
  }[status.state];
  if (status?.state === 'store') {
    return (
      <div className="setting-row">
        <span><strong>{t('version', { version: status.currentVersion || '' })}</strong><small>{t('updateFromStore')}</small></span>
        <button className="button ghost" onClick={() => api.openHelp('storePage')}>{t('openInStore')}</button>
      </div>
    );
  }
  return (
    <>
      <Toggle label={t('autoUpdate')} hint={t('autoUpdateHint')} checked={enabled} onChange={onChange} />
      <div className="setting-row">
        <span><strong>{t('version', { version: status?.currentVersion || '' })}</strong>{label && <small>{label}</small>}</span>
        {status?.state === 'ready'
          ? <button className="button primary" onClick={() => api.installUpdate()}>{t('updateRestart')}</button>
          : <button className="button ghost" disabled={status?.state === 'checking' || status?.state === 'downloading'} onClick={() => api.checkForUpdate().then(setStatus)}>{t('updateCheckNow')}</button>}
      </div>
    </>
  );
}

function AiSetting({ t, value, onChange }) {
  const [tools, setTools] = useState([]);
  useEffect(() => { api.aiStatus().then(setTools).catch(() => setTools([])); }, []);
  const installed = tools.filter((tool) => tool.available);
  return (
    <div className="setting-row">
      <span>
        <strong>{t('aiAssistant')}</strong>
        <small>{t('aiSettingHint')}</small>
        <small>{installed.length ? t('aiInstalled', { names: installed.map((tool) => tool.label).join('، ') }) : t('aiNoneInstalled')}</small>
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('aiAssistant')}>
        <option value="auto">{t('aiAuto')}</option>
        {tools.map((tool) => <option key={tool.id} value={tool.id} disabled={!tool.available}>{tool.available ? tool.label : `${tool.label} — ${t('aiNotInstalled')}`}</option>)}
        <option value="off">{t('off')}</option>
      </select>
    </div>
  );
}

function Notifications({ t, state, setState }) {
  const s = state.settings;
  const update = async (changes) => setState(await api.updateSettings(changes));
  const quiet = s.quietHours || { enabled: false, from: '22:00', to: '07:00' };
  const muted = new Set(s.mutedProjects || []);
  const toggleProject = (id) => {
    const next = new Set(muted);
    if (next.has(id)) next.delete(id); else next.add(id);
    update({ mutedProjects: [...next] });
  };
  return (
    <div className="settings-section">
      <Segmented label={t('notifyMode')} value={s.notifyMode || 'all'} options={[['all', t('notifyAll')], ['important', t('notifyImportant')], ['off', t('off')]]} onChange={(v) => update({ notifyMode: v })} />
      <p className="setting-note">{t('notifyModeHint')}</p>
      <Toggle label={t('notifyPreview')} hint={t('notifyPreviewHint')} checked={s.notifyPreview !== false} onChange={(v) => update({ notifyPreview: v })} />
      <Toggle label={t('notifySound')} checked={s.notifySound !== false} onChange={(v) => update({ notifySound: v })} />
      <Toggle label={t('taskbarBadge')} hint={t('taskbarBadgeHint')} checked={s.taskbarBadge !== false} onChange={(v) => update({ taskbarBadge: v })} />
      {s.inboxTabs !== false && <Toggle label={t('notifyPrimaryOnly')} hint={t('notifyPrimaryOnlyHint')} checked={Boolean(s.notifyPrimaryOnly)} onChange={(v) => update({ notifyPrimaryOnly: v })} />}
      <div className="setting-row quiet-hours">
        <span><strong>{t('quietHours')}</strong><small>{t('quietHoursHint')}</small></span>
        <span className="quiet-controls">
          <input type="checkbox" role="switch" aria-label={t('quietHours')} checked={quiet.enabled} onChange={(e) => update({ quietHours: { ...quiet, enabled: e.target.checked } })} />
          <label>{t('from')} <input type="time" value={quiet.from} disabled={!quiet.enabled} onChange={(e) => e.target.value && update({ quietHours: { ...quiet, from: e.target.value } })} /></label>
          <label>{t('until')} <input type="time" value={quiet.to} disabled={!quiet.enabled} onChange={(e) => e.target.value && update({ quietHours: { ...quiet, to: e.target.value } })} /></label>
        </span>
      </div>
      <Toggle label={t('aiAlerts')} hint={t('aiAlertsHint')} checked={Boolean(s.aiAlerts)} onChange={(v) => update({ aiAlerts: v })} />
      <div className="setting-block">
        <strong>{t('notifyProjects')}</strong>
        <small>{t('notifyProjectsHint')}</small>
        <div className="project-switches">
          {state.projects.map((project) => (
            <label key={project.id} className="project-switch" style={{ '--project': project.color }}>
              <input type="checkbox" checked={!muted.has(project.id)} onChange={() => toggleProject(project.id)} />
              <span className="project-tag">{project.name}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function Appearance({ t, state, setState, onToast, onSceneChanged }) {
  const s = state.settings;
  const update = async (changes) => setState(await api.updateSettings(changes));
  const [image, setImage] = useState(null);
  useEffect(() => { api.sceneImage().then(setImage).catch(() => {}); }, []);
  const pick = async () => {
    try {
      const dataUrl = await api.pickImage();
      if (!dataUrl) return;
      setState(await api.setSceneImage(dataUrl));
      setImage(dataUrl);
      onSceneChanged?.();
    } catch (error) {
      onToast(errorText(error), 'error');
    }
  };
  const remove = async () => {
    setState(await api.setSceneImage(null));
    setImage(null);
    onSceneChanged?.();
  };
  const choices = [['trays', t('sceneTrays')], ['dawn', t('sceneDawn')], ['night', t('sceneNight')], ['plain', t('scenePlain')]];
  return (
    <div className="settings-section">
      <Segmented label={t('theme')} value={s.theme} options={[['system', t('themeSystem')], ['light', t('themeLight')], ['dark', t('themeDark')]]} onChange={(v) => update({ theme: v })} />
      <Segmented label={t('density')} value={s.density} options={[['comfortable', t('densityComfortable')], ['compact', t('densityCompact')]]} onChange={(v) => update({ density: v })} />
      <div className="setting-block">
        <strong>{t('emptyScene')}</strong>
        <small>{t('emptySceneHint')}</small>
        <div className="scene-picker" role="radiogroup" aria-label={t('emptyScene')}>
          {choices.map(([key, label]) => (
            <button key={key} role="radio" aria-checked={s.emptyScene === key} className={classNames('scene-option', s.emptyScene === key && 'on')} onClick={() => update({ emptyScene: key })}>
              <span className="scene-thumb">{key === 'plain' ? <span className="scene-plain-thumb" /> : <SceneArt kind={key} />}</span>
              <span>{label}</span>
            </button>
          ))}
          <button role="radio" aria-checked={s.emptyScene === 'custom'} className={classNames('scene-option', s.emptyScene === 'custom' && 'on')} onClick={() => (image ? update({ emptyScene: 'custom' }) : pick())}>
            <span className="scene-thumb">{image ? <SceneArt kind="custom" image={image} /> : <span className="scene-add"><ImagePlus size={20} /></span>}</span>
            <span>{t('sceneCustom')}</span>
          </button>
        </div>
        <div className="scene-actions">
          <button className="button ghost small" onClick={pick}><ImagePlus size={14} />{image ? t('sceneReplace') : t('sceneChoose')}</button>
          {image && <button className="button ghost small danger-text" onClick={remove}><Trash2 size={14} />{t('sceneRemove')}</button>}
        </div>
      </div>
    </div>
  );
}

function General({ t, state, setState, language }) {
  const s = state.settings;
  const update = async (changes) => setState(await api.updateSettings(changes));
  const [info, setInfo] = useState(null);
  useEffect(() => { api.appInfo().then(setInfo).catch(() => {}); }, []);
  return (
    <div className="settings-section">
      <Segmented label={t('language')} value={language} options={[['ar', 'العربية'], ['en', 'English']]} onChange={async (v) => setState(await api.setLanguage(v))} />
      <div className="setting-row">
        <span><strong>{t('undoSend')}</strong><small>{t('undoSendHint')}</small></span>
        <select value={s.undoSeconds} onChange={(e) => update({ undoSeconds: Number(e.target.value) })}>
          {[0, 5, 10, 20, 30].map((n) => <option key={n} value={n}>{n ? t('seconds', { n }) : t('off')}</option>)}
        </select>
      </div>
      <Toggle label={t('confirmBeforeSend')} hint={t('confirmBeforeSendHint')} checked={s.confirmBeforeSend} onChange={(v) => update({ confirmBeforeSend: v })} />
      <Toggle label={t('markReadOnOpen')} checked={s.markReadOnOpen} onChange={(v) => update({ markReadOnOpen: v })} />
      <Toggle label={t('inboxTabs')} hint={t('inboxTabsHint')} checked={s.inboxTabs !== false} onChange={(v) => update({ inboxTabs: v })} />
      <Toggle label={t('closeToTray')} hint={t('closeToTrayHint')} checked={s.closeToTray !== false} onChange={(v) => update({ closeToTray: v })} />
      {info && !info.store && !info.portable && <Toggle label={t('startAtLogin')} hint={t('startAtLoginHint')} checked={Boolean(s.startAtLogin)} onChange={(v) => update({ startAtLogin: v })} />}
      <AiSetting t={t} value={s.aiProvider || 'auto'} onChange={(v) => update({ aiProvider: v })} />
      <UpdateSetting t={t} enabled={s.autoUpdate !== false} onChange={(v) => update({ autoUpdate: v })} />
    </div>
  );
}

function AccountCard({ t, account, state, setState, onToast, defaultOpen, onMove, first, last }) {
  const [open, setOpen] = useState(defaultOpen);
  const [form, setForm] = useState({ displayName: account.displayName || '', projectId: account.projectId, signatureNew: account.signatureNew || '', signatureReply: account.signatureReply || '', password: '', allAddresses: Boolean(account.allAddresses) });
  const resend = account.authType === 'resend';
  const [busy, setBusy] = useState(false);
  const status = account.sync?.status || 'idle';
  const project = state.projects.find((p) => p.id === account.projectId);
  const save = async () => {
    setBusy(true);
    try {
      const { allAddresses, ...changes } = form;
      setState(await api.updateAccount(account.id, { ...changes, password: form.password || undefined, ...(resend ? { allAddresses } : {}) }));
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
          <span className="card-title"><strong dir="auto">{account.displayName || account.email}</strong><small>{account.email} · {resend ? (account.resendMode === 'send' ? t('resendSendOnly') : 'Resend API') : account.imapHost}</small></span>
          {project && <span className="project-tag" style={{ '--project': project.color }}>{project.name}</span>}
          <ChevronDown size={16} className="card-chevron" />
        </button>
        <button className="icon-button quiet" disabled={first} onClick={() => onMove(-1)} title={t('moveUp')} aria-label={t('moveUp')}><ArrowUp size={15} /></button>
        <button className="icon-button quiet" disabled={last} onClick={() => onMove(1)} title={t('moveDown')} aria-label={t('moveDown')}><ArrowDown size={15} /></button>
        <button className="icon-button quiet" onClick={() => api.syncAccount(account.id).then(setState).catch((e) => onToast(errorText(e), 'error'))} title={t('syncNow')} aria-label={t('syncNow')}><RefreshCw size={15} /></button>
      </header>
      {account.sync?.error && <p className="form-error">{account.sync.error === 'MICROSOFT_SIGN_IN_AGAIN' ? t('microsoftSignInAgain') : account.sync.error}</p>}
      {open && (<>
      <div className="card-grid">
        <label className="field"><span>{t('yourName')}</span><input dir="auto" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
        <label className="field"><span>{t('project')}</span><select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>{state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field"><span>{t('signatureNew')}</span><select value={form.signatureNew} onChange={(e) => setForm({ ...form, signatureNew: e.target.value })}><option value="">{t('noSignature')}</option>{state.signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>{t('signatureReply')}</span><select value={form.signatureReply} onChange={(e) => setForm({ ...form, signatureReply: e.target.value })}><option value="">{t('noSignature')}</option>{state.signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {account.authType === 'microsoft' ? (
          <div className="field wide microsoft-renew">
            <span>{t('microsoftAccount')}</span>
            <button type="button" className="button ghost" onClick={() => api.renewMicrosoft(account.id).then(setState).then(() => onToast(t('saved'))).catch((e) => onToast(errorText(e), 'error'))}>{t('microsoftRenew')}</button>
          </div>
        ) : <label className="field wide"><span>{resend ? t('changeApiKey') : t('changePassword')}</span><input type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={resend ? 're_…' : t('changePasswordHint')} /></label>}
        {resend && <label className="check wide"><input type="checkbox" checked={form.allAddresses} onChange={(e) => setForm({ ...form, allAddresses: e.target.checked })} />{t('resendAllAddresses')}</label>}
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

function AccountsByProject({ t, state, setState, onToast, onAddAccount }) {
  // Move an account one place up or down inside its own project.
  const move = async (account, step) => {
    const siblings = state.accounts.filter((a) => a.projectId === account.projectId);
    const target = siblings[siblings.findIndex((a) => a.id === account.id) + step];
    if (!target) return;
    const ids = state.accounts.map((a) => a.id);
    const [from, to] = [ids.indexOf(account.id), ids.indexOf(target.id)];
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setState(await api.reorderAccounts(ids));
  };
  return (
    <div className="settings-section">
      {state.projects.map((project) => {
        const accounts = state.accounts.filter((a) => a.projectId === project.id);
        return (
          <section key={project.id} className="project-accounts" style={{ '--project': project.color }}>
            <header>
              <span className="project-tag">{project.name}</span>
              <small>{t('accountsCount', { n: accounts.length })}</small>
              <button className="button ghost small" onClick={() => onAddAccount(project.id)}><Plus size={14} />{t('addAccount')}</button>
            </header>
            {accounts.map((account, index) => (
              <AccountCard
                key={account.id}
                t={t}
                account={account}
                state={state}
                setState={setState}
                onToast={onToast}
                defaultOpen={state.accounts.length === 1}
                first={index === 0}
                last={index === accounts.length - 1}
                onMove={(step) => move(account, step).catch((e) => onToast(errorText(e), 'error'))}
              />
            ))}
            {!accounts.length && <p className="muted empty-note">{t('noAccountsInProject')}</p>}
          </section>
        );
      })}
    </div>
  );
}

export default function SettingsView({ t, state, setState, language, onToast, onView, onAddAccount, onSceneChanged, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div className="page">
      <header className="page-head"><h1>{t('settings')}</h1></header>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist">
          {TABS.map((key) => <button key={key} role="tab" aria-selected={tab === key} className={classNames(tab === key && 'on')} onClick={() => setTab(key)}>{t(`tab_${key}`)}</button>)}
        </div>
        <div className="settings-panel">
          {tab === 'general' && <General t={t} state={state} setState={setState} language={language} />}
          {tab === 'notifications' && <Notifications t={t} state={state} setState={setState} />}
          {tab === 'appearance' && <Appearance t={t} state={state} setState={setState} onToast={onToast} onSceneChanged={onSceneChanged} />}
          {tab === 'accounts' && <AccountsByProject t={t} state={state} setState={setState} onToast={onToast} onAddAccount={onAddAccount} />}
          {tab === 'signatures' && <Signatures t={t} state={state} setState={setState} onToast={onToast} />}
          {tab === 'projects' && <Projects t={t} state={state} setState={setState} onToast={onToast} />}
          {tab === 'security' && <Security t={t} onView={onView} />}
        </div>
      </div>
    </div>
  );
}
