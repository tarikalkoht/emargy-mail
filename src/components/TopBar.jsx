import { Search, X } from 'lucide-react';
import Logo from './Logo';

/**
 * The window's own title bar: brand, search, and room for the Windows caption
 * buttons (drawn by Windows itself on the right). Empty parts drag the window.
 */
export default function TopBar({ t, search, onSearch, searchRef, showSearch = true, scopeLabel }) {
  return (
    <header className="topbar">
      <div className="topbar-brand"><Logo size={22} /><span>{t('appName')}</span></div>
      {showSearch && (
        <div className="topbar-search">
          <Search size={17} />
          <input
            ref={searchRef}
            dir="auto"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { onSearch(''); e.currentTarget.blur(); } }}
            placeholder={scopeLabel ? t('searchIn', { scope: scopeLabel }) : t('searchPlaceholder')}
            aria-label={t('search')}
          />
          {search ? <button className="icon-button quiet tiny" onClick={() => onSearch('')} aria-label={t('clear')}><X size={14} /></button> : <kbd className="topbar-kbd">/</kbd>}
        </div>
      )}
      <div className="topbar-fill" />
    </header>
  );
}
