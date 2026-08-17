/**
 * QUONA wordmark, drawn as vector paths so it stays crisp at any size and needs no font or
 * image asset. Geometric grotesque letterforms with the brand's distinctive notched Q tail.
 *
 * `tone` picks the fill: "brand" is the chartreuse used on dark/photographic backgrounds,
 * "ink" is the near-black used on the white canvas this app runs on.
 */
export function QuonaLogo({ height = 22, tone = 'ink' }: { height?: number; tone?: 'brand' | 'ink' }) {
  const fill = tone === 'brand' ? 'var(--accent)' : 'var(--text-h)';
  return (
    <svg
      height={height}
      viewBox="0 0 672 132"
      role="img"
      aria-label="Quona"
      style={{ display: 'block' }}
    >
      {/* evenodd so the enclosed counters in Q, O and A are cut out of the solid letterforms */}
      <g fill={fill} fillRule="evenodd">
        {/* Q — ring plus the angled tail that breaks the counter */}
        <path d="M66 0C29.6 0 0 29.6 0 66s29.6 66 66 66c12.6 0 24.3-3.5 34.3-9.6l14.4 14.4 21.2-21.2-14.4-14.4c6.1-10 9.6-21.7 9.6-34.3C131 29.6 102.4 0 66 0Zm0 33c18.2 0 33 14.8 33 33 0 3.6-.6 7-1.7 10.2L83 61.9 61.8 83.1l14.3 14.3c-3.2 1.1-6.6 1.7-10.1 1.7-18.2 0-33-14.8-33-33s14.8-33 33-33Z" />
        {/* U */}
        <path d="M155 4h33v72c0 12.7 10.3 23 23 23s23-10.3 23-23V4h33v72c0 31-25 56-56 56s-56-25-56-56V4Z" />
        {/* O */}
        <path d="M345 0c-36.4 0-66 29.6-66 66s29.6 66 66 66 66-29.6 66-66S381.4 0 345 0Zm0 33c18.2 0 33 14.8 33 33s-14.8 33-33 33-33-14.8-33-33 14.8-33 33-33Z" />
        {/* N */}
        <path d="M428 4h31l45 63V4h33v124h-31l-45-63v63h-33V4Z" />
        {/* A — outer letterform with its triangular counter cut out */}
        <path d="M562 128h-35L575 4h42l48 124h-35l-9-25h-50l-9 25Zm20-54h26l-13-36-13 36Z" />
      </g>
    </svg>
  );
}
