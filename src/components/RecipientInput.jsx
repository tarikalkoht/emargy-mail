import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { classNames, parseAddresses } from '../lib/format';

function toList(value) {
  return parseAddresses(value).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
}

const VALID = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Recipient field with chips and suggestions from the user's own mail history. */
export default function RecipientInput({ label, value, onChange, autoFocus, t }) {
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const recipients = toList(value);

  useEffect(() => {
    let cancelled = false;
    const query = draft.trim();
    if (query.length < 2) { setSuggestions([]); return undefined; }
    window.emargy.searchContacts(query).then((list) => {
      if (!cancelled) { setSuggestions(list.filter((c) => !recipients.some((r) => r.includes(c.address)))); setActive(0); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (entry) => {
    const text = (entry ?? draft).trim().replace(/[,;]$/, '');
    if (!text) return;
    onChange([...recipients, text].join(', '));
    setDraft('');
    setSuggestions([]);
  };
  const remove = (index) => onChange(recipients.filter((_, i) => i !== index).join(', '));
  const pick = (contact) => commit(contact.name ? `${contact.name} <${contact.address}>` : contact.address);

  const onKeyDown = (event) => {
    if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActive((i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
      if (suggestions.length && event.key !== ',' && event.key !== ';') { event.preventDefault(); pick(suggestions[active]); }
      else if (draft.trim()) { event.preventDefault(); commit(); }
    } else if (event.key === 'Backspace' && !draft && recipients.length) {
      remove(recipients.length - 1);
    } else if (event.key === 'Escape') {
      setSuggestions([]);
    }
  };

  return (
    <div className="field-row recipients" onClick={() => inputRef.current?.focus()}>
      <span className="field-label">{label}</span>
      <div className="chips">
        {recipients.map((recipient, index) => {
          const [parsed] = parseAddresses(recipient);
          const valid = parsed && VALID.test(parsed.address);
          return (
            <span key={`${recipient}-${index}`} className={classNames('chip', !valid && 'invalid')} title={parsed?.address || recipient} dir="auto">
              {parsed?.name || parsed?.address || recipient}
              <button type="button" onClick={(e) => { e.stopPropagation(); remove(index); }} aria-label={t('remove')}><X size={12} /></button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          dir="auto"
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => { if (draft.trim()) commit(); setSuggestions([]); }, 150)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[,;\n]/.test(text)) { e.preventDefault(); onChange([...recipients, ...toList(text)].join(', ')); }
          }}
          aria-label={label}
        />
      </div>
      {!!suggestions.length && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((contact, index) => (
            <li key={contact.address} role="option" aria-selected={index === active} className={classNames(index === active && 'active')} onMouseDown={(e) => { e.preventDefault(); pick(contact); }}>
              <strong dir="auto">{contact.name || contact.address}</strong>
              {contact.name && <span>{contact.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
