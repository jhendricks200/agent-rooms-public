// The Agent Rooms mark: two contributions converging into a shared keystone.
// Fill+stroke in the same color (round joins) is what rounds the corners.
// The keystone color comes from --brand-keystone so it stays visible on both
// themes (near-white on dark, near-black on light).
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <g strokeLinejoin="round" strokeWidth="3">
        <path d="M13.5 10.5h16v9h-8v11.5l-8-5.5v-15z" fill="#2B5CE6" stroke="#2B5CE6" />
        <path d="M34.5 10.5h16v18l-8 5.5-8-5.5v-18z" fill="#5B7FF2" stroke="#5B7FF2" />
        <path
          d="M33 32l12.5 9-12.5 12.5L20.5 41 33 32z"
          fill="var(--brand-keystone, #14161b)"
          stroke="var(--brand-keystone, #14161b)"
        />
      </g>
    </svg>
  );
}
