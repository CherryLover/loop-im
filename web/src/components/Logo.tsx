/** Loop IM brand mark: a chat bubble with three dots. */
export function Logo({ size = 17, tone = '#fff' }: { size?: number; tone?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H9l-4 4v-4H5.5C4.67 15 4 14.33 4 13.5v-8Z"
        fill={tone}
      />
      <circle cx="8.5" cy="9.5" r="1.1" fill="var(--accent)" />
      <circle cx="12" cy="9.5" r="1.1" fill="var(--accent)" />
      <circle cx="15.5" cy="9.5" r="1.1" fill="var(--accent)" />
    </svg>
  );
}
