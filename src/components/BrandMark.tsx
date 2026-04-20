/*
  Placeholder brand mark.
  Replace this file with the final Nottingham castle + shield + human head SVG when it lands.
  Kept inline so the mark is inlined in the HTML (perfect for hero + share previews).
*/

type Props = {
  size?: number;
  showWordmark?: boolean;
  className?: string;
};

export default function BrandMark({ size = 40, showWordmark = true, className }: Props) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-3)",
        color: "var(--color-text)",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="naisi-shield" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="100%" stopColor="var(--color-accent-hover)" />
          </linearGradient>
        </defs>
        {/* shield silhouette — placeholder for castle+shield+head */}
        <path
          d="M20 2 L35 7 L35 20 C35 29 28 35 20 38 C12 35 5 29 5 20 L5 7 Z"
          fill="url(#naisi-shield)"
        />
        {/* head inside shield (placeholder) */}
        <circle cx="20" cy="17" r="4" fill="var(--color-bg)" opacity="0.9" />
        <path
          d="M13 28 C13 24 16 22 20 22 C24 22 27 24 27 28 Z"
          fill="var(--color-bg)"
          opacity="0.9"
        />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            letterSpacing: "0.02em",
            fontSize: "var(--text-lg)",
          }}
        >
          NAISI
        </span>
      )}
    </span>
  );
}
