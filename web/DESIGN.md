---
name: STeP AI (web)
description: The STeP AI Desktop workspace in a browser; ink on paper, yellow only where you act or are.
colors:
  step-yellow: '#ffc709'
  step-dark: '#231f20'
  accent-ink: '#7a5b00'
  accent-soft: '#fff4cc'
  selection: '#ffe38a'
  surface: '#fafaf8'
  paper: '#ffffff'
  sidebar: '#f7f6f3'
  selected: '#efece5'
  muted: '#645e5f'
  line: '#e7e4de'
  line-strong: '#cfcac2'
  danger: '#b3261e'
  danger-soft: '#fbeae8'
  success: '#286740'
  success-soft: '#e9f2ea'
  disabled-bg: '#e7e4de'
  disabled-text: '#645e5f'
  disabled-line: '#cfcac2'
  dark-surface: '#1b1819'
  dark-paper: '#231f20'
  dark-sidebar: '#161314'
  dark-text: '#f4f1ea'
  dark-muted: '#ada6a0'
  dark-line: '#37312f'
  dark-selected: '#2e2927'
typography:
  display:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '30px'
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: '-0.015em'
  headline:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '22px'
    fontWeight: 600
    lineHeight: 1.5
  title:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '17px'
    fontWeight: 600
    lineHeight: 1.6
  body:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.7
  body-dense:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: 'IBM Plex Sans Thai, Leelawadee UI, Thonburi, system-ui, sans-serif'
    fontSize: '12px'
    fontWeight: 500
    lineHeight: 1.6
rounded:
  input: '6px'
  control: '7px'
  inner: '8px'
  panel: '10px'
  dialog: '12px'
  pill: '999px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '14px'
  lg: '22px'
  page: '26px'
components:
  button-primary:
    backgroundColor: '{colors.step-yellow}'
    textColor: '{colors.step-dark}'
    rounded: '{rounded.control}'
    padding: '8px 13px'
  button-secondary:
    backgroundColor: 'transparent'
    textColor: '{colors.step-dark}'
    rounded: '{rounded.control}'
    padding: '8px 13px'
  button-primary-disabled:
    backgroundColor: '{colors.disabled-bg}'
    textColor: '{colors.disabled-text}'
    rounded: '{rounded.control}'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.step-dark}'
    rounded: '{rounded.input}'
    padding: '8px 10px'
  nav-item-active:
    backgroundColor: '{colors.selected}'
    textColor: '{colors.step-dark}'
    rounded: '{rounded.control}'
    padding: '8px 10px'
  badge:
    backgroundColor: '{colors.selected}'
    textColor: '{colors.muted}'
    typography: '{typography.label}'
    rounded: '{rounded.pill}'
    padding: '1px 9px'
  badge-demo:
    backgroundColor: '{colors.accent-soft}'
    textColor: '{colors.accent-ink}'
    rounded: '{rounded.pill}'
  card:
    backgroundColor: '{colors.paper}'
    rounded: '{rounded.panel}'
    padding: '22px'
  dialog:
    backgroundColor: '{colors.paper}'
    rounded: '{rounded.dialog}'
    padding: '22px'
  titlebar:
    backgroundColor: '{colors.sidebar}'
    height: '40px'
  sidebar:
    backgroundColor: '{colors.sidebar}'
    width: '246px'
  topbar:
    height: '78px'
  statusbar:
    height: '28px'
---

# Design System: STeP AI (web)

## Overview

**Creative North Star: "The Desktop, in a Browser"**

This is a new world for the web app, and it is deliberately not a web-native one: it is the STeP AI Desktop design (STeP-AI-Harness `DESIGN.md` and `desktop/src/theme.css` at commit `90ee71ca667c63284afe4996eddc7e8095b9a059`) carried over so staff moving between Desktop and browser find everything where they expect it. Calm, Notion-like ink on paper: warm off-white surfaces, STeP Dark text, hairlines instead of boxes, quiet hover fills, generous Thai line height, and STeP Yellow reserved for the primary action and for "you are here".

The window is a three-pane workspace: a 40px title bar over a 246px sidebar (tasks, folding เครื่องมือ, การตั้งค่า, profile), a main pane with a 78px title header and a 28px status bar, and a draft pane (ฉบับร่าง) that opens beside the conversation. Density is document-like, not dashboard-like: rows and hairlines, few cards.

Tokens are Desktop's values verbatim, plus web-only state tokens (`--success`, `--success-soft`, `--danger-soft`) and Desktop's `--disabled-*` trio. Desktop's syntax-highlight, diff, `--shadow-faint` and `--shadow-card` tokens are not used on the web and are not carried.

**Key Characteristics:**

- Ink on paper, hairline structure, tonal layers (sidebar, surface, paper) instead of shadows.
- Yellow is a fill with STeP Dark on it; accent text uses deep gold `--accent-ink`.
- One signature move: the inset 3px yellow active marker.
- Hand-drawn ink illustrations only in empty and waiting states.
- Full light/dark parity; system, light and dark selectable and applied before first paint.

## Colors

Two brand colours (STeP CI) and a set of warm neutrals chosen for legibility, not as extra brand colours.

### Primary

- **STeP Yellow** (step-yellow): fill only: primary buttons, send, rail "new" button, active markers, checked controls (`accent-color`), status "ok" dot. Always carries STeP Dark text (`--on-accent`). Identical in both themes.
- **Deep Gold Ink** (accent-ink): the accent for text and icons on light surfaces (links, starter icons, draft-pane icon). Dark theme swaps it to STeP Yellow.
- **Yellow Wash** (accent-soft): quiet tint for shared/demo badges, consent check box, selected radio rows, theme chip, Skill chip, and the highlighted second line of the welcome promise. Dark: `#3a3219`.
- **Highlighter** (selection): text selection only.

### Neutral

- **STeP Dark** (step-dark): primary text in light; the dark theme's paper. Also `--focus` in light.
- **Sidebar Linen** (sidebar): title bar and sidebar.
- **Surface** (surface): app background, inputs, composer frame.
- **Paper** (paper): raised reading surfaces: cards, draft pane, dialogs, popovers, composer textarea.
- **Selected Linen** (selected): selected rows and the base under the active marker; consent list.
- **Muted Ink** (muted): secondary text, group labels, idle icons.
- **Hairline / Strong Hairline** (line, line-strong): every divider and border; strong for inputs and the composer.
- Hover is a 5% STeP Dark wash (`rgba(35,31,32,0.05)`; dark `rgba(244,241,234,0.06)`).

### State (web additions)

- **Danger / Danger Wash** (danger, danger-soft): stop button, destructive confirm, error notices, "off" status dot. Dark: `#f2a197` / `#3b2321`.
- **Success / Success Wash** (success, success-soft): ready badges and success notices. Dark: `#98c379` / `#24301f`.
- **Disabled trio** (disabled-bg, disabled-text, disabled-line): only filled buttons (primary, send) turn grey when disabled; see-through buttons drop to 45% opacity.

### Named Rules

**The Yellow Is A Fill Rule.** STeP Yellow never appears as text or an icon on a light surface; use `--accent-ink`. Yellow fills always carry `--on-accent`.
**The Two State Colours Rule.** Danger and success (with their soft fills) are the only state colours. Warnings use the yellow wash, not a new orange.

## Typography

**Display Font:** IBM Plex Sans Thai (with Leelawadee UI, Thonburi, system-ui), bundled via `@fontsource/ibm-plex-sans-thai` at 400/500/600/700 (700 only for the title-bar STeP mark), `font-synthesis: none`.
**Body Font:** the same family; one face for everything.

**Character:** a single humanist Thai/Latin sans at comfortable Thai line heights, so tone marks and above/below vowels never collide.

### Hierarchy

- **Display** (600, 30px, 1.45, -0.015em): the home welcome promise only; 24px under 670px. Its second line is highlighted with a yellow-wash underlay (`linear-gradient(transparent 62%, accent-soft 62%)`).
- **Headline** (600, 22px, 1.5): page `h1`.
- **Title** (600, 17px, 1.6; 15px for `h3`; 18px in dialog headers): section headings.
- **Body** (400, 14px, 1.7): default; composer and source text run 14px/1.85 and 13px/1.85.
- **Body dense** (13px): rows, menus, cards, dialog copy, page subtitles. The most-used size.
- **Label** (500-600, 12px): badges, group labels, status bar, chips, captions.

### Named Rules

**The Thai Floor Rule.** No Thai text below 12px. 11px is allowed only for Latin-only marks: the `STeP` title-bar mark, the CI line MAKE INNOVATION SIMPLE (0.1em tracking), and keyboard hints (`kbd`, Ctrl K).
**The One Face Rule.** Hierarchy comes from size and weight (400/500/600; 700 is reserved for the STeP mark) in one family, never a second display face.

## Layout

A fixed application frame (`100dvh`, no page scroll) with three panes:

- **Title bar** (40px; 52px on coarse pointers): STeP app menu, rail toggle, workspace switcher, centred command bar (max 460px, Ctrl/⌘+K), account items at the end.
- **Sidebar** (246px; folds to a 60px icon rail): STeP symbol + MAKE INNOVATION SIMPLE, yellow เริ่มงานใหม่, task search, task filter, dated task groups, folding เครื่องมือ, การตั้งค่า, profile.
- **Main pane**: 78px title header, page content centred to 1100px (chat column 760px) with 26px gutters, docked composer, 28px status bar.
- **Draft pane** (`clamp(320px, 34%, 460px)`, 320px under 1150px) beside the conversation, with its own 78px header aligned to the main header.

Spacing is a loose 4px-based rhythm (4, 8, 12-14, 18-22, 26). Responsive: under 900px the sidebar becomes a 280px off-canvas drawer over a `--overlay` scrim and the draft pane goes full-screen under the title bar; under 670px the command bar collapses to an icon, page headings stack and their illustration hides, grids go single column. Under 760px height the sidebar tightens.

**The 44px Thumb Rule.** On coarse pointers every button, select, input, summary and pill is at least 44px tall (icon controls also 44px wide; segmented controls 40px), and shortcut hints disappear.

## Elevation & Depth

Flat by default. Depth is tonal (sidebar linen, surface, paper) plus hairlines. Shadows are reserved for things that float above the frame, all from three alpha tokens.

### Shadow Vocabulary

- **Segment lift** (`0 1px 2px var(--shadow-soft)`): the selected segment in the task filter.
- **Composer rest** (`0 1px 2px rgba(35,31,32,.04), 0 4px 14px rgba(35,31,32,.04)`): the docked composer only.
- **Popover** (`0 12px 32px var(--shadow-popover)`): title-bar dropdowns, menus, toasts.
- **Dialog** (`0 24px 64px var(--shadow-dialog)`): modal dialogs over `--overlay`.
- **Active marker** (`inset 3px 0 0 var(--accent)`): not elevation; see Components.

**The Float-Only Shadow Rule.** A shadow means "this is above the window". Cards and panes in the frame never cast one.

## Shapes

Softly rounded and consistent: inputs 6px, buttons and rows 7px, inner chips/composer tools 8px, cards/notices/popovers/composer 10px, dialogs 12px, badges and chips fully round (999px), avatars and dots circular. Borders are 1px hairlines. Hand-drawn illustrations are the only organic shapes, and they blend into the surface (`multiply` in light; inverted ink with `screen` at 0.86 opacity in dark).

## Components

### Buttons

- **Shape:** gently rounded (7px), 1px hairline border, `8px 13px`.
- **Primary:** STeP Yellow fill, STeP Dark text, 500 weight; hover darkens with `brightness(0.95)`. One per view.
- **Default:** see-through with a hairline; hover adds the 5% wash. Icon buttons are borderless and muted, turning to text colour on hover. Text buttons are underlined deep gold.
- **Danger:** red text on a hairline; filled red only as the confirm in a dialog footer. Stop is a filled red 30px square.
- **Focus:** `2px solid var(--focus)` outline, 2px offset (STeP Dark in light, STeP Yellow in dark).
- **Disabled:** filled buttons go grey via the disabled trio; others fade to 45%.

### Chips and badges

- **Badge:** 12px/500 on `--selected`, pill. `ready` uses success wash; `shared` and `demo` use yellow wash with gold ink.
- **Chips:** theme chips, Skill chip, draft-source chips: pill, 12px; checked = yellow border + yellow wash.

### Cards / Containers

- **Corner Style:** 10px. **Background:** paper. **Border:** 1px hairline. **Shadow:** none. **Padding:** 22px (18px/16px on narrow screens).

### Inputs / Fields

- **Style:** surface fill, strong hairline, 6px, `8px 10px`; labels are 500 weight stacked above.
- **Focus:** the shared 2px focus outline; the composer swaps its border to `--focus` instead.

### Navigation

- **Sidebar rows** (tasks, tools, settings): borderless, muted, 7px, hover wash; the current one carries the active marker. Group labels are 12px muted with 0.02em tracking.
- **Rail:** 40px icon buttons in a 60px column; the new-work button is a yellow fill.
- **Command palette** (Ctrl/⌘+K): grouped rows; keyboard focus shows the active marker.

### Signature: the Active Marker

`background: var(--selected)` plus `box-shadow: inset 3px 0 0 var(--accent)`: a 3px yellow bar on the left edge of the current task, the current tool, and the focused command-palette row. It is the only place yellow marks location, and it is shared across all three so "you are here" reads the same everywhere.

### Composer and draft pane

Composer: 10px frame on surface with a paper textarea (14px/1.85), pill toggles and selects for context, a 30px yellow send square. Draft pane: paper, 78px header with gold icon, title, a Markdown toolbar of borderless 12px buttons, the editor (focus = inset 2px focus ring), and source chips.

### Illustrations

Hand-drawn ink scenes shared with Desktop (chat, workspace, skills, receipt, connections, teamwork, idea, media-couple), used only in empty and waiting states: welcome, empty draft pane, tool page headers, login and waiting gates. Decorative (`alt=""`, `aria-hidden`). Provenance and licence: `web/src/assets/illustrations/README.md`.

### Icon motion

Lucide drawings throughout. The folded rail uses lucide-animated icons (shared with Desktop) driven by `motion` 14.1.0; every other icon goes through the `icons.tsx` adapter, which plays one 400ms ease-in-out movement (pulse, turn, add, refresh, nudge) on its control's hover or focus. `prefers-reduced-motion` stops both (and all CSS transitions); the loading spinner slows to 3s rather than disappearing.

### Deliberate web deviations from Desktop

- Workspace switcher lives in the title bar.
- Extra tools: เอกสาร, ความจำ, ค้นงานเก่า. No งานตั้งเวลา.
- The draft pane has a Markdown toolbar instead of Desktop's rich-text editor.
- No model picker (the organization manages the model).
- A consent preview (what AI will read) is shown before any AI call.
- Demo mode shows a yellow-wash chip "ตัวอย่าง · ไม่ใช่ข้อมูลจริง" in the status bar.

## Do's and Don'ts

### Do:

- **Do** take every colour from the CSS custom properties in `src/styles.css`; keep them equal to Desktop's `theme.css` for every token both share.
- **Do** mark the current item with the inset 3px yellow active marker on `--selected`.
- **Do** keep yellow to the one primary action per view, the send button, active markers and checked states.
- **Do** keep Thai text at 12px or larger and body at 14px/1.7.
- **Do** define every new token in light, dark and system-dark blocks.
- **Do** make controls 44px on coarse pointers.
- **Do** use illustrations only in empty and waiting states, decorative, with provenance recorded.

### Don't:

- **Don't** set STeP Yellow text or icons on light surfaces; use `--accent-ink`.
- **Don't** add a separate "web" look: no extra cards, eyebrows above headings, or topbar controls that Desktop does not have.
- **Don't** cast shadows from in-frame cards or panes.
- **Don't** introduce a second typeface or a new state colour.
- **Don't** animate icons when reduced motion is requested.
