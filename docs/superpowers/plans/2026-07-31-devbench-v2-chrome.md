# DevBench v2 Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DevBench's two rows of top chrome (native title bar + branded header) with a single grid-aligned strip, and replace both native `<select>` elements with a styled popup.

**Architecture:** A new `AppStrip` component owns the topmost 44px row. It is laid out as a CSS grid using *the same column widths as the body below it*, so the tool tabs sit directly above the pane they control and the strip's divider lands on the pane divider. macOS traffic lights float in the first column via Tauri's overlay title bar. Base UI imports are consolidated into `src/components/ui/`.

**Tech Stack:** React 18, TypeScript, Zustand, Tailwind v4 (CSS-first `@theme`), Base UI `1.0.0-rc.0`, Vitest + @testing-library/react, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-07-31-devbench-v2-shell-design.md`
**Reference mockup:** `docs/mockups/devbench-v2-shell.html`

## Scope

This is **plan 1 of 2**. It implements spec items #1, #3, #4, #5, #6. Item #2
(tab instances added via `+`, duplicates allowed) is plan 2 and depends on this
plan owning the strip.

Consequence to accept deliberately: this plan builds the strip around the
**existing fixed `TABS` array**. Plan 2 swaps what feeds it. The strip's layout —
grid columns, actions column, drag region — is established here and does not
change in plan 2.

## Global Constraints

- **Run tests from `apps/devbench`:** `bun run test` (vitest). A single file: `bun run test -- src/path/File.test.tsx`.
- **Tailwind v4, CSS-first.** No `theme.extend` in `tailwind.config.ts`; tokens are CSS custom properties in `src/styles/tokens.css`, surfaced to utilities via the `@theme` block in `src/styles/globals.css`.
- **Base UI is confined to `src/components/ui/`.** No other file may import from `@base-ui-components/react`.
- **DESIGN.md chrome rule:** persistent surfaces (strip, sidebars, tab bars) are *ghosty* — transparent background, `1px solid var(--border)` hairline, **no blur**. Only transient overlays (menus, pickers) are *glass* — `backdrop-filter: blur(20-28px) saturate(150-160%)`, plus a solid fallback under `prefers-reduced-transparency`.
- **Motion:** 150–250ms, state-conveying only.
- **Radius:** `--radius-sm` (6px) for interactive controls, `--radius-lg` (12px) for cards/surfaces/popups.
- **Never use raw emoji as icons.** Inline stroke SVGs, `currentColor`, ~1.6–1.8px stroke.
- **Comments stay sparse.** No multi-paragraph doc blocks above components, no comments restating what the code says. Comment only what a reader cannot infer: non-obvious library behaviour, a bug being guarded against, a deliberate deviation from the obvious approach. Design rationale belongs in the spec, not duplicated above every component. **This overrides the comment volume shown in this plan's own code blocks** — where they disagree, this rule wins.
- **Every `Menu` trigger is named by its `label` prop** via `aria-label`, in both picker and action-list mode. Its visible text is the current value ("POST", "Dark") or an icon, neither of which identifies the control. Tests locate triggers by that name.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/ui/Menu.tsx` | **New.** The only dropdown in the app — action list or value-bound picker. Owns the glass styling and the `ChevronIcon` every trigger uses. | 2 |
| `src/components/ui/Tabs.tsx` | **New.** Re-exports Base UI's tabs. Exists so the dependency has one doorway. | 4 |
| `src/components/ui/boundary.test.ts` | **New.** Enforces that `@base-ui-components/react` is imported only from `ui/`. Replaces a comment that had already rotted. | 4 |
| `src/components/shell/tools.ts` | **New.** The `TABS` constant, extracted so it is not coupled to a component that is about to be deleted. | 4 |
| `src/components/shell/AppStrip.tsx` | **New.** The top row: drag region, both panes' tab groups, Split and Chat. Owns the grid that keeps tabs aligned with panes. | 5 |
| `src/components/settings/AppearancePane.tsx` | **New.** The theme control's only home. | 7 |
| `src/components/shell/TopBar.tsx` | **Deleted.** Its three responsibilities are redistributed: identity dropped, theme → Settings, chat → strip. | 6 |
| `src/components/shell/ToolTabs.tsx` | **Deleted.** Absorbed into `AppStrip`'s `TabGroup`. | 6 |
| `src/components/shell/SplitContent.tsx` | **Shrinks** to panes only — no tab bars, no Split button. | 6 |
| `src/styles/tokens.css` | Gains `--w-sidebar` / `--w-chat` so the strip and the body cannot drift apart. | 1 |
| `src-tauri/tauri.conf.json` | Gains the macOS overlay title bar. | 8 |

The through-line: three files that each owned a slice of top chrome collapse
into one (`AppStrip`), and two files that each reached for Base UI directly now
go through one directory (`ui/`).

---

### Task 1: Shared width tokens

The strip's grid must match the sidebar and chat dock widths exactly. Those
widths are currently Tailwind literals in two unrelated files, so a strip
hardcoding `240px` would silently misalign if anyone edits `w-60`. One
definition, consumed by all three.

**Files:**
- Modify: `apps/devbench/src/styles/tokens.css`
- Modify: `apps/devbench/src/components/shell/SessionsSidebar.tsx:59`
- Modify: `apps/devbench/src/components/shell/ChatDock.tsx:48`
- Test: `apps/devbench/src/styles/tokens.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--w-sidebar` (15rem) and `--w-chat` (20rem), readable from `document.documentElement`.

- [ ] **Step 1: Write the failing test**

Append to `apps/devbench/src/styles/tokens.test.tsx`, inside the existing `describe`:

```tsx
  // The app strip's grid columns must match the sidebar and chat dock widths
  // exactly, or the tab groups stop lining up with the panes they control.
  // One definition here is what keeps them from drifting apart.
  it("exposes the shell width tokens", () => {
    render(<div />);
    const root = getComputedStyle(document.documentElement);
    expect(root.getPropertyValue("--w-sidebar").trim()).toBe("15rem");
    expect(root.getPropertyValue("--w-chat").trim()).toBe("20rem");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/styles/tokens.test.tsx`
Expected: FAIL — `expected '' to be '15rem'`.

- [ ] **Step 3: Add the tokens**

In `apps/devbench/src/styles/tokens.css`, add to the base `:root` block (after `--radius-lg: 12px;`):

```css
  /* Shell geometry. The app strip's grid columns reference these so the tab
     groups stay aligned with the panes below them. */
  --w-sidebar: 15rem;
  --w-chat: 20rem;
```

Leave the `@media (prefers-color-scheme: light)` and `[data-theme]` blocks alone —
these are geometry, not colour, and must not vary by theme.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/styles/tokens.test.tsx`
Expected: PASS.

- [ ] **Step 5: Consume the tokens**

In `apps/devbench/src/components/shell/SessionsSidebar.tsx:59`, replace `w-60 min-w-60`:

```tsx
    <aside aria-label="Sessions" className="flex w-[var(--w-sidebar)] min-w-[var(--w-sidebar)] flex-col border-r border-border">
```

In `apps/devbench/src/components/shell/ChatDock.tsx:48`, replace `w-80 min-w-80`:

```tsx
    <aside aria-label="AI Assistant" className="flex w-[var(--w-chat)] min-w-[var(--w-chat)] flex-col border-l border-border">
```

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS. `15rem` = the old `w-60` (240px) and `20rem` = the old `w-80` (320px), so nothing moves.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/styles/tokens.css apps/devbench/src/styles/tokens.test.tsx apps/devbench/src/components/shell/SessionsSidebar.tsx apps/devbench/src/components/shell/ChatDock.tsx
git commit -m "refactor(devbench): hoist the shell column widths into tokens"
```

---

### Task 2: The `Menu` popup primitive

One component serving every dropdown in the app. Two shapes: a plain action list
(used by plan 2's `+`) and a value-bound picker (used by the HTTP method and
theme controls). The value-bound shape uses Base UI's `RadioGroup`/`RadioItem`
so `aria-checked` and roving focus come for free rather than being reimplemented.

**Files:**
- Create: `apps/devbench/src/components/ui/Menu.tsx`
- Test: `apps/devbench/src/components/ui/Menu.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface MenuOption { value: string; label: string; description?: string; icon?: React.ReactNode }`
  - `function Menu(props: { label: string; options: MenuOption[]; value?: string; onSelect: (value: string) => void; trigger: React.ReactNode; triggerClassName?: string; align?: "start" | "end" }): JSX.Element`
  - When `value` is supplied the menu renders as a radio group and marks the match `aria-checked`. When omitted it renders plain action items.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/ui/Menu.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./Menu";

const OPTIONS = [
  { value: "api", label: "API", description: "Send requests" },
  { value: "db", label: "DB", description: "Browse rows" },
];

describe("Menu", () => {
  it("opens on trigger click and reports the chosen value", () => {
    const onSelect = vi.fn();
    render(<Menu label="Add a tool" options={OPTIONS} onSelect={onSelect} trigger="Add" />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));

    fireEvent.click(screen.getByRole("menuitem", { name: /DB/ }));
    expect(onSelect).toHaveBeenCalledWith("db");
  });

  // A value-bound menu is a picker, not an action list: exactly one option is
  // checked, which is what lets it stand in for a native <select>.
  it("marks the current value as checked when used as a picker", () => {
    render(<Menu label="Theme" options={OPTIONS} value="db" onSelect={() => {}} trigger="Theme" />);
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));

    const items = screen.getAllByRole("menuitemradio");
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveAttribute("aria-checked", "false");
  });

  it("labels the popup for screen readers", () => {
    render(<Menu label="Add a tool" options={OPTIONS} onSelect={() => {}} trigger="Add" />);
    fireEvent.click(screen.getByRole("button", { name: /add a tool/i }));
    expect(screen.getByRole("menu")).toHaveAccessibleName("Add a tool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/ui/Menu.test.tsx`
Expected: FAIL — cannot resolve `./Menu`.

- [ ] **Step 3: Write the implementation**

Create `apps/devbench/src/components/ui/Menu.tsx`:

```tsx
import { Menu as BaseMenu } from "@base-ui-components/react/menu";

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-sm " +
  "text-text-muted transition-colors duration-150 outline-none " +
  "data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

/**
 * Every dropdown in the app. Base UI supplies the behaviour a hand-rolled menu
 * reliably gets wrong — typeahead, arrow navigation, focus return on close,
 * escape-to-dismiss, and correct `menu`/`menuitem` wiring.
 *
 * Passing `value` switches the menu from an action list to a picker: it renders
 * radio items so exactly one option carries `aria-checked`. That is what makes
 * it a legitimate replacement for a native `<select>` rather than a lookalike.
 *
 * Glass, not ghosty — DESIGN.md reserves blur for transient overlays, which is
 * precisely what a menu is. The solid fallback under `prefers-reduced-transparency`
 * is required, not optional.
 */
export function Menu({
  label,
  options,
  value,
  onSelect,
  trigger,
  triggerClassName,
  align = "start",
}: {
  label: string;
  options: MenuOption[];
  value?: string;
  onSelect: (value: string) => void;
  trigger: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const isPicker = value !== undefined;

  const body = options.map((option) =>
    isPicker ? (
      <BaseMenu.RadioItem key={option.value} value={option.value} className={ITEM_CLASS}>
        <OptionBody option={option} />
        <BaseMenu.RadioItemIndicator className="ml-auto text-text">
          <CheckIcon />
        </BaseMenu.RadioItemIndicator>
      </BaseMenu.RadioItem>
    ) : (
      <BaseMenu.Item key={option.value} className={ITEM_CLASS} onClick={() => onSelect(option.value)}>
        <OptionBody option={option} />
      </BaseMenu.Item>
    ),
  );

  return (
    <BaseMenu.Root>
      {/* aria-label on the trigger, not just the popup: the trigger's visible
          text is the current *value* ("POST", "Dark"), which is not a usable
          name for the control. Tests address it as `name: /method/i`. */}
      <BaseMenu.Trigger aria-label={label} className={triggerClassName}>
        {trigger}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-50">
          <BaseMenu.Popup
            aria-label={label}
            className="min-w-52 rounded-lg border border-border bg-surface p-1.5 shadow-lg backdrop-blur-[24px]"
          >
            <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-text-faint">
              {label}
            </div>
            {isPicker ? (
              <BaseMenu.RadioGroup value={value} onValueChange={(next) => onSelect(String(next))}>
                {body}
              </BaseMenu.RadioGroup>
            ) : (
              body
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

function OptionBody({ option }: { option: MenuOption }) {
  return (
    <>
      {option.icon ? <span className="shrink-0 text-text-faint">{option.icon}</span> : null}
      <span>
        <span className="block font-medium text-text">{option.label}</span>
        {option.description ? (
          <span className="block text-xs text-text-faint">{option.description}</span>
        ) : null}
      </span>
    </>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** Exported because every Menu trigger in the app ends with one. */
export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-faint">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/components/ui/Menu.test.tsx`
Expected: PASS, all three.

If `aria-checked` is absent, the `RadioGroup` is not wrapping the items — check
that `isPicker` is true (`value` must be a string, and `""` counts as supplied).

- [ ] **Step 5: Confirm the reduced-transparency fallback covers this popup**

`apps/devbench/src/styles/globals.css:33-38` already scopes the fallback to
`.backdrop-blur-\[24px\]`, which is the exact class used above. Read those lines
and confirm — do not add a second rule.

- [ ] **Step 6: Commit**

```bash
git add apps/devbench/src/components/ui/Menu.tsx apps/devbench/src/components/ui/Menu.test.tsx
git commit -m "feat(devbench): add the Menu popup primitive"
```

---

### Task 3: Replace both native `<select>` elements

Two call sites, one mechanical change each. They are one task because a reviewer
would accept or reject them together.

**Files:**
- Modify: `apps/devbench/src/components/api/RequestBuilder.tsx:40-49`
- Modify: `apps/devbench/src/components/settings/ProviderPane.tsx:108`
- Test: `apps/devbench/src/components/api/RequestBuilder.test.tsx`
- Test: `apps/devbench/src/components/settings/ProviderPane.test.tsx`

**Interfaces:**
- Consumes: `Menu`, `MenuOption` from `../ui/Menu` (Task 2).
- Produces: nothing new. `RequestBuilder` keeps its existing props and its local `method`/`url` state; only the control changes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/devbench/src/components/api/RequestBuilder.test.tsx`, inside the existing top-level `describe`:

```tsx
  // Spec item 6: no native <select> anywhere. The method control must be the
  // shared Menu primitive so it matches every other dropdown in the app.
  it("uses the styled menu rather than a native select for the method", () => {
    const { container } = renderBuilder();
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /method/i })).toBeInTheDocument();
  });

  // PATCH was absent from the old four-option select entirely.
  it("changes the method through the menu, including PATCH", () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: /method/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "PATCH" }));
    expect(screen.getByRole("button", { name: /method/i })).toHaveTextContent("PATCH");
  });
```

`RequestBuilder` takes `connection`, `watchedTables`, `onResult`, and the
optional `onSendStart` / `onError` (`RequestBuilder.tsx:4-15`). Reuse the file's
existing render helper if it has one; otherwise add:

```tsx
function renderBuilder() {
  return render(
    <RequestBuilder
      connection={{ host: "localhost", port: 5432, database: "devbench_test", username: "postgres", password: "postgres" }}
      watchedTables={new Set()}
      onResult={() => {}}
    />,
  );
}
```

`render`, `screen`, and `fireEvent` are already imported at
`RequestBuilder.test.tsx:1`.

Append to `apps/devbench/src/components/settings/ProviderPane.test.tsx`, inside its top-level `describe`:

```tsx
  it("uses the styled menu rather than a native select for the model", () => {
    const { container } = render(<ProviderPane />);
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /model/i })).toBeInTheDocument();
  });
```

If `RequestBuilder.test.tsx` does not already import `fireEvent` or `screen`
from `@testing-library/react`, add them to that import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/components/api/RequestBuilder.test.tsx src/components/settings/ProviderPane.test.tsx`
Expected: FAIL — a `select` element is found, and no button named "Method" exists.

- [ ] **Step 3: Replace the method select**

In `apps/devbench/src/components/api/RequestBuilder.tsx`, add the import:

```tsx
import { Menu, ChevronIcon } from "../ui/Menu";
```

Add the method list above the component (PATCH is included — it was missing from
the old four-option select, and the spec calls for it):

```tsx
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }));
```

Replace the `<select>` block at lines 40-49 with:

```tsx
      <Menu
        label="Method"
        options={METHODS}
        value={method}
        onSelect={setMethod}
        trigger={
          <>
            {method}
            <ChevronIcon />
          </>
        }
        triggerClassName="flex h-9 w-28 shrink-0 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 font-mono text-sm font-semibold text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
      />
```

The `aria-label="Method"` the test addresses comes from `Menu` applying its
`label` prop to `BaseMenu.Trigger` (Task 2).

- [ ] **Step 4: Replace the model select**

Note this control is a **model** picker, not a provider picker — it is driven by
the existing `MODELS` array and `saveModel`, and it lives in the "Model"
`<section>`. Do not rename either.

In `apps/devbench/src/components/settings/ProviderPane.tsx`, replace the
`<label htmlFor="model">` + `<select id="model">` pair with:

```tsx
        <div className="text-sm font-semibold text-text">Model</div>
        <Menu
          label="Model"
          options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
          value={status?.model ?? "claude-opus-5"}
          onSelect={(next) => void saveModel(next)}
          trigger={
            <>
              {MODELS.find((m) => m.id === (status?.model ?? "claude-opus-5"))?.label ?? "Select a model"}
              <ChevronIcon />
            </>
          }
          triggerClassName="mt-2 flex h-9 w-full max-w-80 items-center justify-between gap-2 rounded-sm border border-border bg-surface-2 px-2.5 text-sm text-text transition-colors duration-150 hover:border-text-faint"
        />
```

The `<label htmlFor="model">` becomes a plain `<div>` because a `<label>` cannot
be associated with a `<button>` — the accessible name now comes from the
trigger's `aria-label`, which `Menu` sets from its `label` prop.

Import both from the primitive: `import { Menu, ChevronIcon } from "../ui/Menu";`

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- src/components/api/RequestBuilder.test.tsx src/components/settings/ProviderPane.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS. Any other test asserting on the old `<select>` must be updated to
the menu, not deleted.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/api/RequestBuilder.tsx apps/devbench/src/components/api/RequestBuilder.test.tsx apps/devbench/src/components/settings/ProviderPane.tsx apps/devbench/src/components/settings/ProviderPane.test.tsx apps/devbench/src/components/ui/Menu.tsx
git commit -m "feat(devbench): replace both native selects with the Menu primitive"
```

---

### Task 4: Consolidate Base UI into `src/components/ui/`

`ToolTabs.tsx:15-24` documents itself as "the app's ONLY Base UI import," and
that comment is **already wrong** — `SettingsScreen.tsx:2` imports
`@base-ui-components/react/tabs` directly. Task 2 added a third. Rather than
letting the claim rot further, move the imports behind one directory and rewrite
the comment to describe the boundary that actually holds.

**Files:**
- Create: `apps/devbench/src/components/ui/Tabs.tsx`
- Create: `apps/devbench/src/components/shell/tools.ts`
- Modify: `apps/devbench/src/components/shell/ToolTabs.tsx:1-24`
- Modify: `apps/devbench/src/components/settings/SettingsScreen.tsx:2`
- Modify: `apps/devbench/src/App.tsx:4,11`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/components/ui/Tabs.tsx` re-exports Base UI's tabs as `export { Tabs }`.
  - `src/components/shell/tools.ts` exports `const TABS: { id: TabId; label: string }[]` — the same four entries, same order, moved verbatim.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/ui/boundary.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("Base UI boundary", () => {
  // Base UI is a dependency we want to be able to drop. Confining every import
  // to src/components/ui/ keeps that a one-directory change. This test is the
  // enforcement — the previous approach was a comment, and it silently rotted.
  it("is imported only from src/components/ui/", () => {
    const offenders = walk(SRC)
      .filter((path) => !path.includes(join("components", "ui")))
      .filter((path) => readFileSync(path, "utf8").includes("@base-ui-components/react"))
      .map((path) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/ui/boundary.test.ts`
Expected: FAIL, listing `components/shell/ToolTabs.tsx` and `components/settings/SettingsScreen.tsx`.

- [ ] **Step 3: Create the Tabs re-export**

Create `apps/devbench/src/components/ui/Tabs.tsx`:

```tsx
/**
 * Base UI's tabs, re-exported. Base UI is here for behaviour a hand-rolled tab
 * bar keeps getting wrong — roving tabindex, arrow-key navigation, correct
 * `tablist`/`tab` wiring.
 *
 * Every Base UI import in the app lives in this directory, so dropping the
 * dependency stays a one-directory change. `boundary.test.ts` enforces it; the
 * previous single-file claim was only a comment and had already been violated.
 */
export { Tabs } from "@base-ui-components/react/tabs";
```

- [ ] **Step 4: Move the TABS constant**

Create `apps/devbench/src/components/shell/tools.ts`:

```ts
import type { TabId } from "../../store/useAppStore";

/**
 * Single source of truth for the tool tabs. Adding a fifth tool is one entry
 * here (see the post-v1 roadmap: outbound HTTP inspector, jobs, cache…).
 */
export const TABS: { id: TabId; label: string }[] = [
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "log", label: "Log" },
  { id: "email", label: "Email" },
];
```

- [ ] **Step 5: Repoint the importers**

In `apps/devbench/src/App.tsx`, change line 4 and line 11:

```tsx
import { TABS } from "./components/shell/tools";
```
```tsx
export { TABS };
```

(The re-export stays — `App.test.tsx` and any external consumer keep working.)

In `apps/devbench/src/components/settings/SettingsScreen.tsx`, change line 2:

```tsx
import { Tabs } from "../ui/Tabs";
```

In `apps/devbench/src/components/shell/ToolTabs.tsx`, change line 1 to import
from the new boundary, and delete the now-moved `TABS` constant (lines 8-13) and
its `TabId` import:

```tsx
import { Tabs } from "../ui/Tabs";
import { TABS } from "./tools";
import type { TabId } from "../../store/useAppStore";
```

Rewrite the file's doc comment — the "app's ONLY Base UI import" claim is gone:

```tsx
/**
 * The tool tab bar. Styling is ours, ghosty per DESIGN.md — transparent until
 * hover, hairline border, no blur, `--radius-sm`.
 *
 * Base UI now comes via `../ui/Tabs`; see that file for why the dependency is
 * confined to one directory.
 */
```

`SplitContent.tsx` keeps importing `ToolTabs` unchanged — Task 6 deletes both.
Leaving `ToolTabs.tsx` in place here rather than inlining it keeps this task a
pure import move with no behaviour change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS, including `boundary.test.ts` with an empty offender list.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/ui apps/devbench/src/components/shell/tools.ts apps/devbench/src/components/shell/ToolTabs.tsx apps/devbench/src/App.tsx apps/devbench/src/components/settings/SettingsScreen.tsx
git commit -m "refactor(devbench): confine Base UI imports to components/ui"
```

---

### Task 5: The `AppStrip` component

The centrepiece. A 44px grid whose columns are `--w-sidebar | 1fr | --w-chat`,
so the tab groups sit directly above the panes they control.

**Files:**
- Create: `apps/devbench/src/components/shell/AppStrip.tsx`
- Test: `apps/devbench/src/components/shell/AppStrip.test.tsx`

**Interfaces:**
- Consumes: `Tabs` from `../ui/Tabs` (Task 4), `TABS` from `./tools` (Task 4), `TabId` from `../../store/useAppStore`.
- Produces:
```ts
function AppStrip(props: {
  activeTab: TabId;
  secondaryTab: TabId;
  splitOpen: boolean;
  chatOpen: boolean;
  onActiveTabChange: (tab: TabId) => void;
  onSecondaryTabChange: (tab: TabId) => void;
  onToggleSplit: () => void;
  onCloseSplit: () => void;
  onToggleChat: () => void;
}): JSX.Element
```

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/shell/AppStrip.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppStrip } from "./AppStrip";

const BASE = {
  activeTab: "api" as const,
  secondaryTab: "db" as const,
  splitOpen: false,
  chatOpen: true,
  onActiveTabChange: () => {},
  onSecondaryTabChange: () => {},
  onToggleSplit: () => {},
  onCloseSplit: () => {},
  onToggleChat: () => {},
};

describe("AppStrip", () => {
  // Spec item 4: the branded header row is gone. The strip carries tools and
  // actions only — no wordmark, no identity.
  it("carries no product wordmark", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByText("DevBench")).not.toBeInTheDocument();
  });

  // Spec item 1: the theme control's only home is Settings.
  it("offers no theme control", () => {
    render(<AppStrip {...BASE} />);
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
  });

  // Spec item 3: chat sits inline with the tabs and split controls.
  it("toggles the chat dock and reflects its state", () => {
    const onToggleChat = vi.fn();
    const { rerender } = render(<AppStrip {...BASE} onToggleChat={onToggleChat} />);
    const button = screen.getByRole("button", { name: /toggle ai chat/i });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleChat).toHaveBeenCalled();

    rerender(<AppStrip {...BASE} chatOpen={false} onToggleChat={onToggleChat} />);
    expect(screen.getByRole("button", { name: /toggle ai chat/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows one tablist when unsplit and two when split", () => {
    const { rerender } = render(<AppStrip {...BASE} />);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    rerender(<AppStrip {...BASE} splitOpen />);
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("selects a tool in the primary pane", () => {
    const onActiveTabChange = vi.fn();
    render(<AppStrip {...BASE} onActiveTabChange={onActiveTabChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(onActiveTabChange).toHaveBeenCalledWith("log");
  });

  // The grid must track the body's columns, or the tab groups stop lining up
  // with the panes. When the chat dock is closed its column collapses.
  it("mirrors the body grid columns and collapses the chat column when closed", () => {
    const { container, rerender } = render(<AppStrip {...BASE} />);
    // Assert the raw style attribute, not `.style.gridTemplateColumns` —
    // jsdom's CSSOM does not reliably round-trip shorthand grid properties
    // containing var(), and would return "" here.
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr var(--w-chat)",
    );
    rerender(<AppStrip {...BASE} chatOpen={false} />);
    expect(container.querySelector("header")!.getAttribute("style")).toContain(
      "grid-template-columns: var(--w-sidebar) 1fr auto",
    );
  });

  it("closes the split from the secondary group", () => {
    const onCloseSplit = vi.fn();
    render(<AppStrip {...BASE} splitOpen onCloseSplit={onCloseSplit} />);
    fireEvent.click(screen.getByRole("button", { name: /close split/i }));
    expect(onCloseSplit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/shell/AppStrip.test.tsx`
Expected: FAIL — cannot resolve `./AppStrip`.

- [ ] **Step 3: Write the implementation**

Create `apps/devbench/src/components/shell/AppStrip.tsx`:

```tsx
import { Tabs } from "../ui/Tabs";
import { TABS } from "./tools";
import type { TabId } from "../../store/useAppStore";

/** Grid columns mirror the body's so each tab group sits above the pane it controls. */
export function AppStrip({
  activeTab,
  secondaryTab,
  splitOpen,
  chatOpen,
  onActiveTabChange,
  onSecondaryTabChange,
  onToggleSplit,
  onCloseSplit,
  onToggleChat,
}: {
  activeTab: TabId;
  secondaryTab: TabId;
  splitOpen: boolean;
  chatOpen: boolean;
  onActiveTabChange: (tab: TabId) => void;
  onSecondaryTabChange: (tab: TabId) => void;
  onToggleSplit: () => void;
  onCloseSplit: () => void;
  onToggleChat: () => void;
}) {
  return (
    <header
      // `data-tauri-drag-region` is what makes the window movable once the
      // native title bar is an overlay. Interactive children opt out below.
      data-tauri-drag-region
      style={{ gridTemplateColumns: `var(--w-sidebar) 1fr ${chatOpen ? "var(--w-chat)" : "auto"}` }}
      className="grid h-11 shrink-0 border-b border-border"
    >
      {/* Column 1 — the macOS traffic lights float here, drawn by the OS. */}
      <div aria-hidden="true" data-tauri-drag-region />

      {/* Column 2 — one tab group per pane, each tracking its pane's width. */}
      <div className="flex min-w-0">
        <TabGroup value={activeTab} onValueChange={onActiveTabChange} label="Primary pane tools" />
        {splitOpen ? (
          <TabGroup
            value={secondaryTab}
            onValueChange={onSecondaryTabChange}
            label="Secondary pane tools"
            className="border-l border-border"
            trailing={
              <button
                aria-label="Close split"
                onClick={onCloseSplit}
                className="ml-auto grid size-7 shrink-0 place-items-center rounded-sm text-text-faint transition-colors duration-150 hover:bg-surface-2 hover:text-text"
              >
                <CloseIcon />
              </button>
            }
          />
        ) : null}
      </div>

      {/* Column 3 — global actions, right-aligned over the chat dock. */}
      <div className="flex items-center justify-end gap-0.5 px-2.5">
        <button
          aria-label="Toggle split view"
          aria-pressed={splitOpen}
          onClick={onToggleSplit}
          className={ACTION_CLASS}
        >
          <SplitIcon />
          <span>Split</span>
        </button>
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        <button
          aria-label="Toggle AI chat"
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={ACTION_CLASS}
        >
          <ChatIcon />
          <span>Chat</span>
        </button>
      </div>
    </header>
  );
}

const ACTION_CLASS =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-text-muted " +
  "transition-colors duration-150 hover:bg-surface-2 hover:text-text " +
  "aria-pressed:bg-surface-2 aria-pressed:text-text";

function TabGroup({
  value,
  onValueChange,
  label,
  className = "",
  trailing,
}: {
  value: TabId;
  onValueChange: (tab: TabId) => void;
  label: string;
  className?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onValueChange(next as TabId)}
      className={`flex min-w-0 flex-1 items-center gap-0.5 px-2 ${className}`}
    >
      <Tabs.List className="flex min-w-0 gap-0.5 overflow-x-auto" aria-label={label}>
        {TABS.map((tab) => (
          <Tabs.Tab
            key={tab.id}
            value={tab.id}
            // Base UI renders its own selection attribute; this explicit
            // data-selected is what the styling below keys off.
            data-selected={tab.id === value ? "" : undefined}
            className="shrink-0 rounded-sm px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 data-[selected]:bg-surface-2 data-[selected]:font-semibold data-[selected]:text-text"
          >
            {tab.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {trailing}
    </Tabs.Root>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/components/shell/AppStrip.test.tsx`
Expected: PASS, all seven.

If the grid-columns assertion fails, confirm the value is applied via the inline
`style` prop and not a Tailwind arbitrary class — `getAttribute("style")` only
sees inline styles.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src/components/shell/AppStrip.tsx apps/devbench/src/components/shell/AppStrip.test.tsx
git commit -m "feat(devbench): add the grid-aligned app strip"
```

---

### Task 6: Wire the strip in, delete `TopBar`

**Files:**
- Modify: `apps/devbench/src/App.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.tsx`
- Modify: `apps/devbench/src/components/shell/SplitContent.test.tsx`
- Modify: `apps/devbench/src/App.test.tsx:77-95`
- Delete: `apps/devbench/src/components/shell/TopBar.tsx`
- Delete: `apps/devbench/src/components/shell/TopBar.test.tsx`

**Interfaces:**
- Consumes: `AppStrip` (Task 5).
- Produces: `SplitContent` loses `dbFocusTable`-unrelated chrome — its signature keeps the four existing props and it no longer renders any tab bar or Split button.

- [ ] **Step 1: Write the failing test**

All four existing tests in `apps/devbench/src/components/shell/SplitContent.test.tsx`
assert on chrome that is moving to `AppStrip` — tablist counts, the Split button,
the Close-split button, and tab selection. `AppStrip.test.tsx` (Task 5) already
covers every one of those. Replace the file wholesale so `SplitContent` is tested
for what it now does: render the right tool in each pane.

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { SplitContent } from "./SplitContent";
import { useAppStore } from "../../store/useAppStore";

function renderSplit() {
  return render(
    <SplitContent
      dbFocusTable={null}
      emailFocusId={null}
      onOpenTableInDb={() => {}}
      onOpenEmail={() => {}}
    />,
  );
}

describe("SplitContent", () => {
  beforeEach(() => {
    useAppStore.getState().setSplitOpen(false);
    useAppStore.getState().setActiveTab("api");
    useAppStore.getState().setSecondaryTab("db");
  });

  // The tab bars moved up into AppStrip so they could align with the panes they
  // control. SplitContent renders panes and nothing else.
  it("renders no tab bar or split control of its own", () => {
    renderSplit();
    expect(screen.queryAllByRole("tablist")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^split$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close split/i })).not.toBeInTheDocument();
  });

  it("renders one pane when not split", () => {
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders two panes when split, one per tool", () => {
    useAppStore.getState().setSplitOpen(true);
    renderSplit();
    expect(screen.getAllByRole("main")).toHaveLength(2);
  });
});
```

`<main>` maps to the `main` ARIA role, which is what makes the pane count
assertable without reaching for test ids.

In `apps/devbench/src/App.test.tsx`, the test at line 80 —
"persists the theme when cycled from the TopBar button" — clicks a button that
no longer exists. Change its first line to skip it, leaving everything else
intact so Task 7 can retarget it:

```tsx
  // Re-enabled and retargeted in Task 7 against Settings > Appearance, which
  // becomes the theme control's only home once the TopBar button is gone
  // (spec item 1). The bug it guards is unchanged.
  it.skip("persists the theme when cycled from the TopBar button", async () => {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- src/components/shell/SplitContent.test.tsx`
Expected: FAIL — two tablists and a Split button are still found.

- [ ] **Step 3: Strip the chrome out of `SplitContent`**

Replace `apps/devbench/src/components/shell/SplitContent.tsx` entirely:

```tsx
import { ToolPane } from "./ToolPane";
import { useAppStore } from "../../store/useAppStore";

/**
 * Panes only. The tab bars and the Split control live in AppStrip, so that each
 * pane's tabs can sit directly above the pane in the same grid column.
 */
export function SplitContent({
  dbFocusTable,
  emailFocusId,
  onOpenTableInDb,
  onOpenEmail,
}: {
  dbFocusTable: string | null;
  emailFocusId: number | null;
  onOpenTableInDb: (table: string) => void;
  onOpenEmail: (id: number | null) => void;
}) {
  const activeTab = useAppStore((s) => s.activeTab);
  const secondaryTab = useAppStore((s) => s.secondaryTab);
  const splitOpen = useAppStore((s) => s.splitOpen);

  const paneProps = { dbFocusTable, emailFocusId, onOpenTableInDb, onOpenEmail };

  return (
    <div className="flex min-h-0 flex-1">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <ToolPane tab={activeTab} {...paneProps} />
      </main>
      {splitOpen ? (
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto border-l border-border p-6">
          <ToolPane tab={secondaryTab} {...paneProps} />
        </main>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Wire `AppStrip` into `App.tsx`**

In `apps/devbench/src/App.tsx`:

Replace the `TopBar` import (line 3) with:

```tsx
import { AppStrip } from "./components/shell/AppStrip";
```

Add the store reads the strip now needs, alongside the existing ones:

```tsx
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const secondaryTab = useAppStore((s) => s.secondaryTab);
  const setSecondaryTab = useAppStore((s) => s.setSecondaryTab);
  const splitOpen = useAppStore((s) => s.splitOpen);
  const setSplitOpen = useAppStore((s) => s.setSplitOpen);
```

Delete `THEME_CYCLE` (line 13) and the whole `cycleTheme` function (lines 72-76).
**Keep** the `theme` store field, the `setTheme` read, the launch-hydration
effect, and the `data-theme` effect — Settings drives them in Task 7.

Replace both `<TopBar .../>` usages. In the settings branch, render nothing in
its place (the Settings screen has its own back affordance):

```tsx
  if (route === "settings") {
    return (
      <div className="flex h-screen flex-col">
        <SettingsScreen onBack={() => setRoute("workspace")} />
      </div>
    );
  }
```

In the workspace branch:

```tsx
      <AppStrip
        activeTab={activeTab}
        secondaryTab={secondaryTab}
        splitOpen={splitOpen}
        chatOpen={chatOpen}
        onActiveTabChange={setActiveTab}
        onSecondaryTabChange={setSecondaryTab}
        onToggleSplit={() => setSplitOpen(!splitOpen)}
        onCloseSplit={() => setSplitOpen(false)}
        onToggleChat={() => setChatOpen(!chatOpen)}
      />
```

**The Settings screen now has no drag region.** Give it one by adding, as the
first child inside the settings branch's wrapper div:

```tsx
        <div data-tauri-drag-region aria-hidden="true" className="h-11 shrink-0 border-b border-border" />
```

Without this the window becomes immovable whenever Settings is open.

- [ ] **Step 5: Delete `TopBar`**

```bash
git rm apps/devbench/src/components/shell/TopBar.tsx apps/devbench/src/components/shell/TopBar.test.tsx
```

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS, with exactly one skipped test (the theme test deferred to Task 7).

- [ ] **Step 7: Commit**

```bash
git add -A apps/devbench/src
git commit -m "feat(devbench): replace the topbar with the app strip"
```

---

### Task 7: Settings > Appearance

The theme control's new and only home. A three-option picker, not a cycling
button — the cycler was only ever justified by living in a cramped topbar.

**Files:**
- Create: `apps/devbench/src/components/settings/AppearancePane.tsx`
- Test: `apps/devbench/src/components/settings/AppearancePane.test.tsx`
- Modify: `apps/devbench/src/components/settings/SettingsScreen.tsx:8-15`
- Modify: `apps/devbench/src/App.test.tsx`

**Interfaces:**
- Consumes: `Menu` from `../ui/Menu` (Task 2), `useAppStore`, `invokeSetSetting` from `../../lib/tauri`.
- Produces: `function AppearancePane(): JSX.Element`. Adds `"appearance"` to `SettingsScreen`'s `PaneId` union and a `{ id: "appearance", label: "Appearance" }` entry to `PANES`, inserted **second**, after General.

- [ ] **Step 1: Write the failing test**

Create `apps/devbench/src/components/settings/AppearancePane.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as tauriLib from "../../lib/tauri";
import { AppearancePane } from "./AppearancePane";
import { useAppStore } from "../../store/useAppStore";

describe("AppearancePane", () => {
  it("shows the current theme and offers all three options", () => {
    useAppStore.setState({ theme: "dark" });
    render(<AppearancePane />);
    const trigger = screen.getByRole("button", { name: /theme/i });
    expect(trigger).toHaveTextContent("Dark");

    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio").map((i) => i.textContent)).toEqual([
      "System", "Dark", "Light",
    ]);
  });

  // Bug class this guards: a theme change that updates the store but never
  // reaches SQLite looks correct until the next launch, then silently reverts.
  it("persists the theme to settings when changed", async () => {
    useAppStore.setState({ theme: "dark" });
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);
    render(<AppearancePane />);

    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));

    expect(useAppStore.getState().theme).toBe("light");
    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("theme", "light"));

    useAppStore.setState({ theme: "dark" });
  });
});
```

Spying on `tauriLib.invokeSetSetting` rather than the raw `invoke` matches the
convention already used in `App.test.tsx`, and asserts the two-argument wrapper
signature (`invokeSetSetting(key, value)`, `lib/tauri.ts:237-239`) instead of
the command's payload shape.

The final `setState` resets the store — it is module-level and shared across
tests in a file, so a leaked `"light"` would break whichever test runs next.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/components/settings/AppearancePane.test.tsx`
Expected: FAIL — cannot resolve `./AppearancePane`.

- [ ] **Step 3: Write the implementation**

Create `apps/devbench/src/components/settings/AppearancePane.tsx`:

```tsx
import { Menu, ChevronIcon } from "../ui/Menu";
import { useAppStore, type ThemePref } from "../../store/useAppStore";
import { invokeSetSetting } from "../../lib/tauri";

const THEMES: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/**
 * The theme control's only home. It used to be a cycling button in the topbar,
 * which was a compromise forced by that row's width — in a settings pane there
 * is room to show all three options and which one is active, so a picker beats
 * a cycler.
 *
 * Applying the theme is App.tsx's `data-theme` effect; this pane only sets the
 * store value and persists it.
 */
export function AppearancePane() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  function choose(next: string) {
    setTheme(next as ThemePref);
    void invokeSetSetting("theme", next).catch(() => {});
  }

  const current = THEMES.find((t) => t.value === theme) ?? THEMES[1];

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-bold text-text">Appearance</h2>
      <p className="mb-4 text-xs text-text-faint">Applies to every session.</p>

      <div className="flex items-start justify-between gap-6 border-b border-border py-4">
        <div>
          <div className="text-sm font-semibold text-text">Theme</div>
          <p className="mt-0.5 max-w-[42ch] text-xs text-text-faint">
            Dark is the authored default. “System” follows your OS setting.
          </p>
        </div>
        <Menu
          label="Theme"
          options={THEMES}
          value={theme}
          onSelect={choose}
          align="end"
          trigger={<>{current.label}<ChevronIcon /></>}
          triggerClassName="flex h-9 w-40 shrink-0 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-3 text-sm text-text transition-colors duration-150 hover:border-text-faint hover:bg-surface-2"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register the pane**

In `apps/devbench/src/components/settings/SettingsScreen.tsx`:

```tsx
import { AppearancePane } from "./AppearancePane";
```
```ts
type PaneId = "general" | "appearance" | "provider" | "mcp" | "archive";

const PANES: { id: PaneId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "provider", label: "Provider" },
  { id: "mcp", label: "MCP" },
  { id: "archive", label: "Archive" },
];
```

Add the matching `Tabs.Panel` for `"appearance"` rendering `<AppearancePane />`,
following the exact pattern the four existing panels use.

- [ ] **Step 5: Re-enable the App-level theme test**

In `apps/devbench/src/App.test.tsx`, replace the skipped test from Task 6 with
this retargeted version. It keeps the original hydration-race guard, which is
the subtle part: the mount-time hydration resolves to "light", and clicking
before that lands would let the hydration effect clobber the click's `setTheme`.

```tsx
  // Bug: cycleTheme() only called setTheme locally, with no backend
  // persistence — so changing the theme was silently lost on restart. The
  // control moved to Settings > Appearance, but the bug class is identical.
  it("persists the theme when changed from Settings", async () => {
    // Resolve the mount-time hydration to "light" (distinct from the "dark"
    // default) and wait for it to land before clicking, so the hydration
    // effect's setTheme() can't race with — and clobber — the click's.
    vi.spyOn(tauriLib, "invokeGetSettings").mockResolvedValue({ ...settings, theme: "light" });
    vi.spyOn(tauriLib, "invokeListWatchedTables").mockResolvedValue([]);
    const setSetting = vi.spyOn(tauriLib, "invokeSetSetting").mockResolvedValue(undefined);

    render(<App />);
    await waitFor(() => expect(useAppStore.getState().theme).toBe("light"));

    fireEvent.click(screen.getByRole("button", { name: /^settings$/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    fireEvent.click(screen.getByRole("button", { name: /theme/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "System" }));

    await waitFor(() => expect(setSetting).toHaveBeenCalledWith("theme", "system"));
    // The theme must actually be applied, not just stored.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    useAppStore.getState().setTheme("dark");
  });
```

The `data-theme` assertion is inverted on purpose: per `App.tsx`'s effect,
`"system"` means *removing* the attribute so the `prefers-color-scheme` media
query takes over — setting `data-theme="system"` would match no selector.

The settings nav is a Base UI `Tabs.List`, so its entries are `tab` roles, not
buttons. Confirm against `SettingsScreen.tsx` before running.

- [ ] **Step 6: Run the full suite**

Run: `bun run test`
Expected: PASS, zero skipped.

- [ ] **Step 7: Commit**

```bash
git add apps/devbench/src/components/settings apps/devbench/src/App.test.tsx
git commit -m "feat(devbench): move the theme control into Settings > Appearance"
```

---

### Task 8: Tauri window configuration

**Files:**
- Modify: `apps/devbench/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: the `data-tauri-drag-region` attributes added in Tasks 5 and 6.
- Produces: nothing importable.

- [ ] **Step 1: Understand why `decorations` stays `true`**

Read `tauri-utils-2.9.3/src/config.rs:2061-2065`. The doc comment on
`traffic_light_position` states: *"Requires titleBarStyle: Overlay and
decorations: true."*

`decorations: false` would remove the traffic lights entirely, leaving a window
with no close button. The overlay title bar is the mechanism that keeps them
while freeing the space beneath.

All three keys below are **macOS-only and ignored on Windows and Linux**, where
the default `decorations: true` yields the normal native title bar above our
strip. No platform branching is required.

- [ ] **Step 2: Apply the config**

Replace the `windows` array in `apps/devbench/src-tauri/tauri.conf.json`:

```json
    "windows": [
      {
        "title": "DevBench",
        "width": 1280,
        "height": 800,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "trafficLightPosition": { "x": 20, "y": 16 }
      }
    ]
```

`y: 16` centres the 12px controls in the 44px strip (16 + 6 = 22 = 44 / 2).

- [ ] **Step 3: Verify the config parses**

Run: `cd apps/devbench && bun run tauri info`
Expected: no configuration error. A schema violation is reported here rather
than at launch.

- [ ] **Step 4: Launch and verify by eye**

Run: `cd apps/devbench && bun run tauri dev`

Confirm all five:
1. No separate grey title bar above the strip.
2. Traffic lights are vertically centred in the strip, left of the tabs.
3. Dragging the empty strip area moves the window.
4. Dragging still works with the Settings screen open.
5. The tab-group divider lines up with the divider between the split panes.

Two known and accepted caveats, both documented by Tauri for `Overlay`:
- The window cannot be dragged while unfocused ([tauri#4316](https://github.com/tauri-apps/tauri/issues/4316)). Click to focus first.
- Title bar height varies across macOS versions; `trafficLightPosition.y` is the one knob if the lights sit off-centre.

- [ ] **Step 5: Commit**

```bash
git add apps/devbench/src-tauri/tauri.conf.json
git commit -m "feat(devbench): inset the traffic lights into the app strip"
```

---

## Done when

- `bun run test` passes with zero skipped tests.
- `TopBar.tsx` and `ToolTabs.tsx` no longer exist.
- No `<select>` element remains in `src/` (`grep -rn "<select" apps/devbench/src --include="*.tsx" | grep -v test` returns nothing).
- `boundary.test.ts` passes — Base UI is imported only from `src/components/ui/`.
- The app launches with one 44px row of top chrome and no native title bar on macOS.
