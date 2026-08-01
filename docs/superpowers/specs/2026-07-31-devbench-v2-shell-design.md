# DevBench v2 shell — design

Six UI changes to the DevBench workspace shell. Four of them are one structural
move; one is a data-model change; one is a small component swap.

Reference mockup: `docs/mockups/devbench-v2-shell.html` (interactive — add tabs,
close them, split, switch sessions, open Settings).

## Motivation

The v1 shell hardcodes four tools as a fixed tab set and spends two rows of
vertical chrome — the OS title bar plus a DevBench-branded header — on an app
that is otherwise dense with data. Both cost space without earning it, and the
fixed tab set makes the common debugging move ("compare `orders` against
`payments`") impossible without losing your place.

## What changes

| # | Change |
|---|---|
| 1 | Theme control removed from the workspace; Settings is its only home |
| 2 | Tools become tab *instances* added via `+`, duplicates allowed |
| 3 | Chat toggle moves inline with the tabs / `+` / Split controls |
| 4 | The DevBench header row is deleted |
| 5 | The native window bar is removed on macOS; traffic lights inset into the strip |
| 6 | Native `<select>` replaced with a styled popup |

## Architecture

### The top strip

`TopBar.tsx` is deleted. In its place, a single 44px strip that is simultaneously
the window drag region, the tab bar, and the home of the global actions.

The strip uses **the same grid columns as the body below it**. This is the
load-bearing detail: it puts each tab group directly above the pane it controls,
and makes the strip's internal divider land exactly on the pane divider.

Those widths are currently Tailwind literals in two unrelated files —
`w-60` on the sessions aside (`SessionsSidebar.tsx:59`) and `w-80` on the chat
aside (`ChatDock.tsx:48`). The strip must match them exactly, and a strip that
reads `240px` while someone later edits `w-60` misaligns silently with nothing
to catch it. So both widths become tokens in `tokens.css`:

```css
--w-sidebar: 15rem;   /* was w-60  */
--w-chat:    20rem;   /* was w-80  */
```

consumed by the asides (`w-[var(--w-sidebar)]`) and by the strip
(`grid-template-columns: var(--w-sidebar) 1fr var(--w-chat)`). One definition,
so they cannot drift. When the chat dock is closed the third column collapses to
`auto` and the actions sit flush right.

```
┌─────────────────────────────────────────────────────────────┐
│ ● ● ●   │ [API] [DB orders] [Log] [+] │ [DB payments] [+] ✕ │ Split  Chat │
├─────────┼─────────────────────────────┼─────────────────────┼─────────────┤
│ Sessions│  left pane                  │  right pane         │  Chat dock  │
```

- **Column 1** (`--w-sidebar`): traffic lights only. Drag region. The OS draws
  them at a fixed window offset, which lands inside this column — no reserved
  padding or platform-conditional inset is required.
- **Column 2** (content width): one `.tabgroup` per pane, each `flex: 1 1 50%`
  so the groups track the panes. Each group holds its tabs plus its own `+`;
  the right group also holds the close-split `✕`.
- **Column 3** (`--w-chat`): Split and Chat toggles, right-aligned.

The strip is `-webkit-app-region: drag` with every interactive child set to
`no-drag`. Without this the window cannot be moved once decorations are off.

A first attempt put the right pane's tabs in a second row inside the pane
itself. It was rejected on sight: the two tab bars sat at different heights, so
neither read as belonging to its pane.

### Window decorations

**`decorations` stays `true`.** This is the opposite of the obvious approach and
the reason matters: `decorations: false` removes the traffic lights along with
everything else. Tauri's own config source is explicit —
`trafficLightPosition` *"Requires titleBarStyle: Overlay and decorations: true"*
(`tauri-utils-2.9.3/src/config.rs:2061-2065`).

```jsonc
"windows": [{
  "title": "DevBench",
  "width": 1280, "height": 800,
  "titleBarStyle": "Overlay",          // macOS only — ignored elsewhere
  "hiddenTitle": true,                 // macOS only — ignored elsewhere
  "trafficLightPosition": { "x": 20, "y": 16 }   // macOS only — ignored elsewhere
}]
```

**No platform branching is needed.** All three added keys are macOS-only and are
ignored on Windows and Linux, where the default `decorations: true` produces the
normal native title bar above our strip. One static config serves all three
platforms; the frontend needs no platform detection and no conditional inset.

`y: 16` centres the 12px controls in the 44px strip (16 + 6 = 22 = 44 / 2).

Two caveats Tauri documents for `Overlay`, both accepted:

- **The window cannot be dragged while unfocused** ([tauri#4316](https://github.com/tauri-apps/tauri/issues/4316)).
  Click to focus, then drag. Not fixable from our side.
- **Title bar height varies across macOS versions**, so `trafficLightPosition`
  is a best fit rather than a guarantee. If it looks off on a given OS version,
  the y value is the single knob to turn.

### Tab instances

`TabId` stops being the identity of a tab. It becomes the *kind* of a tab.

```ts
type ToolKind = "api" | "db" | "log" | "email";

interface Tab {
  id: string;          // stable instance id, also the React key
  kind: ToolKind;
  pane: "left" | "right";
  ordinal: number;     // position within its pane, for stable load order
}
```

`ordinal` exists so tabs reload in the order they were created, not in whatever
order SQLite returns rows. Reordering by drag is out of scope; `ordinal` is
assigned on insert and only rewritten when a tab moves between panes.

The store holds `tabs: Tab[]` for the active session plus
`activeTabId: { left: string | null; right: string | null }`.

Consequences:

- **Split is derived, not stored.** `splitOpen === tabs.some(t => t.pane === "right")`.
  The `splitOpen` and `secondaryTab` store fields are deleted. Closing the last
  right-pane tab collapses the split automatically.
- **Split with one tab open creates a tab rather than emptying a pane.**
  Pressing Split moves the active tab to the right pane — unless it is the left
  pane's only tab, in which case moving it would leave the left pane empty. In
  that case Split instead opens the `+` menu targeting the right pane, so the
  user picks what goes there.
- **Deep links change shape.** The rollup's `setActiveTab("db")` becomes
  "focus the first DB tab in the left pane, or create one" — a helper on the
  store rather than a raw setter.
- **Tab labels disambiguate duplicates.** A DB tab renders `DB` plus its table
  name in mono as a subtitle. Other kinds show the kind alone.

### Tab persistence

Tabs are **per session and persisted**. A new SQLite table:

```sql
CREATE TABLE tabs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,                    -- NULL = the scratch workspace
  kind        TEXT NOT NULL,
  pane        TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  state       TEXT                     -- JSON, tool-specific, nullable
);
```

`session_id IS NULL` is the scratch workspace shown when no session is selected.
It behaves exactly like a session's workspace; it just isn't named.

`state` holds only the tool's *identifying selection*, never its fetched data:

| Kind | Persisted `state` |
|---|---|
| `db` | `{ table }` |
| `log` | `{ sourceId }` |
| `api` | `{ method, url }` |
| `email` | `{}` |

Switching sessions replaces the tab set. Closing a tab deletes its row.

### Three singletons that must become per-tab

This is the part of the change that reaches into the tool components, and the
reason "the tools stay unchanged" is only true of their *fetched* state.

Today three values that identify **what a tool is looking at** live in exactly
one place, which is correct for exactly one tab of each kind:

| Value | Lives today | Breaks because |
|---|---|---|
| `dbFocusTable` | `App.tsx:34` `useState` | Two DB tabs would both jump to the same table |
| `emailFocusId` | `App.tsx:35` `useState` | Both Email tabs select the same message |
| `activeLogSourceId` | `useAppStore.ts:17-18` | Both Log tabs filter to the same source |

All three move into the owning tab's `state`. `ToolPane` gains one prop:

```ts
onPatchState: (patch: Record<string, unknown>) => void
```

which merges into that tab's `state` and persists it. The tools become
controlled for their *selection* only — everything else (fetched rows, buffered
lines, in-flight requests, errors) stays in local `useState` exactly as it is.

Concretely:
- `DbTab` takes `table` from `tab.state.table` and calls `onPatchState({ table })`
  instead of the App-level `dbFocusTable`. The `dbFocusTable` state and the
  `onOpenTableInDb` prop chain are deleted from `App.tsx`.
- `RequestBuilder` currently owns `method`/`url` in local `useState`
  (`RequestBuilder.tsx:17-18`). These become `tab.state`-backed. **URL keystrokes
  are debounced (300ms) before persisting** — otherwise every character is a
  SQLite write.
- `LogTab` takes `sourceId` from `tab.state`; `activeLogSourceId` and its setter
  are removed from the store.
- **Email selection is deliberately NOT persisted.** Email ids come from a
  200-message in-memory ring buffer that resets on restart, so a stored id would
  reliably point at nothing. Selection stays local `useState`; only the
  cross-tool deep link sets it, and it targets one specific tab.

Deep links (`onOpenTableInDb`, `onOpenEmail` from the rollup) therefore change
from "set the global value" to "resolve a target tab, then patch that tab's
state" — creating the tab if none of that kind exists in the left pane.

### Tab lifecycle: mounted, not remounted

**Every tab in the active session stays mounted.** Inactive tabs are hidden with
`display: none`, not unmounted.

This is the decision that keeps each tool's *fetched* state intact — local
`useState` and existing fetch-on-mount effects survive untouched. It also fixes
a behaviour that would otherwise be a regression: a Log tab that unmounts stops
tailing and loses its buffer the moment you glance at another tool.

```tsx
{tabs.filter(t => t.pane === pane).map(t => (
  <div key={t.id} className={t.id === activeTabId[pane] ? "flex min-h-0 flex-1" : "hidden"}>
    <ToolPane tab={t} onPatchState={patch => patchTabState(t.id, patch)} />
  </div>
))}
```

Note the class swap rather than the `hidden` attribute. Tailwind's `hidden`
utility is `display: none`, and any sibling display utility on the same element
would silently beat the `[hidden]` attribute selector — a classic footgun. One
branch, one display value, no specificity race.

The `key={t.id}` is what makes two DB tabs independent: React keeps a separate
component instance, and therefore separate `useState`, per key.

The cost is honest and bounded: four log tabs means four live tail
subscriptions. The user controls how many tabs exist, and closing one unmounts
it and releases its subscription.

### The popup primitive

One component replaces both native `<select>` elements and provides the `+`
menu. Built on Base UI's `Menu` — the same reasoning that put `Tabs` in
`ToolTabs.tsx`: it is here for keyboard behaviour (typeahead, arrow navigation,
focus return, escape-to-close) that hand-rolled menus get wrong.

`ToolTabs.tsx` currently documents itself as "the app's ONLY Base UI import,"
with the stated benefit that dropping the dependency stays a one-file change.
That claim stops being true here. Both Base UI imports move into
`src/components/ui/` (`Tabs.tsx` and `Menu.tsx`), and the comment is rewritten to
say the dependency is confined to that directory. The property being protected
is unchanged; only its boundary moves.

Styling follows DESIGN.md's glass rule — this is a transient overlay, so it gets
`backdrop-filter: blur(22px) saturate(155%)`, the `--glass-hi` inner top
highlight, and a solid fallback under `prefers-reduced-transparency`.

Call sites: the `+` tool menu (two per split), the HTTP method picker in
`RequestBuilder.tsx`, and the theme picker in the new Settings > Appearance pane.

### Theme

`cycleTheme`, `THEME_CYCLE`, and the theme button move out of the workspace
entirely. Settings grows an **Appearance** pane whose theme picker is a
three-option popup (System / Dark / Light) rather than a cycling button — a
cycler was only ever justified by living in a cramped topbar.

The store's `theme` field, the `data-theme` effect in `App.tsx`, and the
`invokeSetSetting("theme", …)` persistence all stay exactly as they are.

### Empty state

A session with no tabs shows a centered prompt — "No tools open", a sentence
explaining that duplicates are allowed, and a button opening the same tool menu
as `+`. New sessions start genuinely empty; nothing is seeded.

## Testing

- **Store**: adding a tab appends to the correct pane; closing the active tab
  promotes a sibling; closing the last right-pane tab collapses the split;
  `splitOpen` derives correctly; Split with a single tab opens the `+` menu
  rather than emptying the left pane.
- **Persistence**: tabs round-trip through SQLite per session; switching
  sessions swaps the set; `session_id IS NULL` scratch workspace persists;
  URL edits are debounced into a single write, not one per keystroke.
- **Independence**: two DB tabs mounted simultaneously hold different tables —
  asserted by rendering both and checking each grid's contents. Patching one
  tab's state leaves its sibling's untouched.
- **Lifecycle**: switching tabs does not unmount the previous tool (assert the
  hidden node is still in the document, and that a Log tab's poll interval is
  still registered).
- **Deep links**: firing a request that touches a watched table focuses a DB tab
  on that table, and creates one if no DB tab exists.
- **Popup**: keyboard open/close/select, and that `RequestBuilder` and the theme
  picker contain no `<select>` element.
- **Strip**: renders without `TopBar`; the theme control is absent from the
  workspace and present in Settings.

Window decoration behaviour is config-only and cannot be asserted in jsdom;
it is verified by launching the app.

## Suggested split into plans

This is large enough for two implementation plans, in this order:

1. **Chrome** (#1, #3, #4, #5, #6) — delete `TopBar`, build the grid-aligned
   strip, the Tauri window config, the width tokens, the popup primitive and its
   three call sites, Settings > Appearance. Touches no data model, ships
   standalone.
2. **Tab instances** (#2) — the store refactor, the `tabs` table, the three
   singletons becoming per-tab, the mounted lifecycle, the empty state.

Plan 1 builds the strip around the *existing* fixed `TABS` array; plan 2 swaps
what feeds it. That is a small, deliberate piece of rework: the strip's layout
(grid columns, actions column, drag region) is what plan 1 establishes and it
does not change in plan 2. The alternative — holding all chrome work back until
the data model lands — makes a single oversized plan for no benefit.

## Out of scope

Drag-to-reorder tabs, drag-a-tab-between-panes, tab overflow menus, more than
two panes, custom window controls on Windows/Linux, and renaming tabs. The `+`
menu and the close button are the whole interaction surface for v2.
