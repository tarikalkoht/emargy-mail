import { initial, senderHue } from '../lib/format';

/** The account's own picture, or its first letter on a soft color when it has none. */
export default function AccountAvatar({ account, size = 20, className = '' }) {
  const label = account?.displayName || account?.email || '';
  if (account?.picture) {
    return <img className={`account-avatar ${className}`} src={account.picture} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
  }
  return (
    <span className={`account-avatar letter ${className}`} style={{ '--hue': senderHue(label), width: size, height: size, fontSize: Math.round(size * 0.48) }} aria-hidden="true">
      {initial(label)}
    </span>
  );
}
