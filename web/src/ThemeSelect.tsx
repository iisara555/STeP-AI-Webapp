import { useCallback, useState } from 'react';
export type Theme = 'system' | 'light' | 'dark';
export const THEMES: [Theme, string][] = [
  ['system', 'ตามระบบ'],
  ['light', 'สว่าง'],
  ['dark', 'มืด'],
];
const current = (): Theme => {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'dark' ? value : 'system';
};
/** The theme is a display preference only; it is applied before first paint by public/theme.js. */
export function useTheme() {
  const [theme, setState] = useState<Theme>(current);
  const setTheme = useCallback((value: Theme) => {
    setState(value);
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem('step-theme', value);
    } catch {
      /* Theme still works without storage. */
    }
  }, []);
  return [theme, setTheme] as const;
}
export function ThemeChoice({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return (
    <div className="theme-choice" role="radiogroup" aria-label="ธีมหน้าจอ">
      {THEMES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
