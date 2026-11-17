import { Sparkles } from 'lucide-react';

/* Built-in pictures for empty screens, drawn in the brand's teal. All vector, no network. */

function Trays() {
  const tray = (x, y, w, o) => (
    <g opacity={o} transform={`translate(${x} ${y})`}>
      <rect width={w} height={w * 0.22} rx={w * 0.05} fill="#01c4a2" />
      <rect x={w * 0.06} y={w * 0.045} width={w * 0.88} height={w * 0.09} rx={w * 0.04} fill="#4be7c0" opacity=".55" />
    </g>
  );
  return (
    <svg className="scene-art" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="trays-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9faf4" />
          <stop offset="1" stopColor="#c7efe2" />
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#trays-bg)" />
      <g transform="rotate(-12 400 300)">
        {tray(420, 120, 340, 0.22)}
        {tray(440, 210, 300, 0.32)}
        {tray(460, 290, 260, 0.45)}
        {tray(40, 400, 220, 0.18)}
        {tray(60, 460, 180, 0.26)}
      </g>
      <rect x="690" y="470" width="42" height="42" rx="11" fill="#017b66" opacity=".55" />
    </svg>
  );
}

function Dawn() {
  return (
    <svg className="scene-art" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="dawn-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd9b8" />
          <stop offset=".55" stopColor="#fdeedd" />
          <stop offset="1" stopColor="#dff5ee" />
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#dawn-sky)" />
      <circle cx="560" cy="300" r="78" fill="#ffb27a" opacity=".85" />
      <path d="M0 400 C 140 330 260 360 380 395 S 640 330 800 370 V600 H0Z" fill="#4be7c0" opacity=".55" />
      <path d="M0 455 C 170 405 300 450 450 470 S 680 420 800 450 V600 H0Z" fill="#01c4a2" opacity=".7" />
      <path d="M0 520 C 200 485 360 530 520 535 S 720 505 800 515 V600 H0Z" fill="#017b66" />
    </svg>
  );
}

function Night() {
  const stars = [[90, 80], [180, 150], [260, 60], [330, 190], [420, 100], [520, 50], [610, 170], [700, 90], [740, 220], [140, 260], [470, 230], [60, 200]];
  return (
    <svg className="scene-art" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="night-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#081a1f" />
          <stop offset="1" stopColor="#123a3c" />
        </linearGradient>
      </defs>
      <rect width="800" height="600" fill="url(#night-sky)" />
      {stars.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 2.2 : 1.4} fill="#dff5ee" opacity={0.5 + (i % 4) * 0.12} />)}
      <mask id="night-moon">
        <rect width="800" height="600" fill="#fff" />
        <circle cx="622" cy="138" r="42" fill="#000" />
      </mask>
      <circle cx="600" cy="150" r="46" fill="#e9faf4" mask="url(#night-moon)" />
      <path d="M0 450 C 160 400 300 430 440 455 S 680 410 800 440 V600 H0Z" fill="#0f4b45" />
      <path d="M0 515 C 220 480 380 520 560 525 S 730 500 800 505 V600 H0Z" fill="#017b66" opacity=".8" />
    </svg>
  );
}

export const SCENES = { trays: Trays, dawn: Dawn, night: Night };

export function SceneArt({ kind, image }) {
  if (kind === 'custom' && image) return <img className="scene-art" src={image} alt="" />;
  const Art = SCENES[kind];
  return Art ? <Art /> : null;
}

function greeting(t, hour) {
  if (hour >= 5 && hour < 12) return t('goodMorning');
  if (hour >= 12 && hour < 18) return t('goodAfternoon');
  return t('goodEvening');
}

/** What the reading pane shows when no conversation is open. */
export default function EmptyScene({ t, kind = 'trays', image, name, unread = 0, important = 0, onOpenImportant, onCustomize }) {
  const pictured = kind !== 'plain' && (kind !== 'custom' || image);
  const firstName = String(name || '').trim().split(/\s+/)[0];
  return (
    <div className={['empty-scene', pictured ? 'pictured' : 'plain', kind].join(' ')}>
      {pictured && <SceneArt kind={kind} image={image} />}
      <div className="scene-card">
        <h2>{firstName ? t('greetName', { greeting: greeting(t, new Date().getHours()), name: firstName }) : greeting(t, new Date().getHours())}</h2>
        <p>{unread ? t('sceneUnread', { n: unread }) : t('sceneAllDone')}</p>
        {important > 0 && <button className="scene-chip" onClick={onOpenImportant}><Sparkles size={14} />{t('sceneImportant', { n: important })}</button>}
        <small>{t('selectConversationHint')}</small>
        <button className="scene-customize" onClick={onCustomize}>{t('customizeScene')}</button>
      </div>
    </div>
  );
}
