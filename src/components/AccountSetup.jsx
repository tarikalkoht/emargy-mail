import { useState } from 'react';
import { AlertTriangle, ChevronDown, ExternalLink, KeyRound, LoaderCircle, Lock, Mail, Zap } from 'lucide-react';
import { classNames } from '../lib/format';

const api = window.emargy;
const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const setupError = (t, error) => {
  const message = errorText(error);
  const duplicate = message.match(/^DUPLICATE_ACCOUNT:([^:]*):(.*)$/);
  if (duplicate) return t('duplicateAccount', { email: duplicate[1], project: duplicate[2] });
  if (message === 'MICROSOFT_NOT_CONFIGURED') return t('microsoftNotConfigured');
  return message;
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
  const [form, setForm] = useState({ projectId: defaultProjectId || projects[0]?.id || '', displayName: '', email: '', password: '', username: '', apiKey: '', allAddresses: false });
  const [method, setMethod] = useState('mailbox'); // 'mailbox' (IMAP/SMTP or Microsoft) or 'resend' (API)
  const [servers, setServers] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [createdProjectId, setCreatedProjectId] = useState(null);
  const needProject = !projects.length && !createdProjectId;
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const setServer = (key, value) => setServers((current) => ({ ...current, [key]: value }));
  const isGoogle = servers?.provider === 'gmail';
  const isMicrosoft = Boolean(servers?.needsOAuth);

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
      if (method === 'resend') {
        setBusy(t('resendChecking'));
        state = await api.addAccount({ authType: 'resend', projectId, displayName: form.displayName, email: form.email, apiKey: form.apiKey.trim(), allAddresses: form.allAddresses });
        onDone(state);
        return;
      }
      setBusy(t('findingServers'));
      const settings = servers || await detect(form.email);
      if (!settings) throw new Error(t('serversNotFound'));
      if (settings.needsOAuth) {
        // Microsoft: the password is typed on Microsoft's own page, in the browser.
        setBusy(t('waitingForMicrosoft'));
        state = await api.addMicrosoftAccount({ projectId, displayName: form.displayName, email: form.email });
        onDone(state);
        return;
      }
      setBusy(t('testingConnection'));
      state = await api.addAccount({ ...settings, ...form, projectId, username: form.username || undefined });
      onDone(state);
    } catch (err) {
      setError(setupError(t, err));
      if (method === 'mailbox' && !servers?.needsOAuth) setAdvanced(true);
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
        <div className="method-switch" role="radiogroup" aria-label={t('accountType')}>
          <button type="button" role="radio" aria-checked={method === 'mailbox'} className={classNames(method === 'mailbox' && 'on')} onClick={() => { setMethod('mailbox'); setError(''); }}>
            <Mail size={18} /><span><strong>{t('methodMailbox')}</strong><small>{t('methodMailboxHint')}</small></span>
          </button>
          <button type="button" role="radio" aria-checked={method === 'resend'} className={classNames(method === 'resend' && 'on')} onClick={() => { setMethod('resend'); setError(''); setAdvanced(false); }}>
            <Zap size={18} /><span><strong>{t('methodResend')}</strong><small>{t('methodResendHint')}</small></span>
          </button>
        </div>
        {!needProject && projects.length > 1 && !lockProject && (
          <label className="field"><span>{t('project')}</span>
            <select value={form.projectId} onChange={(e) => set('projectId', e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
        )}
        <label className="field"><span>{t('yourName')}</span><input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder={t('yourNameExample')} dir="auto" /></label>
        <label className="field"><span>{t('email')}</span><input type="email" required dir="ltr" autoFocus={!needProject} value={form.email} onChange={(e) => { set('email', e.target.value); setServers(null); }} onBlur={(e) => method === 'mailbox' && !servers && detect(e.target.value)} /></label>
        {method === 'resend' && (<>
          <label className="field"><span>{t('resendApiKey')}</span><input type="password" required dir="ltr" autoComplete="off" spellCheck={false} value={form.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder="re_xxxxxxxx" /></label>
          <label className="check"><input type="checkbox" checked={form.allAddresses} onChange={(e) => set('allAddresses', e.target.checked)} />{t('resendAllAddresses')}</label>
          <div className="provider-guide">
            <strong><KeyRound size={14} /> {t('resendGuideTitle')}</strong>
            <ol>
              <li>{t('resendStep1')}</li>
              <li>{t('resendStep2')}</li>
              <li>{t('resendStep3')}</li>
            </ol>
            <div className="guide-actions">
              <button type="button" className="button ghost small" onClick={() => api.openHelp('resendKeys')}><ExternalLink size={14} />{t('resendOpenKeys')}</button>
              <button type="button" className="button ghost small" onClick={() => api.openHelp('resendReceiving')}><ExternalLink size={14} />{t('resendOpenReceiving')}</button>
            </div>
          </div>
        </>)}
        {method === 'mailbox' && !isMicrosoft && (
          <label className="field"><span>{isGoogle ? t('appPassword') : t('password')}</span><input type="password" required dir="ltr" autoComplete="new-password" value={form.password} onChange={(e) => set('password', isGoogle ? e.target.value.replace(/\s+/g, '') : e.target.value)} placeholder={isGoogle ? 'xxxx xxxx xxxx xxxx' : undefined} /></label>
        )}
        {method === 'mailbox' && !isMicrosoft && <p className="hint"><Lock size={13} />{t('passwordHelp')}</p>}
        {method === 'resend' && <p className="hint"><Lock size={13} />{t('resendKeyHelp')}</p>}
        {method === 'mailbox' && isMicrosoft && (
          <div className="provider-guide">
            <strong>{t('microsoftGuideTitle')}</strong>
            <span>{t('microsoftGuideText')}</span>
          </div>
        )}
        {method === 'mailbox' && isGoogle && (
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

        {method === 'mailbox' && !isMicrosoft && <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
          <ChevronDown size={14} />{t('serverSettings')}{servers && !advanced && <span className="muted">{servers.imapHost}</span>}
        </button>}
        {method === 'mailbox' && advanced && !isMicrosoft && (
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
        <button className="button primary" disabled={Boolean(busy)}>{busy ? <><LoaderCircle className="spin" size={16} />{busy}</> : (method === 'mailbox' && isMicrosoft ? t('signInWithMicrosoft') : t('connectAccount'))}</button>
      </div>
    </form>
  );
}
