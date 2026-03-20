import type { ThemeMode } from '../lib/theme';

interface ThemeToggleProps {
  themeMode: ThemeMode;
  onToggle: () => void;
}

export function ThemeToggle({ themeMode, onToggle }: ThemeToggleProps) {
  const isDark = themeMode === 'dark';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isDark}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      className="inline-flex items-center gap-2 rounded-full border border-[var(--panel-border)] bg-[var(--panel-elevated)] px-4 py-2 text-sm font-medium text-[var(--text-primary)] shadow-[0_12px_30px_-18px_var(--shadow-color)] transition hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-hover)]"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)]">
        {isDark ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m8-9h1M3 12H2m15.364 6.364l.707.707M5.929 5.929l-.707-.707m12.142 0l.707-.707M5.929 18.071l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" />
          </svg>
        )}
      </span>
    </button>
  );
}
