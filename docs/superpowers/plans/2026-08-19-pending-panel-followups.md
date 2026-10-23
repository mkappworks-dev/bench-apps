# Pending Panel Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three defects the Slice 3 final review parked, before Slice 4 builds on the same code.

**Architecture:** Two are corrections to signals that became wrong when Apply gained connection scoping. `ConflictReport.index` is mapped back to the whole-set position its consumers assume; the grid's post-Apply refetch stops inferring "did Apply write?" from the pending set's *size* and instead watches an explicit signal the panel raises only on a commit that wrote. The third adds the missing coverage on `applyInFlight`'s failure paths.

**Tech Stack:** React 18, Zustand, vitest + @testing-library/react, TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-02-devbench-table-view-design.md` (§10 pending changes, §12 query staging — Slice 4 depends on both areas this plan touches).

## Global Constraints

- **Baseline to keep green, measured on this worktree at `cbe419b`:**
  - `cd apps/devbench && bun run test` → **508 passing / 50 files**
  - `cd apps/devbench && bun run build` → clean, 0 warnings
  - `cd apps/devbench/src-tauri && cargo test` → **249 passed, 1 ignored** (lib) and **6 passed** (`smoke_test`), 0 warnings
  - Re-measure immediately before each task and reconcile against your own number. No Rust changes in this plan — cargo should be untouched throughout. Run `cargo test`, never `cargo test --lib`.
- Concurrent sessions share this machine. `cd` explicitly before every git command.
- jsdom has no layout engine. Never assert layout in vitest, and never write a test that appears to check something but asserts nothing. **Two tests in Slice 3 were caught passing vacuously** — verify every new test discriminates by breaking its implementation, observing the failure, and restoring.
- Repo comment style is sparse: non-obvious rationale only.
- **Out of scope — do not start these:** scoping or confirming "Discard all" (a pending UX decision), and anything in Slice 4 (rail segments, query tabs, the query pane, Add to pending).

---

## File Structure

**Modified**

| File | Change |
|---|---|
| `src/components/db/PendingPanel.tsx` | Map `conflict.index` to the whole-set position; raise an explicit applied signal; drop the `onApplied` prop. |
| `src/components/db/PendingPanel.test.tsx` | Cover the index mapping, the applied signal on success vs conflict, and `applyInFlight` cleanup on both failure paths. |
| `src/store/useAppStore.ts` | `applyGeneration` + `bumpApplyGeneration`. |
| `src/components/db/DbTab.tsx` | Refetch on `applyGeneration`, not on the pending set shrinking. |
| `src/components/db/DbTab.test.tsx` | Cover: a discard does not refetch and leaves an open editor alone; an apply signal does refetch. |
| `src/App.tsx` | Remove the dead `onApplied={() => {}}` and its now-false comment. |
| `src/lib/pendingChanges.ts` | Comments only — `IndexedChange` / `PendingGroup` describe the invariant Task 1 restores. |

---

## Task 1: `ConflictReport.index` addresses the whole set again

**Files:**
- Modify: `apps/devbench/src/components/db/PendingPanel.tsx`
- Modify: `apps/devbench/src/components/db/PendingPanel.test.tsx`
- Modify: `apps/devbench/src/lib/pendingChanges.ts` (comments only)

**Interfaces:**
- Consumes: `indexChanges` and `IndexedChange` from `../../lib/pendingChanges`
- Produces: no new exports. `conflictMessage` gains no parameters; the mapping happens at its call site.

**The defect.** `pendingChanges.ts` states the invariant twice — at `IndexedChange` and at `PendingGroup` — that an entry's `index` is its position in the **whole** set, because "a discard button and a `ConflictReport` both address it". That was true when Apply sent the whole set. It stopped being true when Apply became connection-scoped: `apply_changes_impl` enumerates the array it was **sent**, and `PendingPanel` now sends only `mine`. So a conflict on the first entry of connection B's subset reports `index: 0`, which addresses connection A's first entry in the whole set.

Nothing reads `conflict.index` today, which is exactly why this is worth fixing now rather than later: the first consumer inherits a silent off-by-subset error, and the comments actively tell them it is safe.

**Why map rather than re-document.** The whole-set index is the more useful contract — it is what `discardPendingAt` takes and what any future "jump to the offending entry" needs. `mine` already carries both halves (`IndexedChange.index` is the whole-set position, and `sent[i]` was built from `mine[i]`), so the mapping is exact and local.

- [ ] **Step 1: Write the failing test**

Add to `apps/devbench/src/components/db/PendingPanel.test.tsx`. It needs a set where the applied connection's entries do NOT start at whole-set index 0 — that is the whole point:

```tsx
  // The backend enumerates the array it was SENT, which is only this
  // connection's subset. Without mapping, a conflict on the first sent entry
  // reports index 0 — which addresses a different connection's entry.
  it("reports a conflict against the entry's position in the whole set, not the sent subset", async () => {
    const OTHER: PendingChange = {
      kind: "update", connection_id: "c2", table: ORDERS, pk_column: "id", pk_value: "1",
      column: "status", old_value: "a", new_value: "b",
    };
    // UPDATE is connection c1; it sits at whole-set index 1, sent index 0.
    seed([OTHER, UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    const { onConflictIndex } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(onConflictIndex).toHaveBeenCalledWith(1);
  });
```

`renderPanel` currently returns only what `render` gives plus `onApplied`. Extend the helper to accept and return an `onConflictIndex` spy, and pass it to `PendingPanel` as a new optional prop `onConflictIndex?: (index: number) => void`. That prop is the observable seam for this behaviour — without it the mapping is computed and thrown away, which is untestable and would be dead code.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/devbench && bun run test src/components/db/PendingPanel.test.tsx`
Expected: FAIL — `onConflictIndex` is not a function / not called.

- [ ] **Step 3: Implement the mapping**

In `PendingPanel.tsx`, add the prop to the signature and its type:

```tsx
  /** The offending entry's position in the WHOLE pending set, raised when a
   *  conflict comes back. The backend indexes the array it was sent — this
   *  connection's subset — so the index it returns is translated here before
   *  anyone outside this panel sees it. */
  onConflictIndex?: (index: number) => void;
```

In `apply()`'s conflict branch, translate before reporting:

```tsx
      if (outcome.conflict) {
        // The transaction rolled back whole, so the set is still exactly what
        // the user staged. Clearing it here would cost them their work over a
        // failure that wrote nothing.
        //
        // `conflict.index` counts the array we SENT (this connection's subset).
        // `mine` holds the same entries paired with their whole-set positions,
        // so this is the exact translation back to the index every other
        // consumer — discardPendingAt included — expects.
        const whole = mine[outcome.conflict.index]?.index;
        if (whole !== undefined) onConflictIndex?.(whole);
        setProblem(conflictMessage(outcome.conflict));
        return;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/devbench && bun run test src/components/db/PendingPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Verify the test discriminates**

Temporarily replace `mine[outcome.conflict.index]?.index` with `outcome.conflict.index`, re-run the file, and confirm the new test FAILS (it will report 0 instead of 1). Restore. Report what you observed.

- [ ] **Step 6: Make the comments true again**

In `apps/devbench/src/lib/pendingChanges.ts`, both `IndexedChange` and `PendingGroup` claim a `ConflictReport` addresses the whole-set index. That is now true again, but only because the panel translates it. Say so, so nobody removes the translation believing it redundant:

```ts
/** An entry paired with its position in the WHOLE set. Filtering the set (by
 *  connection, say) has to keep that position: a discard button addresses it
 *  directly, and a `ConflictReport`'s index is translated back to it by
 *  `PendingPanel` — the backend counts only the entries it was sent. */
```

Apply the equivalent correction to `PendingGroup`'s comment.

- [ ] **Step 7: Run the full suite and build**

Run: `cd apps/devbench && bun run test` → baseline **+1** (509 / 50).
Run: `cd apps/devbench && bun run build` → clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/PendingPanel.tsx apps/devbench/src/components/db/PendingPanel.test.tsx apps/devbench/src/lib/pendingChanges.ts
git commit -m "fix(devbench): report a conflict against its whole-set position"
```

---

## Task 2: Refetch when Apply writes, not when the pending set shrinks

**Files:**
- Modify: `apps/devbench/src/store/useAppStore.ts`
- Modify: `apps/devbench/src/components/db/PendingPanel.tsx`
- Modify: `apps/devbench/src/components/db/PendingPanel.test.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.tsx`
- Modify: `apps/devbench/src/components/db/DbTab.test.tsx`
- Modify: `apps/devbench/src/App.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `applyGeneration: number` and `bumpApplyGeneration: () => void` on the store. Removes `PendingPanel`'s `onApplied` prop.

**The defect.** `DbTab` currently infers "Apply wrote something" from the pending set getting *smaller*. That proxy is wrong in both directions:

- **Discarding refetches when it must not.** A discard changes nothing in the database. The staged overlay disappearing is a pure re-render, which happens anyway because `pending` is state. But the effect refetches and calls `abandonEditForQueryChange()`, so discarding any entry — including one belonging to a different connection — silently destroys an open cell editor's typed draft.
- **Applying can fail to refetch when it must.** Stage one cell, click Apply, re-stage that same cell while the call is in flight: `removePendingEntries` drops the sent entry and the re-stage adds one, so the count goes 1 → 1. The effect returns early, the grid never reloads, and that entry keeps an `old_value` that is now stale — it will fail its guard at the next Apply.

The correct signal is "a commit landed and wrote", which `PendingPanel` already knows. `onApplied` was designed as exactly that hook and was left wired to `() => {}` in `App.tsx`, under a comment describing behaviour the count heuristic was doing instead. A store counter carries it across the dock/tab boundary the prop could not, and it reaches every mounted `DbTab` — which is correct, since `SplitContent` keeps non-active tabs mounted and both panes' grids are equally stale after a commit.

- [ ] **Step 1: Write the failing tests**

Add to `apps/devbench/src/components/db/DbTab.test.tsx`, inside `describe("inline cell editing", …)`:

```tsx
    // A discard changes nothing in the database — the staged overlay clearing
    // is a re-render, not a reload. Refetching cost the user an open draft.
    it("does not refetch or disturb an open editor when a staged entry is discarded", async () => {
      const list = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });

      renderDb(ORDERS);
      await screen.findByText("pending");

      act(() => {
        useAppStore.getState().stagePendingUpdate({
          kind: "update", connection_id: "c1", table: ORDERS, pk_column: "id",
          pk_value: "9", column: "status", old_value: "a", new_value: "b",
        });
      });

      fireEvent.click(await screen.findByText("pending"));
      fireEvent.change(await screen.findByLabelText("Edit status"), { target: { value: "typed" } });
      const callsBefore = list.mock.calls.length;

      act(() => {
        useAppStore.getState().discardAllPending();
      });

      expect(list.mock.calls.length).toBe(callsBefore);
      expect((screen.getByLabelText("Edit status") as HTMLInputElement).value).toBe("typed");
    });

    // The count is not the signal: Apply removes what it sent while a cell
    // staged mid-flight remains, so a real commit can leave the size unchanged.
    it("refetches when an Apply lands, even with the pending count unchanged", async () => {
      const list = vi.spyOn(tauriLib, "invokeListTableRows").mockResolvedValue({
        columns: ["id", "status"], rows: [["1", "pending"]], pk_column: "id",
      });

      renderDb(ORDERS);
      await screen.findByText("pending");
      const callsBefore = list.mock.calls.length;

      act(() => {
        useAppStore.getState().bumpApplyGeneration();
      });

      await waitFor(() => expect(list.mock.calls.length).toBe(callsBefore + 1));
    });
```

Add to `apps/devbench/src/components/db/PendingPanel.test.tsx`:

```tsx
  it("signals an apply only when the commit actually wrote", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({ applied: 1, conflict: null });
    const before = useAppStore.getState().applyGeneration;
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await waitFor(() => expect(useAppStore.getState().applyGeneration).toBe(before + 1));
  });

  it("does not signal an apply when the transaction rolled back", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    const before = useAppStore.getState().applyGeneration;
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(useAppStore.getState().applyGeneration).toBe(before);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/devbench && bun run test src/components/db`
Expected: FAIL — `bumpApplyGeneration is not a function`, and the discard test fails because the current effect does refetch.

- [ ] **Step 3: Add the signal to the store**

In `apps/devbench/src/store/useAppStore.ts`, add to `AppState` beside `applyInFlight`:

```ts
  /** Bumped once per Apply that actually committed. The grid lives in a tab
   *  and Apply happens in the dock, so this is how a written commit reaches
   *  every mounted DbTab — including a split pane's, whose rows are equally
   *  stale. A counter rather than a boolean: two applies in a row are two
   *  distinct events, and a flag would need resetting. */
  applyGeneration: number;
  bumpApplyGeneration: () => void;
```

and to the store body:

```ts
  applyGeneration: 0,
  bumpApplyGeneration: () => set((s) => ({ applyGeneration: s.applyGeneration + 1 })),
```

- [ ] **Step 4: Raise it from the panel, and drop the dead prop**

In `PendingPanel.tsx`: read the action, replace the `onApplied()` call, and remove the `onApplied` prop from both the signature and its type block (including its doc comment).

```tsx
  const bumpApplyGeneration = useAppStore((s) => s.bumpApplyGeneration);
```

```tsx
      removePendingEntries(sent);
      bumpApplyGeneration();
```

In `App.tsx`, delete the `onApplied={() => {}}` line and the two-line comment above it — the comment describes the count heuristic Task 2 removes, so leaving it would document behaviour that no longer exists.

- [ ] **Step 5: Rewrite the effect in `DbTab.tsx`**

Replace the whole `pendingCountRef` effect — its ref, its comment block and its body — with:

```tsx
  // Apply commits in the dock, which cannot reach this grid, so a written
  // commit arrives as a store signal instead. Keyed on that signal rather than
  // on the pending set's size: a discard shrinks the set without changing the
  // database (the staged overlay clearing is a re-render, and refetching it
  // cost an open editor its draft), while an Apply that lands as a cell is
  // staged mid-flight leaves the size unchanged and still needs the reload.
  const seenApplyRef = useRef(applyGeneration);
  useEffect(() => {
    if (seenApplyRef.current === applyGeneration) return;
    seenApplyRef.current = applyGeneration;
    if (!table || !activeConnectionId) return;
    // The rows underneath an open editor are about to be replaced while
    // editing.rowIndex stays put, so accepting would stage the draft against
    // whatever row lands at that index — with that row's own old_value, which
    // the backend's guard would accept. Every query-shape change does this.
    abandonEditForQueryChange();
    void fetchRows(table, activeConnectionId, filter, sort, page, limitRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyGeneration]);
```

Read `applyGeneration` with the other store selectors:

```tsx
  const applyGeneration = useAppStore((s) => s.applyGeneration);
```

The `seenApplyRef` guard is what keeps this from firing on mount, matching the ref pattern the removed effect used.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/devbench && bun run test`
Expected: PASS — baseline **+4** (513 / 50), carrying Task 1's number forward.

If any pre-existing test fails, read it before changing it: a test that asserted a refetch after a *discard* was asserting the defect, and should be reworked to assert the new behaviour rather than deleted. Report any you find.

- [ ] **Step 7: Verify the tests discriminate**

Break each and observe, then restore. Report what you saw:
1. Remove `bumpApplyGeneration()` from `apply()` → the "signals an apply" and "refetches when an Apply lands" tests must fail.
2. Change the effect's guard to fire on any `pending.length` change → the discard test must fail.

- [ ] **Step 8: Verify the build**

Run: `cd apps/devbench && bun run build`
Expected: clean. A `tsc` error about `onApplied` means a caller was missed.

- [ ] **Step 9: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/store/useAppStore.ts apps/devbench/src/components/db/PendingPanel.tsx apps/devbench/src/components/db/PendingPanel.test.tsx apps/devbench/src/components/db/DbTab.tsx apps/devbench/src/components/db/DbTab.test.tsx apps/devbench/src/App.tsx
git commit -m "fix(devbench): refetch on a written commit, not on the set shrinking"
```

---

## Task 3: Pin `applyInFlight`'s cleanup on both failure paths

**Files:**
- Modify: `apps/devbench/src/components/db/PendingPanel.test.tsx`

**Interfaces:** none — this task adds tests only. If it needs a source change, the cleanup is broken and that is a finding to report, not to patch silently.

**The gap.** `applyInFlight` locks three unmount paths while Apply is in flight — the panel's own close button, AppStrip's dock toggle, and the Settings route — so a conflict always has somewhere to be reported. `setApplyInFlight(false)` sits in `apply()`'s `finally`, which is correct.

But the only test that exercises it resolves with `{ applied: 1, conflict: null }` — the success path. The Slice 3 re-reviewer demonstrated the consequence: moving that cleanup out of `finally` into the success branch, so a conflict or a rejected call left the dock and Settings **permanently locked**, still passed all 508 tests. The shipped code is right; nothing holds it there.

- [ ] **Step 1: Write the tests**

Add to `apps/devbench/src/components/db/PendingPanel.test.tsx`, beside the existing in-flight test:

```tsx
  // The cleanup lives in a `finally` for these two cases specifically. Without
  // them, moving it to the success branch — which would leave the dock and
  // Settings locked forever after any failed Apply — passes the whole suite.
  it("releases the in-flight lock when the transaction rolls back", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockResolvedValue({
      applied: 0,
      conflict: {
        index: 0, table: "public.orders", description: "id = 1", column: "status",
        expected: "pending", found: "cancelled", row_missing: false,
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(useAppStore.getState().applyInFlight).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Close pending changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("releases the in-flight lock when the call itself fails", async () => {
    seed([UPDATE]);
    vi.spyOn(tauriLib, "invokeApplyChanges").mockRejectedValue(new Error("connection refused"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Apply 1" }));

    await screen.findByRole("alert");
    expect(useAppStore.getState().applyInFlight).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Close pending changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
```

- [ ] **Step 2: Run them — they must PASS immediately**

Run: `cd apps/devbench && bun run test src/components/db/PendingPanel.test.tsx`
Expected: PASS. This task documents correct behaviour rather than fixing broken behaviour, so a failure here is a real defect — **stop and report it** instead of editing the source.

- [ ] **Step 3: Verify they discriminate — this is the whole point of the task**

Temporarily move `setApplyInFlight(false)` out of `apply()`'s `finally` block and into the success path only (just after `bumpApplyGeneration()`). Re-run the file. **Both new tests must fail.** Restore the `finally`. Report what you observed — if they still pass, the tests are not pinning what they claim to and need rewriting.

- [ ] **Step 4: Run the full suite and build**

Run: `cd apps/devbench && bun run test` → baseline **+2** (515 / 50).
Run: `cd apps/devbench && bun run build` → clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/mk/Downloads/app/Bench/bench-apps/.claude/worktrees/devbench-db-connections
git add apps/devbench/src/components/db/PendingPanel.test.tsx
git commit -m "test(devbench): pin the in-flight lock's release on both failure paths"
```

---

## Self-Review

**Coverage:** All three parked findings this plan claims are addressed — the subset-relative conflict index (Task 1), the refetch trigger's two failure directions (Task 2), and the untested in-flight cleanup (Task 3). The two parked items deliberately excluded are "Discard all" scoping (awaiting a UX decision) and the `sql` arm's missing Rust test (belongs with Slice 4, which is what first makes it reachable).

**Type consistency:** `applyGeneration` / `bumpApplyGeneration` are spelled identically in the store, `PendingPanel`, `DbTab` and all four new tests. `onConflictIndex` is the only new prop and appears in `PendingPanel`'s signature, its type block and its test helper. `onApplied` is removed from `PendingPanel` and `App.tsx` together — no caller survives.

**Ordering:** Task 1 is independent. Task 2 removes `onApplied`, which Task 1's test helper does not touch. Task 3 asserts against `apply()` as Task 2 leaves it, so it runs last — its Step 3 experiment moves a line that Task 2 places.

**Expected final numbers:** vitest **515 / 50 files** (+7 from 508); build clean; cargo unchanged at 249 + 1 ignored (lib) and 6 (smoke), since this plan touches no Rust.
