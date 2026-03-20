export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'data-explorer-theme';

export function getPreferredTheme(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'light';
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
