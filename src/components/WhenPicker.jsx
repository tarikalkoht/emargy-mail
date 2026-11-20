import { useState } from 'react';
import { CalendarClock, Check } from 'lucide-react';
import Modal from './Modal';
import { formatWhen, localInputValue, quickTimes } from '../lib/format';

/** Choose a moment: a few ready-made times, or any date and time. Used by send later and snooze. */
export default function WhenPicker({ t, language, title, hint, confirmLabel, onPick, onClose }) {
  const options = quickTimes(language);
  const [custom, setCustom] = useState(() => localInputValue(options.find((o) => o.key === 'tomorrowMorning').at));
  const customAt = new Date(custom).getTime();
  const valid = Number.isFinite(customAt) && customAt > Date.now() + 60_000;
  return (
    <Modal title={title} onClose={onClose} width="420px">
      <div className="modal-body when-picker">
        {hint && <p className="section-hint">{hint}</p>}
        <div className="when-options">
          {options.map((option) => (
            <button key={option.key} className="when-option" onClick={() => onPick(option.at)}>
              <span>{t(`when_${option.key}`)}</span>
              <small>{formatWhen(option.at, language)}</small>
            </button>
          ))}
        </div>
        <label className="field when-custom">
          <span><CalendarClock size={14} />{t('whenCustom')}</span>
          <input type="datetime-local" value={custom} min={localInputValue(Date.now())} onChange={(e) => setCustom(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="button ghost" onClick={onClose}>{t('cancel')}</button>
          <button className="button primary" disabled={!valid} onClick={() => onPick(customAt)}><Check size={15} />{confirmLabel}</button>
        </div>
      </div>
    </Modal>
  );
}
