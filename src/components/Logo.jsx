import logoUrl from '../assets/logo.png';

/** Emargy Mail mark: the letter E built from three stacked mail trays (several inboxes, one place). */
export default function Logo({ size = 28, className }) {
  return <img className={['logo', className].filter(Boolean).join(' ')} src={logoUrl} width={size} height={size} alt="Emargy Mail" draggable="false" />;
}
