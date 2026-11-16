/**
 * Emargy Mail mark: a sealed envelope on deep green, with the three coloured project tabs
 * that mark every conversation in the app. Kept geometric so it stays crisp at 16 px.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="15" fill="#1F6F5C"/>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#g)" opacity=".35"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
  <rect x="9" y="17" width="5" height="9" rx="2.5" fill="#F4B740"/>
  <rect x="9" y="28" width="5" height="9" rx="2.5" fill="#7FD1B9"/>
  <rect x="9" y="39" width="5" height="9" rx="2.5" fill="#F2766B"/>
  <rect x="19" y="19" width="36" height="27" rx="5" fill="#FFFFFF"/>
  <path d="M20.5 21.5 37 34.2 53.5 21.5" fill="none" stroke="#1F6F5C" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="37" cy="40.5" r="3.2" fill="#1F6F5C"/>
</svg>`;

export default function Logo({ size = 28, className }) {
  return (
    <svg className={['logo', className].filter(Boolean).join(' ')} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Emargy Mail">
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#1F6F5C" />
      <rect x="9" y="17" width="5" height="9" rx="2.5" fill="#F4B740" />
      <rect x="9" y="28" width="5" height="9" rx="2.5" fill="#7FD1B9" />
      <rect x="9" y="39" width="5" height="9" rx="2.5" fill="#F2766B" />
      <rect x="19" y="19" width="36" height="27" rx="5" fill="#FFFFFF" />
      <path d="M20.5 21.5 37 34.2 53.5 21.5" fill="none" stroke="#1F6F5C" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="37" cy="40.5" r="3.2" fill="#1F6F5C" />
    </svg>
  );
}
