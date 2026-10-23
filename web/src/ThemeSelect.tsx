import { useState } from 'react';
export function ThemeSelect() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'system');
  return (
    <label className="theme-select">
      <span className="sr-only">ธีมหน้าจอ</span>
      <select
        aria-label="ธีมหน้าจอ"
        value={theme}
        onChange={(e) => {
          const value = e.target.value;
          setTheme(value);
          document.documentElement.dataset.theme = value;
          try {
            localStorage.setItem('step-theme', value);
          } catch {
            /* Theme still works without storage. */
          }
        }}
      >
        <option value="system">ธีมตามระบบ</option>
        <option value="light">สว่าง</option>
        <option value="dark">มืด</option>
      </select>
    </label>
  );
}
