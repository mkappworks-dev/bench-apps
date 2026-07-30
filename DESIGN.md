# Design

<!-- Written from the built mockups (devbench-mockup.html, devbench-session-variants.html), per impeccable's process: this documents the world that was actually built and iterated on, not a rulebook decreed in advance. Supersedes the "Visual direction (provisional)" section of the v1 design spec. -->

## Color

Restrained strategy: neutrals plus one non-hue "accent." No colored accent hue — deliberately monochrome, arrived at after an intermediate blue and then teal accent both read as generic/templated. "Accent" is inversion (the highest-contrast neutral available), used only for primary actions and true emphasis — not a separate color to reach for.

Semantic color (success/warning/danger) is separate from accent and never doubles as it — reserved strictly for actual state (response status, the rollup's partial-failure warning), never for decoration or generic interactivity.

| Token | Dark (primary) | Light |
|---|---|---|
| `--bg` | `#08090c` | `#f5f7fa` |
| `--surface` | `#121419` | `#ffffff` |
| `--surface-2` | `#191c22` | `#eef1f6` |
| `--border` | `#24262e` | `#dde3ec` |
| `--text` | `#ecedf2` | `#10151f` |
| `--text-muted` | `#999fac` | `#5b6472` |
| `--text-faint` | `#666d7a` | `#8a92a1` |
| `--accent` / `--accent-strong` / `--accent-on` | `#f2f3f5` / `#ffffff` / `#0a0b0e` | `#10151f` / `#000000` / `#ffffff` |
| `--success` / `--success-bg` | `#3fce85` / `#12271c` | `#167a45` / `#e3f5eb` |
| `--warning` / `--warning-bg` | `#e3a438` / `#2b2210` | `#a3660a` / `#faf0dc` |
| `--danger` / `--danger-bg` | `#e5695f` / `#2b1514` | `#b93a3a` / `#fbe9e9` |
| `--page-glow` (ambient corner glow on page bg) | `rgba(255,255,255,.07)` | `rgba(16,21,31,.025)` |

Dark is the authored default, not an equal alternative to light — a true near-black ground, not "dark gray." Light is fully designed independently (not a naive inversion), and both are always implemented per the standard token pattern: base `:root` = dark, `@media (prefers-color-scheme: light)` override, `:root[data-theme="dark"]` / `:root[data-theme="light"]` for the manual toggle, in that precedence.

## Chrome: ghosty persistent surfaces, glass only on transient overlays

Two different techniques, deliberately not blended:

- **Ghosty** (topbar, sessions sidebar, chat dock, tab bars, the icon rail — anything persistent/always-rendered): transparent background, hairline `1px solid var(--border)` division, no blur. Buttons in this chrome are ghost-style — transparent by default, gaining a `var(--surface-2)` fill only on hover/active.
- **Glass** (only the New Session picker and command-palette overlay — transient, occasional): `backdrop-filter: blur(20-28px) saturate(150-160%)`, translucent `--glass-bg`, a `1px` inner top highlight (`--glass-hi`) for edge refraction, always paired with a solid fallback under `prefers-reduced-transparency`.

This split matches how the named references (Linear, Vercel) actually work — their persistent chrome is flat/minimal, and blur is reserved for their command palettes — and avoids paying blur's compositing cost on surfaces that render continuously in a data-dense tool.

## Typography

One sans role for all UI text (labels, buttons, headings, body) — Operate-mode guidance is explicit that product UI doesn't need display/body pairing. One mono role for all code/data.

- **Sans:** the OS-native system font (San Francisco / Segoe UI Variable / system-ui), not a downloaded display face. This was a deliberate reversal from an earlier Geist pick — Geist has become the default "safe alternative to Inter" that most anti-slop design guidance (including skills installed in this repo) now recommends, which makes it a new cliché rather than an escape from one. Using the native system font sidesteps that arms race entirely rather than picking a different name off the same list.
- **Mono:** target is **Commit Mono** (open license, distinctive, not on common "AI pick" lists) — where a dev tool's typographic personality can legitimately live, since code/data is most of the actual content. Substituted with a system mono stack in the HTML previews since a real font file can't be embedded there; the shipped app self-hosts it properly.

Fixed rem scale, not fluid. Tighter step ratio (~1.125–1.2) than a marketing surface. `font-variant-numeric: tabular-nums` wherever digits line up (response times, rollup counts, status codes).

## Mark and iconography

- **Mark:** an original SVG — one origin node fanning into three connected nodes — encoding the product's actual mechanic (one request, three observed effects: DB/Log/Email), not a generic letter-in-rounded-square.
- **Icons:** custom inline stroke-based SVGs (~1.6–1.8px stroke, `currentColor`), consistent across the app. Never raw platform emoji as icon stand-ins — this was a real contributor to an earlier "flat/generic" read, not just the color palette.

## Layout: three-column shell

Sessions sidebar (ghosty) → main content (its own tab bar: API / DB / Log / Email) → chat dock (ghosty, collapsible — resizes the content column when toggled, never overlays it). The global topbar carries only identity and app-wide actions (theme, chat toggle, settings) — the tool tabs live in the main column, not the topbar, since tabs are part of what a session shows, not global chrome that exists independent of any session. This only became an explicit decision once the app-shell and session-sidebar mockups were actually merged into one artifact; each had put the tabs in a different place.

Reference implementation of the full shell (all four tools, split view, sessions, chat dock): `docs/mockups/devbench.html`.

**Sessions are a pure organizational/history layer — never a view restriction.** This was a deliberate choice among three explored IA variants:
- *Scoped sessions* (session type restricts which tool is visible) and *command-palette* (same restriction, more compact chrome) were both passed over: debugging is exploratory, and forcing a type commitment before a user knows what they'll need works against the correlation rollup being reliably available.
- **Chosen: unified + history.** The main workspace always shows all four tools with the "what happened" rollup live — sessions just let you save and return to named investigations. A session's type badge is an auto-inferred tag for scanning/search, never a gate on what's visible.

**Split view** (within the main content area, chosen variant only): a "Split" control divides the content into two independently-tabbed panes — any of the four tools in either pane — following VS Code's split-editor pattern rather than inventing a new interaction. Answers "what does it look like with more than one tool open" without a fixed, hardcoded pairing.

## Density and motion

Moderate-dense, not airy — the content (request/response bodies, data grids, log lines) is data-heavy, and Operate-mode guidance explicitly permits density over a sparser marketing feel. Motion stays to 150–250ms, state-conveying only (loading, feedback, reveal) — no orchestrated entrance sequences, respecting `prefers-reduced-motion`.

## Shape

Two-tier radius system, applied consistently: `--radius-sm: 6px` for interactive controls (buttons, inputs, chips), `--radius-lg: 12px` for cards/surfaces. One documented rule, followed everywhere — not a single flat radius, not an undocumented mix.
