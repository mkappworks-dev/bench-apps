# DevBench table view — toolbar, foreign keys, and staged changes

Design for the next iteration of the DB tab's table view. Supersedes the
client-side filter bar shipped in `56b8af6` and replaces the single-preview
cell-edit write model.

The mockup — `docs/mockups/devbench-db-connections.html` — was built first and
covers all four slices. It is runnable and is the visual source of truth; every
layout number below was measured in it.

## Why

The grid can browse, sort, resize, reorder, freeze and edit one cell at a time.
Four things it cannot do are the ones that come up while actually debugging:

- **Find a row that isn't on this page.** The filter narrows the ~100 rows
  already fetched, so it cannot answer "where is order 4821".
- **Follow a foreign key.** `customer_id = 42` is a dead end.
- **Add or remove a row.** Writes are edits to existing cells only.
- **Make several changes together.** Each write lands separately, so there is
  no way to prepare a set of changes and commit them as one.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Filter/sort scope | Server-side SQL | A page-number field next to a filter implies the filter moves the pages. Client-side filtering makes "3 of 12" a lie. |
| Popover editing | Draft, applied on Apply | Adding a rule must not re-query on every keystroke, and a rule can be parked rather than deleted. |
| FK navigation | Jump with a pinned row filter | Always lands on the row, under any sort or page size, with no positional query. |
| Header vs toolbar | Both, one shared state | Direct manipulation is faster; popovers are discoverable and precise. |
| Pending changes | Staged diff, applied in one transaction | Holding N open transactions pins N pool connections and holds row locks while the user thinks. |
| Booleans | A checkbox, toggled in place | The one column type whose entire value space fits in a control. |
| Query console | Run for real, then stage | Keeps the DB-verified result while unifying where changes land. |
| Queries | A tab, listed beside tables | A saved query is a document you return to, not a drawer you toggle. |

## 1. Shell: the right dock becomes a slot

`ChatDock` is currently the only occupant of the right dock. It becomes one of
three, shown one at a time:

- **AI chat** (default, as today)
- **Pending changes**
- **Insert row**

Closing any panel returns to chat. Dock width, the resize handle and the
`prefers-reduced-transparency` behaviour are shared, so the new panels inherit
them.

The occupant is app state (`useAppStore`), not tab state: Pending must be
reachable from any DB tab, and the pending set spans tables (§10).

## 2. Toolbar

A strip directly above the column headers, inside the grid card:

```
[+ Insert] [⟳] │ [Filter ▾] [Sort ▾] [Columns ▾] [Export ▾] ······ ‹ [ 3 ] of 12 › [100 ▾]
```

- **Insert** carries the accent fill (`--accent` on `--accent-on`) — it is the
  one control that creates data.
- `⟳` refetches the current page with the current filter and sort.
- Filter, Sort and Columns show a **count badge** and a `--surface-2` fill when
  they are doing something. Filter and Sort count **applied and enabled rules**
  (§4); Columns counts **hidden columns** — three different numbers would be
  confusing, so each badge answers "how many things is this control currently
  doing to the grid".
- The page field is a text input: type a number, press Enter. Out-of-range
  values clamp to the last page rather than erroring.
- Limits: 25 / 50 / 100 / 250 / 500 / 1000. Changing the limit returns to page
  1 — the current offset is meaningless under a new page size.
- Pager arrows, the page field, "of N" and the limit select all sit at
  `--fs-sm` and 24px tall, so the pager reads as one control.

**The toolbar is always one row.** The toolbar element declares
`container-type: inline-size`; below **620px of its own inline size** the button
labels are hidden and only icons remain. Every label is mirrored in `title`, so
nothing becomes unknowable. A container query rather than a viewport media
query because the toolbar shrinks when the dock opens, not when the window
resizes — its own width is the only thing that predicts whether labels fit.
Tailwind v4 supports this via `@container`.

The client-side filter bar and the bottom "Showing 1–N" strip are both deleted.
There are **no filter chips**: the toolbar button's active state and count are
the sole indicator that a view is filtered.

The table scrolls horizontally inside its own container, so a wide table never
pushes the toolbar or its pager out of view.

## 3. Pending button

`[Pending N]` lives in the **pane strip** on a table tab, and in the **query
head** on a query tab — not in the grid toolbar. It is a pane-level surface: the
pending set spans tables and queries rather than belonging to the one grid
below it.

It is hidden entirely when the set is empty, so it never advertises a state
that does not exist.

## 3a. The rail

Every tab kind shares one rail, in three stacked parts:

```
┌─────────────────────┐
│ Local Dev        ▾  │   connection
├─────────────────────┤
│ [ TABLES │ QUERIES ]│   segmented control
├─────────────────────┤
│ orders            👁 │   the list
│ payments          👁 │
│ users             👁 │
└─────────────────────┘
```

Queries are a **peer of tables**, not a drawer beneath them: both are things
this connection contains, and both open into the main pane. The Queries segment
adds a `+ New query` footer; the Tables segment does not (tables are not created
from here).

The segment is **local view state**, initialised from the host tab's kind — a
query tab's rail opens on Queries, a table tab's on Tables. It is deliberately
not in `tab.state`: the shell spec restricts that to identifying selection, and
which list you are looking at is neither identifying nor worth persisting.

A saved query is **stored, not session state** (§3b calls it a document you
return to, which is only true if it survives a restart). `saved_queries` is a
SQLite table scoped to a connection, exactly as `watched_tables` is:

```sql
CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sql           TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

`created_at` orders the rail, so renaming a query does not make it jump.
`ON DELETE CASCADE` means removing a connection removes the queries written
against it — a query naming that database's tables is meaningless without it.

The rail also **deletes** a saved query. This is not in the mockup, and is
included because `+ New query` creating an `untitled query` with no way to
remove it is a one-way ratchet: the list can only ever grow.

## 3b. Query tabs

Selecting a query opens it as **its own tab** beside the DB tab, and selecting
the same query again focuses that tab rather than stacking a duplicate — one
saved query is one document.

A query tab's identity is `{ queryId, connectionId }`, and the connection is
**pinned** at open: moving the rail's picker afterwards does not retarget an
open query tab, the same rule §9's insert panel already follows. Focusing the
existing tab therefore has to match on `queryId`, not on tab kind — two saved
queries are two tabs.

A query tab is visually distinct from a table tab: a `--query-tint` ground
(`rgba(255,255,255,.035)` dark, `rgba(16,21,31,.03)` light) on the tab and the
pane's chrome, a brighter bottom edge on the active tab, and a mono label. **A
tint of the surface's own light, not a hue** — semantic colour stays reserved
for actual state, and a coloured tab would compete with the pending panel's
own colour-coding.

The pane layout:

```
[▶ Run query ⌘⏎]  failed orders today            [Pending 2]   ← 44px head, tinted
──────────────────────────────────────────────────────────────
SELECT id, status, amount                                       ← editor, full bleed,
FROM orders                                                       on --bg
WHERE status = 'failed';
                        ▂▂▂▂                                    ← resize grip, bottom centre
──────────────────────────────────────────────────────────────  ← divider
RAN · rolled back — nothing written unless staged and applied   ← results, on --bg
┌──────┬──────────┬───────────┐
│ ID   │ STATUS   │ AMOUNT    │
└──────┴──────────┴───────────┘
                        [Discard] [Add to pending]
```

- **Run leads, then the name.** On a tab whose purpose is executing something,
  the action is the subject and the name is what you are acting on. A 10px gap
  separates them.
- **The name is editable in place.** Renaming updates the saved query and its
  tab label together. The mockup patches the tab label's DOM directly to keep
  the caret from jumping, which is a workaround for re-rendering the page from
  a template string. React preserves selection in a controlled input whose
  value round-trips through state unchanged, so the implementation keeps the
  caret by keeping the *write* off the keystroke path instead: store on every
  keystroke, SQLite write debounced — the shape `patchTabState` already uses.
- **The editor runs edge to edge**, with no gutter of its own — it is the
  content of the pane, not a field inside it.
- **The resize grip is a small centred pill** in a full-width hit zone at the
  editor's bottom edge, so the affordance reads as "bottom middle" rather than
  a bar spanning the pane. Range 90–560px.
- **Editor and results share `--bg`.** The tint marks *"this is a query"* as a
  chrome signal; the SQL you write and the rows you get back are ordinary
  content and sit on the same ground as everywhere else.
- **Run query, Discard and Add to pending are all 28px**, set by their rows
  rather than by each button (§14).

## 4. Filter and Sort popovers

Both share one interaction model.

```
FILTER — APPLIED AS A WHERE CLAUSE
[✓]  status ▾   =  ▾   paid          ✕
[ ]  notes  ▾   is not null          ✕
[+ Add filter]              [Cancel] [Apply]
```

```
SORT — PRIORITY RUNS TOP TO BOTTOM
[✓] 1  status ▾    [ASC ]  ↑ ↓  ✕
[✓] 2  user_id ▾   [DESC]  ↑ ↓  ✕
[ ] —  notes ▾     [ASC ]  ↑ ↓  ✕
[+ Add sort]                [Cancel] [Apply]
```

**Draft and applied are separate.** Opening a popover snapshots the applied
rule set into a draft. Every edit — add, remove, change column/operator/value,
tick, reorder — touches only the draft. **Apply** promotes the draft to applied,
resets to page 1, re-queries and closes the popover. **Cancel**, or dismissing
the popover by clicking away, discards the draft and closes. Nothing refetches
until Apply.

Filter and sort are per-table state: switching tables clears both, along with
pins and hidden columns, because they describe columns the new table may not
have. The **pending set is not cleared** — it is global by design (§10).

**Each rule has an enable checkbox.** An unticked rule is kept but not run, so a
filter can be switched off and back on without being retyped. Unticked rules
survive Apply.

**An incomplete condition is inert.** A condition whose operator needs a value
and has none is ignored, even when ticked and applied. Without this, adding a
condition empties the grid the moment it is created — before the user has said
what they are looking for. The draft model prevents this during editing; this
rule covers a blank value that reaches the applied set.

**Counts are of applied and enabled rules only.** Three sort terms with two
ticked reads `2`. A rule switched off is not acting on the grid, so counting it
would overstate what is happening.

**Sort priority is the row order**, changed with ↑/↓. Rank numbers are assigned
over ticked rows only; an unticked row shows `—`, because a term excluded from
the `ORDER BY` has no priority. The direction toggle is fixed at 52px so `ASC`
and `DESC` do not shift the controls beside them.

Operators are offered by the column's real type, from `describe_columns` (§13):

| Type family | Operators |
|---|---|
| text | `=` `≠` `contains` `starts with` `is null` `is not null` |
| numeric / date | `=` `≠` `>` `<` `is null` `is not null` |
| boolean | `is true` `is false` `is null` `is not null` |

Changing a condition's column resets its operator — the previous one may not
exist for the new column's type.

Column names are identifier-validated exactly as `ORDER BY` terms already are.
**Values are bound query parameters and are never interpolated into SQL.**
`contains` / `starts with` compile to `LIKE` with the pattern bound, and `%` and
`_` escaped in the user's input.

The same filter feeds `list_table_rows` and `count_table_rows`, so the pager and
the grid cannot disagree.

Header click-to-sort is unchanged and applies immediately — it is direct
manipulation, not a draft — and writes the same state the popover reads.

## 5. Columns

A dropdown listing every column with a visibility checkbox, a pin toggle and a
drag handle for order. This extends the persisted `GridLayout` with
`hidden: string[]`; `widths`, `order` and `pinned` are unchanged.

A hidden column is hidden from the grid only. It is still fetched, still
filterable and sortable, and still exported — hiding is a view concern.

The dropdown's footer carries two resets, and their scopes differ. **Show all**
un-hides every column and leaves widths, order and pins as they are. **Reset
layout** clears all four back to the default. Both are secondary buttons at the
footer's own 26px.

Reset layout previously sat in a full-width strip of its own below the toolbar,
left over from the filter bar this design replaces. A control that only ever
appears once you have customised something, in a strip that exists only to hold
it, is worse than the same control living permanently beside the narrower reset
it belongs with.

## 6. Export

A dropdown offering **CSV** and **JSON** of the current page, in the current
visual column order.

"All matching rows" is deliberately out of scope: it means streaming an
unbounded result set to a file, which is its own design problem.

## 7. Booleans

A boolean cell renders a **checkbox**, centred, and toggling it is the edit —
there is no text editor, and no confirm/cancel buttons. A cell that is not
editable (no single-column primary key, or the PK itself) renders it disabled.

Slice 1 ships the checkbox as display only; it becomes interactive in Slice 3,
when there is a pending set for a toggle to stage into (§17).

`NULL` in a boolean column keeps the italic `NULL` text, so the three states
stay distinct — which the original brief calls a hard constraint.

This replaces the green/neutral pills. The green pill asserted a value
judgement: green reads as "good", but `is_deleted = true` is not good. A
checkbox carries no such claim.

Values are still inferred from the string `"true"` / `"false"`. Once
`describe_columns` is available that inference can be replaced by the real
column type; that is a follow-up, not part of this design.

## 8. Foreign keys

A cell in a column with an FK target shows a link icon at its right edge,
always visible — it is information about the data, not an affordance for a
hover state.

Clicking opens a popover:

```
┌────────────────────────────────┐
│ 🔗 public.users.id      [↗] [✕] │
├────────────────────────────────┤
│ id            usr_88           │
│ email         grace@example.com│
│ status        active           │
└────────────────────────────────┘
```

The body is the referenced row, fetched on open via `get_referenced_row`. `↗`
switches the grid to `public.users` with a pinned `id = usr_88` filter, clearing
sort, pins and hidden columns, because they described a different table.

A referenced row that no longer exists (an unenforced or broken key) shows
"No matching row in public.users" rather than an empty popover.

## 9. Insert panel

Fields are generated from `describe_columns`:

- **Identity / generated columns** render read-only with "assigned by the
  database" — visible, so the shape of the row is honest, but not editable.
- **`NOT NULL` without a default** is marked required; Save is disabled until
  those are filled.
- **Defaults** appear as placeholder text (`now()`, `'pending'`), so leaving a
  field blank visibly means "let the database decide".
- **Types** drive the input: a select for boolean, a number input for numerics,
  plain text otherwise.

**Save stages an insert. It does not write.**

## 10. Pending changes

```ts
type PendingChange =
  | { kind: "update"; table: string; pkColumn: string; pkValue: string;
      column: string; oldValue: string | null; newValue: string | null }
  | { kind: "insert"; table: string; values: Record<string, string | null> }
  | { kind: "delete"; table: string; pkColumn: string; pkValue: string }
  | { kind: "sql"; table: string | null; statement: string; previewedEffect: string };
```

Implementation note (Slice 3): `table` is a validated `QualifiedTable`
(`{ schema, name }`), not a plain string — for the reason this section already
gives for splitting the primary key into `pkColumn` + `pkValue`: a pre-joined
string is a string that ends up interpolated into SQL. Field names on the wire
are snake_case (`pk_column`, `old_value`, `previewed_effect`), matching serde
and `TableRows`'s existing `pk_column`. `values` stays a JSON object and
deserializes into a `BTreeMap`, so the generated column list and VALUES list
are built from one deterministic order.

The primary key travels as `pkColumn` + `pkValue`, not as a pre-built `WHERE`
string. The mockup simplifies this to a display string; the implementation must
not, because that string would end up interpolated into SQL.

The panel groups by table and colour-codes the kind (update `--warning`,
insert `--success`, delete `--danger`, sql neutral). Updates use the
strikethrough-danger / semibold-success `old → new` treatment already built.
Each entry has a discard button; the panel has **Apply** and **Discard all**.

### A pending change is a diff, not a log

Update entries are keyed by `(table, pkValue, column)` — **one entry per cell**
— and always compare against the **stored database value**, never the last
staged one. Staging a cell is an upsert-or-delete:

- differs from stored → insert or replace that cell's entry
- equals stored → **remove** the entry

So toggling a checkbox twice, or editing a cell and typing the original value
back, leaves no pending change. Without this the set is append-only: two
toggles would read `Pending 2` and apply an `UPDATE` writing the value already
there.

Comparison runs on **typed** values, not display strings: `null` and booleans
are compared before any string fallback, or a text cell containing the literal
`"NULL"` would compare equal to a real `NULL` and silently drop a change.

The pending count is therefore the number of cells that genuinely differ from
the database, which is what makes "Apply 3" honest.

### Staged cells in the grid

A cell with a pending change renders its **staged** value, marked with an inset
`--warning` left bar. This is required, not decorative: a checkbox that snaps
back to its stored value would look like the click did nothing.

### Apply semantics

Apply sends the whole ordered set to `apply_changes`, which runs it in **one
transaction**, in staging order.

Structured updates and deletes carry their original value into the `WHERE`:

```sql
UPDATE "orders" SET "status" = $1
 WHERE "id" = $2 AND "status" IS NOT DISTINCT FROM $3
```

A row someone else changed since staging matches zero rows. That is a
**conflict**: the transaction rolls back whole, nothing is written, and the
panel marks the offending entry with what it expected versus what it found.
This is the cost of not holding locks, reported honestly rather than silently
overwriting.

`IS NOT DISTINCT FROM` rather than `=` so a staged edit of a `NULL` cell
matches correctly.

Every bound value is cast to its column's catalog type (`$1::int4`), never the
column to text. sqlx binds parameters as TEXT and Postgres has no assignment
cast from text, so an uncast `SET "n" = $1` is a hard error on any non-text
column; casting the column instead would be sargable-destroying on the keyed
side. The type comes from the catalog and is identifier-validated before
interpolation.

### Scope

The pending set is global, not per-tab: it can hold changes to several tables
from several tabs, and Apply commits them together.

It is **not** global across connections in the sense that matters for acting on
it. Apply sends only the entries staged against the active connection, and the
panel renders the rest dimmed under a "switch to it to apply" note. **Discard
all is scoped the same way** (Slice 4): it drops this connection's entries and
leaves the others standing, making it the exact inverse of Apply. Left global it
was the one control in the panel that could destroy work the panel itself had
just declared unreachable.

The pane strip's `Pending N` badge stays **globally** counted, and this is not
an inconsistency: on a connection with nothing staged, that badge and the panel
it opens are the only route to the entries staged elsewhere. Counting it per
connection would hide them behind no affordance at all. The distinction is
destructive versus informative, not scoped versus unscoped.

## 11. Row delete

A row action in the actions column stages a delete. It requires a
single-column primary key — the same rule that already governs whether a cell
is editable.

## 12. Query execution and staging

The bottom drawer is gone (§3b). What was the query console is now a query tab,
and its Preview/Commit pair becomes Run query / Add to pending.

**Run query** opens a transaction, runs the statement, captures the effect and
rolls back — all within the one user action. The rollback is fired in the same
continuation the result arrives in, not deferred to a later click and not tied
to a React lifecycle, so an abandoned tab or a mid-flight unmount still releases
the transaction. **No lock is held while the user decides.** That is the Slice 3
principle ("staged intent holds no transaction") applied to this path; the
earlier wording, which implied the transaction stayed open until Discard or Add
to pending, would have reinstated exactly the hazard §15 retired.

The result is labelled `RAN — ran in a transaction that was rolled back;
nothing is written unless you add it to Pending and Apply`.

**Add to pending** records the statement together with the effect the run
reported. At Apply the statement is **re-run** inside the changeset transaction.
**Discard** drops the result and stages nothing.

**Add to pending is available only for a statement that reported an affected
count**, never for one that returned rows. Re-running a `SELECT` at Apply writes
nothing, so staging one would occupy a slot in the pending count without being
able to change anything — the same reasoning §10 uses to make the set a diff
rather than a log, and the same thing that makes "Apply 3" honest.

Re-running means the effect can differ from what the run showed if the data
moved in between. The panel therefore stores and displays the reported effect
("1 row affected when run") so a divergence is visible after Apply rather than
silent.

`preview_state`, its sweep, `preview_query` and `rollback_preview` **stay** —
running a statement to show its effect genuinely needs a transaction, even one
this short-lived. `commit_preview` does **not**: no path in this design ever
commits a held preview, because Add to pending re-runs the statement at Apply
instead. It is retired with the console (§15).

Naming: the button says "Run query" rather than "Preview" because it does run,
for real, against the database. Calling that a preview understated it. What is
provisional is the *transaction*, and the result label says so.

## 13. Backend commands

```rust
// One query serving two features: information_schema.columns for
// type/nullable/default/identity, LEFT JOINed to a pg_catalog subquery for the
// referenced table/column per column. Fetched once per table.
//
// pg_catalog rather than information_schema's constraint views because
// constraint_column_usage reports a constraint's referenced columns with no
// ordinal: a two-column key cross-joins, so each referencing column claims
// every referenced column, and the LEFT JOIN duplicates the column rows on top
// of that. pg_constraint.conkey[i] <-> confkey[i] pairs by position exactly.
describe_columns(connection_id, table) -> Vec<ColumnInfo>

struct ColumnInfo {
  name: String, udt: String, nullable: bool,
  default_expr: Option<String>,
  is_identity: bool,                   // "the database assigns this": IDENTITY,
                                       // GENERATED ALWAYS, or a serial's
                                       // nextval() default. Broader than
                                       // information_schema.is_identity, which
                                       // is false for a serial — §9 renders all
                                       // three read-only, and a literal reading
                                       // would put an editable id in every
                                       // insert form.
  references: Option<ForeignKeyRef>,   // { schema, table, column }
}

count_table_rows(connection_id, table, filter) -> i64
list_table_rows(connection_id, table, filter, order_by, limit, offset) -> TableRows
get_referenced_row(connection_id, table, column, value) -> Option<TableRows>
apply_changes(connection_id, changes: Vec<PendingChange>) -> ApplyOutcome

// Saved queries (§3a). Stored in the app's own SQLite, not the user's
// Postgres — a saved query is DevBench state about a connection, not data
// inside it.
list_saved_queries(connection_id) -> Vec<SavedQuery>
create_saved_query(connection_id, name, sql) -> SavedQuery
rename_saved_query(id, name) -> ()
set_saved_query_sql(id, sql) -> ()
delete_saved_query(id) -> ()

struct SavedQuery { id: String, connection_id: String, name: String, sql: String, created_at: i64 }

struct ApplyOutcome {
  applied: usize,
  conflict: Option<ConflictReport>,   // Some(_) => nothing was written
}

struct ConflictReport {
  index: usize,            // position in the submitted set
  table: String,           // "public.orders", for display only
  description: String,     // "id = 42"
  column: Option<String>,  // None for a delete
  expected: Option<String>,
  found: Option<String>,
  row_missing: bool,       // the PK matched no row — distinct from found: None,
                           // which means the row is there holding NULL
}
```

`list_table_rows` gains `filter`; its existing over-fetch-by-one for
`hasNextPage` is retired in favour of the real count.

### Count cost

`COUNT(*)` on a large table is a sequential scan, and the pager needs it on
every filter change. It is cached per `(connection, table, filter)` for the
session and invalidated by Refresh and by Apply. The count is fetched **in
parallel with** the first page, so the grid never waits on it; the pager shows
`of —` until it arrives.

## 14. Shared components

**One secondary button** (`.btn-secondary` in the mockup): a hairline of the
surface's own light (`rgba(255,255,255,.16)` dark / `rgba(16,21,31,.18)` light)
over a 4%-tint fill, rather than a `--border` hairline, which disappears on a
translucent panel. Used for Add / Cancel / Discard / Discard all / Show all, the
sort direction toggle, and Pending in the pane strip.

**Rows own button height**, not buttons: a popover footer sets 26px for both its
secondary and primary buttons, a dock footer 30px, the query head and its
actions row 28px. This is what stops a secondary and its primary from drifting
apart, and it means a button added to any of those rows inherits the right
height without carrying a number of its own.

**`.primary` must be `inline-flex`.** The app sets `svg { display: block }`
globally, so an icon inside a block-level button stacks above its label rather
than sitting beside it.

**Checkboxes are drawn, not native**: 14px, 4px radius, transparent with a faint
border when off, accent fill with an inset tick when on. A UA checkbox is ~16px,
platform-coloured, and reads as a form control dropped into a dense row.

A blanket `input` selector in a rule row must exclude checkboxes
(`input:not([type="checkbox"])`) or it will out-specify the checkbox rule and
stretch it into a full-height field.

## 15. What this retires

For **cell edits only**: `editGenerationRef`, the in-flight button disabling,
rollback-on-arrival, and the preview sweep. These exist solely to protect one
live transaction; staged intent holds none. Their removal is the point of the
change, not a side effect. The bug they were introduced for was re-checked
against the new model before they were deleted (Slice 3, Task 6), and the
re-check concluded:

> The bug those guards fixed was a **committed write reported as failed, and a
> leaked transaction**. Both were possible only because a preview opened a real
> transaction that outlived the UI that owned it. Clicking ✓ now mutates local
> state and returns synchronously — no request, no transaction, no id, and so
> no window in which a response can land against state that has moved on. For
> **cell staging**, the failure mode is not merely unguarded; it is unreachable
> by construction.

That reasoning covers cell staging and stops there. **Apply is a genuine round
trip**, and it has exactly the windows the retired guards existed for. They are
closed explicitly rather than by construction:

- The grid stays live while Apply is out, so the set can grow mid-flight. On
  success the panel removes **only the entries it sent**, by identity — never
  the whole set, which would silently destroy anything staged since.
- The panel is the only place a conflict can be reported, so it **refuses to be
  dismissed** while a call is in flight: its ✕ is disabled, and the store's dock
  setters decline to unmount it, which closes the AppStrip toggle and every
  other route at once.

Also removed: the client-side filter bar, its state and counter; the bottom
pager strip; the boolean pills; and the query console drawer entirely — its
toggle button, resize handle, height state and open/closed flag.

**Kept:** `preview_state`, the sweep, `preview_query` and `rollback_preview` —
the query tab's Run still uses them (§12).

**Also removed in Slice 4:** `commit_preview`, `commit_preview_impl` and
`invokeCommitPreview`. `QueryConsole.tsx` was their only caller anywhere, and
the path that replaces it never commits a held preview — Add to pending re-runs
the statement inside the changeset transaction instead. Retiring it is what
makes "no transaction outlives the action that opened it" true of the whole
application rather than of the grid alone.

## 16. Testing

**Rust**
- A filter compiles to a parameterised `WHERE`; values are bound, not
  interpolated; a malicious column name is rejected as `ORDER BY` terms are.
- `LIKE` patterns escape `%` and `_` from user input.
- `count_table_rows` agrees with the length of the unpaged filtered list.
- `apply_changes` is atomic: one failing entry rolls back all of them.
- A conflicting update (value changed underneath) is detected and reported, and
  nothing is written.
- `describe_columns` reports identity, nullability, defaults and an FK target on
  a table that has one.
- A staged `sql` entry re-runs inside the changeset transaction and its effect
  is visible after the commit; a failing one rolls back the structured entries
  staged beside it. (The `Sql` variant shipped in Slice 3 with no test, because
  nothing could stage one until Slice 4 built the UI.)
- `saved_queries` round-trips create/list/rename/set-sql/delete, and deleting a
  connection cascades its queries away.

**Vitest**
- Popover edits do not change the query until Apply; Cancel discards the draft.
- An unticked rule is kept, excluded from the query, and excluded from the count.
- An incomplete condition is ignored.
- Sort priority follows row order; ranks skip unticked rows.
- Staging a cell twice back to its stored value leaves no pending change —
  for a boolean toggle and for a text edit.
- A staged cell renders its pending value.
- Hiding a column removes it from the grid but not from export.
- Insert fields are generated from metadata: identity read-only, `NOT NULL`
  required, defaults as placeholders.
- FK link icon appears only on columns with a target.
- Booleans render as a checkbox; `NULL` stays distinct from `false`.
- The rail's segment swaps the list, and the `+ New query` footer shows on
  Queries only.
- Selecting an already-open query focuses its tab instead of stacking a second.
- Renaming updates the saved query and the tab label from one keystroke.
- Add to pending is disabled for a row-returning result, and stages exactly one
  `sql` entry for a statement that reported an affected count.
- Run rolls its transaction back without being asked to.
- Discard all drops this connection's entries and leaves another connection's
  standing.

**Browser (Playwright, measured)**
- The toolbar stays one row and collapses to icons below a 620px pane.
- Toolbar and pager are never clipped by a wide table.
- Header/body alignment holds under horizontal scroll.
- The dock swaps occupants without changing width.
- Popovers sit above cells and below the sticky header.
- The query editor reaches both pane edges; the tint covers head and tab but
  not the editor or results.
- The resize grip is the element at its own centre point, and drags within
  90-560px.
- The query head stays one row; its three buttons measure 28px.
- The rail keeps its width across a switch between a table tab and a query tab.

jsdom has no layout engine; anything positional is verified in a real browser
with `getComputedStyle` / `getBoundingClientRect`, never asserted in vitest.

## 17. Slices

**Slice 1 — toolbar and query controls.** Toolbar frame, Refresh, Sort popover,
Columns dropdown, Export, pagination with real count, Filter popover with
server-side `WHERE`, the draft/apply model, `.btn-secondary`, boolean
checkboxes (display only — toggling arrives in Slice 3). Removes the filter bar
and bottom pager.

**Slice 2 — foreign keys.** `describe_columns`, link icon, popover,
`get_referenced_row`, jump via pinned filter. Depends on Slice 1's filter for
the jump, and supplies the real column types Slice 1's operators want.

**Slice 3 — writes.** Insert panel, row delete, pending changes panel, boolean
toggling, `apply_changes`. Retires the single-preview machinery.

**Slice 4 — queries as tabs.** Rail segmented control, saved-query list, query
tab kind and its tint, the query pane (Run query, editable name, full-bleed
editor, resize grip, results), Add to pending. Removes the console drawer.
Depends on Slice 3 for the pending set that Add to pending writes into.

Slice 3 depends on Slice 2's `describe_columns` for the insert panel's field
types.

Slice 1 has one ordering wrinkle worth naming: the Filter popover's operator
list wants real column types, which arrive with `describe_columns` in Slice 2.
Slice 1 therefore infers type the way the grid already does (from the string
value), and Slice 2 replaces that inference with the real type. This is a
deliberate temporary duplication, not an oversight.

**Each slice gets its own plan, written once its predecessor has survived
contact.** Slice 1: `docs/superpowers/plans/2026-08-02-table-view-slice-1-toolbar.md`.
Slice 2: `docs/superpowers/plans/2026-08-02-table-view-slice-2-foreign-keys.md`.
Slice 3: `docs/superpowers/plans/2026-08-02-table-view-slice-3-writes.md`.
Slice 4: `docs/superpowers/plans/2026-08-19-table-view-slice-4-queries.md`.

## 18. Risks and known gaps

- **Count on large tables.** Mitigated by caching and parallel fetch, but a
  genuinely huge table will still be slow on the first load of each filter. If
  it proves painful, fall back to "10,000+" above a threshold using
  `reltuples`.
- **Conflict rate.** Staging encourages leaving changes pending, widening the
  window for a conflict. Acceptable and honest, but more visible than today.
- **Re-run divergence.** A staged SQL statement's effect at Apply can differ
  from its preview (§12). Displayed, not prevented.
- **Retiring the edit guards.** They fixed a verified Critical bug. The new
  model should make them unnecessary rather than merely unused; that reasoning
  needs explicit review, not assumption.
- **Staged values are not re-queried.** A staged cell is not re-sorted or
  re-filtered by its pending value, because the database does not know about it
  yet. A row can therefore stay visible under a filter its staged value no
  longer matches. Accepted: re-sorting rows as you edit them would be worse.
- **SQL entries group alone.** A staged statement has no table, so it files
  under its own heading rather than under the table it touches.
- **Popover and jump can disagree on a match.** `get_referenced_row` binds the
  lookup value cast to the referenced column's real type (`= $1::timestamptz`,
  say). The jump's pinned filter compiles through the filter compiler to
  `"col"::text = $1`, comparing string representations instead. For a target
  column whose display rendering differs from Postgres's own `::text` output
  — `timestamptz` and `float8` extremes are the known cases — the two checks
  disagree: the popover finds and shows the row, then the jump lands on an
  empty grid with no error. Accepted for now: foreign keys overwhelmingly
  target int, uuid or text primary keys, where both renderings agree. The
  real fix is a change to the filter compiler's casting strategy, which
  affects every filter in the application and belongs in its own change.
