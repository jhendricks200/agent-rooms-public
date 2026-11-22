'use client';

// Icon visibility is driven entirely by CSS off [data-theme] on the root
// (see globals.css .theme-toggle .icon-sun/.icon-moon rules), so this
// component needs no state of its own - it just flips the attribute.
export function ThemeToggle() {
  function toggle() {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('signal-lab-theme', next);
    } catch {
      // localStorage unavailable (private browsing, etc.); theme just
      // won't persist across reloads.
    }
  }

  return (
    <button
      className="theme-toggle"
      title="Toggle light and dark"
      aria-label="Toggle color theme"
      onClick={toggle}
      type="button"
    >
      <svg
        className="icon-moon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <svg
        className="icon-sun"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    </button>
  );
}
