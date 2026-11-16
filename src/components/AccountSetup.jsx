import { useState } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink, LoaderCircle, Lock } from 'lucide-react';
import { classNames } from '../lib/format';

const api = window.emargy;
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const setupError = (t, error) => {
  const message = errorText(error);
  const duplicate = message.match(/^DUPLICATE_ACCOUNT:([^:]*):(.*)$/);
  return duplicate ? t('duplicateAccount', { email: duplicate[1], project: duplicate[2] }) : message;
};
export const PROJECT_COLORS = ['#017B66', '#175CD3', '#6941C6', '#C11574', '#B54708', '#0E7490', '#4D7C0F', '#9F1239'];

export function ColorPicker({ value, onChange, t }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label={t('color')}>
      {PROJECT_COLORS.map((color) => (
        <button type="button" key={color} role="radio" aria-checked={value === color} className={classNames(value === color && 'on')} style={{ '--swatch': color }} onClick={() => onChange(color)} aria-label={color} />
      ))}
    </div>
  );
}

/**
 * Add an email account: address + password, servers found automatically
 * (DNS only), connection tested before anything is saved.
 */
export default function AccountSetup({ t, projects, defaultProjectId, onDone, onCancel, firstRun = false, lockProject = false }) {
  const [project, setProject] = useState({ name: '', color: PROJECT_COLORS[0] });
  const [form, setForm] = useState({ projectId: defaultProjectId || projects[0]?.id || '', displayName: '', email: '', password: '', username: '' });
  const [servers, setServers] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [createdProjectId, setCreatedProjectId] = useState(null);
  const needProject = !projects.length && !createdProjectId;
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const setServer = (key, value) => setServers((current) => ({ ...current, [key]: value }));
  const isGoogle = servers?.provider === 'gmail';

  const detect = async (email) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    const found = await api.detectServers(email).catch(() => null);
    if (found) setServers(found);
    return found;
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    try {
      let projectId = createdProjectId || form.projectId;
      let state;
      if (needProject) {
        if (!project.name.trim()) throw new Error(t('projectNameRequired'));
        setBusy(t('creatingProject'));
        state = await api.createProject(project);
        projectId = state.projects[state.projects.length - 1].id;
        setCreatedProjectId(projectId);
      }
      setBusy(t('findingServers'));
      const settings = servers || await detect(form.email);
      if (!settings) throw new Error(t('serversNotFound'));
      setBusy(t('testingConnection'));
      state = await api.addAccount({ ...settings, ...form, projectId, username: form.username || undefined });
      onDone(state);
    } catch (err) {
      setError(setupError(t, err));
      setAdvanced(true);
    } finally {
      setBusy('');
    }
  };

  return (
    <form className={classNames('setup', firstRun && 'first-run')} onSubmit={submit}>
      {needProject && (
        <fieldset>
          <legend>{t('setupProjectTitle')}</legend>
          <p className="hint">{t('setupProjectHint')}</p>
          <label className="field"><span>{t('projectName')}</span><input autoFocus value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value })} placeholder={t('projectNameExample')} maxLength={80} dir="auto" /></label>
          <div className="field"><span>{t('color')}</span><ColorPicker t={t} value={project.color} onChange={(color) => setProject({ ...project, color })} /></div>
        </fieldset>
      )}
      <fieldset>
        <legend>{t('setupAccountTitle')}</legend>
        {!needProject && projects.length > 1 && !lockProject && (
          <label className="field"><span>{t('project')}</span>
            <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
        )}
        <label className="field"><span>{t('yourName')}</span><input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder={t('yourNameExample')} dir="auto" /></label>
        <label className="field"><span>{t('email')}</span><input type="email" required dir="ltr" autoFocus={!needProject} value={form.email} onChange={(e) => { set('email', e.target.value); setServers(null); }} onBlur={(e) => !servers && detect(e.target.value)} /></label>
        <label className="field"><span>{isGoogle ? t('appPassword') : t('password')}</span><input type="password" required dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => set('password', isGoogle ? e.target.value.replace(/\s+/g, '') : e.target.value)} placeholder={isGoogle ? 'xxxx xxxx xxxx xxxx' : undefined} /></label>
        <p className="hint"><Lock size={13} />{t('passwordHelp')}</p>
        {servers?.needsOAuth && <p className="warning"><AlertTriangle size={15} />{t('microsoftWarning')}</p>}
        {isGoogle && (
          <div className="provider-guide">
            <strong>{t('googleGuideTitle')}</strong>
            <ol>
              <li>{t('googleStep1')}</li>
              <li>{t('googleStep2')}</li>
              <li>{t('googleStep3')}</li>
            </ol>
            <div className="guide-actions">
              <button type="button" className="button ghost small" onClick={() => api.openHelp('google2sv')}><ExternalLink size={14} />{t('googleOpen2sv')}</button>
              <button type="button" className="button primary small" onClick={() => api.openHelp('googleAppPassword')}><ExternalLink size={14} />{t('googleOpenAppPasswords')}</button>
            </div>
          </div>
        )}

        <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          <ChevronDown size={14} />{t('serverSettings')}{servers && !advanced && <span className="muted">{servers.imapHost}</span>}
        </button>
        {advanced && (
          <div className="server-grid">
            <label className="field"><span>{t('imapHost')}</span><input dir="ltr" value={servers?.imapHost || ''} onChange={(e) => setServer('imapHost', e.target.value)} /></label>
            <label className="field narrow"><span>{t('port')}</span><input dir="ltr" type="number" value={servers?.imapPort || 993} onChange={(e) => setServer('imapPort', Number(e.target.value))} /></label>
            <label className="check"><input type="checkbox" checked={servers?.imapSecure ?? true} onChange={(e) => setServer('imapSecure', e.target.checked)} />{t('ssl')}</label>
            <label className="field"><span>{t('smtpHost')}</span><input dir="ltr" value={servers?.smtpHost || ''} onChange={(e) => setServer('smtpHost', e.target.value)} /></label>
            <label className="field narrow"><span>{t('port')}</span><input dir="ltr" type="number" value={servers?.smtpPort || 465} onChange={(e) => setServer('smtpPort', Number(e.target.value))} /></label>
            <label className="check"><input type="checkbox" checked={servers?.smtpSecure ?? true} onChange={(e) => setServer('smtpSecure', e.target.checked)} />{t('ssl')}</label>
            <label className="field wide"><span>{t('username')}</span><input dir="ltr" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder={form.email} /></label>
            <p className="hint wide">{t('starttlsHint')}</p>
          </div>
        )}
      </fieldset>
      {error && <p className="form-error" role="alert"><AlertTriangle size={15} />{error}</p>}
      <div className="setup-actions">
        {onCancel && <button type="button" className="button ghost" onClick={onCancel}>{t('cancel')}</button>}
        <button className="button primary" disabled={Boolean(busy)}>{busy ? <><LoaderCircle className="spin" size={16} />{busy}</> : t('connectAccount')}</button>
      </div>
    </form>
  );
}
