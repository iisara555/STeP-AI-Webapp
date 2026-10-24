import { useState } from 'react';
import { ChevronDown, FolderOpen, Menu, PanelLeft, Plus, Search, Share2 } from './icons.tsx';
import type { Workspace } from '../../packages/harness-core/src/contracts.ts';
import { THEMES, type Theme } from './ThemeSelect.tsx';
export const mod =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
export type MenuItem = { id: string; label: string; hint?: string; run: () => void; danger?: boolean };
export type MenuGroup = { label: string; items: MenuItem[]; theme?: boolean };

/**
 * The app's title bar, as on Desktop: the STeP menu and sidebar toggle on the left, the command bar in the middle.
 * The web adds the workspace switcher next to the toggle, since tasks and files belong to a workspace.
 */
export function TitleBar({
  groups,
  theme,
  onTheme,
  title,
  sidebarOpen,
  onSidebar,
  onMobileMenu,
  onPalette,
  workspaces,
  workspaceId,
  onWorkspace,
  onCreateWorkspace,
  onShare,
}: {
  groups: MenuGroup[];
  theme: Theme;
  onTheme: (theme: Theme) => void;
  title: string;
  sidebarOpen: boolean;
  onSidebar: () => void;
  onMobileMenu: () => void;
  onPalette: () => void;
  workspaces: Workspace[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
  onCreateWorkspace: () => void;
  onShare?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <header className="titlebar" aria-label="แถบหัวหน้าต่าง">
      <div className="titlebar-start">
        <button className="titlebar-icon mobile-only" aria-label="เปิดเมนู" onClick={onMobileMenu}>
          <Menu size={18} />
        </button>
        <div className="titlebar-menu">
          <button
            className="titlebar-app"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="เมนู STeP"
            title="เมนู STeP"
            onClick={() => setOpen(!open)}
          >
            <span className="titlebar-mark" aria-hidden="true">
              STeP
            </span>
            <ChevronDown size={13} />
          </button>
          {open && (
            <>
              <button
                className="menu-backdrop"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => setOpen(false)}
              />
              <div
                className="titlebar-dropdown"
                role="menu"
                aria-label="เมนู STeP"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                }}
              >
                {groups.map((group, g) => (
                  <div className="titlebar-group" role="group" aria-label={group.label} key={group.label}>
                    <div className="titlebar-group-label">{group.label}</div>
                    {group.items.map((item, i) => (
                      <button
                        key={item.id}
                        role="menuitem"
                        className={'titlebar-item' + (item.danger ? ' titlebar-danger' : '')}
                        autoFocus={g === 0 && i === 0}
                        onClick={() => {
                          setOpen(false);
                          item.run();
                        }}
                      >
                        <span>{item.label}</span>
                        {item.hint && <kbd>{item.hint}</kbd>}
                      </button>
                    ))}
                    {group.theme && (
                      <div className="titlebar-theme" role="group" aria-label="ธีม">
                        <span>ธีม</span>
                        {THEMES.map(([value, label]) => (
                          <button
                            key={value}
                            role="menuitemradio"
                            aria-checked={theme === value}
                            className="titlebar-chip"
                            onClick={() => {
                              setOpen(false);
                              onTheme(value);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          className="titlebar-icon desktop-only"
          aria-label={sidebarOpen ? 'ย่อแถบงาน' : 'ขยายแถบงาน'}
          title={sidebarOpen ? 'ย่อแถบงาน' : 'ขยายแถบงาน'}
          aria-pressed={sidebarOpen}
          onClick={onSidebar}
        >
          <PanelLeft size={16} />
        </button>
        <div className="titlebar-workspace">
          <FolderOpen size={15} aria-hidden="true" />
          <select
            aria-label="เลือก workspace"
            value={workspaceId}
            onChange={(e) => onWorkspace(e.target.value)}
          >
            <option value="">พื้นที่ส่วนตัว</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            className="titlebar-icon"
            aria-label="สร้าง workspace"
            title="สร้าง workspace"
            onClick={onCreateWorkspace}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
      <button className="titlebar-command" onClick={onPalette} title="ค้นหางานและคำสั่ง">
        <Search size={13} aria-hidden="true" />
        {/* The visible page title is part of the accessible name (WCAG 2.5.3); the purpose follows it. */}
        {title && <span>{title}</span>}
        <span className="sr-only">{title ? ' · ' : ''}ค้นหางานและคำสั่ง</span>
        {!title && <span aria-hidden="true">ค้นหางานและคำสั่ง</span>}
        <kbd>{mod}K</kbd>
      </button>
      <div className="titlebar-end">
        {onShare && (
          <button className="titlebar-icon" aria-label="เชิญทีม" title="เชิญทีม" onClick={onShare}>
            <Share2 size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
