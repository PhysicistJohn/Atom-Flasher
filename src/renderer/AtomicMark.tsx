export function AtomicMark({ size = 32 }: { size?: number }) {
  return <span className="atomic-mark" style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 48 48" role="presentation">
      <ellipse cx="24" cy="24" rx="19.5" ry="8" transform="rotate(35 24 24)"/>
      <ellipse cx="24" cy="24" rx="19.5" ry="8" transform="rotate(-35 24 24)"/>
      <g className="atomic-nucleus">
        <rect x="22.2" y="19" width="1.7" height="10" rx="0.85"/>
        <rect x="19.3" y="15.5" width="1.7" height="17" rx="0.85"/>
        <rect x="16.4" y="19.5" width="1.7" height="9" rx="0.85"/>
        <rect x="13.5" y="21.5" width="1.7" height="5" rx="0.85"/>
        <rect x="25.1" y="15.5" width="1.7" height="17" rx="0.85"/>
        <rect x="28" y="19.5" width="1.7" height="9" rx="0.85"/>
        <rect x="30.9" y="21.5" width="1.7" height="5" rx="0.85"/>
      </g>
      <circle className="atomic-electron" cx="37.4" cy="9.6" r="2.4"/>
      <circle className="atomic-electron" cx="10.6" cy="38.4" r="2.4"/>
    </svg>
  </span>;
}
