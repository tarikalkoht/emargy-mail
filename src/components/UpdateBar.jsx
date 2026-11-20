import { useState } from 'react';
import { Download, LoaderCircle, Sparkles } from 'lucide-react';

/** A new version is ready (or, for a portable copy, available): say so plainly, with one button. */
export default function UpdateBar({ t, update, onLater, onError }) {
  const [busy, setBusy] = useState(false);
  const ready = update.state === 'ready';
  const act = async () => {
    setBusy(true);
    try {
      if (ready) await window.emargy.installUpdate();
      else await window.emargy.openHelp('releases');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="update-bar" role="status">
      <Sparkles size={18} />
      <span>{t(ready ? 'updateBarReady' : 'updateBarAvailable', { version: update.version })}</span>
      <button className="button primary small" onClick={act} disabled={busy}>
        {busy ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
        {ready ? t('updateRestartNow') : t('updateDownload')}
      </button>
      <button className="button ghost small" onClick={onLater}>{t('updateLater')}</button>
    </div>
  );
}
