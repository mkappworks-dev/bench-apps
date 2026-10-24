# DevBench Log UI polish

**Goal:** Carry the visual details in `docs/mockups/devbench-log-capture.html` into the implemented Log tool.

**Scope:** Existing React components, shared Menu primitive, and existing theme tokens. Preserve capture, persistence,
search semantics, per-tab mode state, and virtualization. No Rust or migration changes.

- [x] Combine the live filter, level chips, segmented mode switch, and status indicator in one wrapping toolbar.
- [x] Use SVG source icons, trailing status dots, and neutral exited-source details.
- [x] Open the kind menu from the sidebar header and place compact, labeled forms inside the sidebar.
- [x] Add severity borders, hover states, and accessible full-message tooltips to virtualized log rows.
- [x] Refine the historical-results surface and show source labels, falling back to source IDs for removed sources.
- [x] Cover all kind-specific fields, source attribution, and the sidebar Add Source flow with component tests.
- [x] Run frontend tests, production build, and one design-detector pass; inspect dark/light and narrow layouts in a browser.

**Review focus:** narrow split panes, long source names/messages, keyboard access, exited/error distinction,
and history belonging to sources that have been removed.

**Validation:** 646 frontend tests passed across 57 files; production build passed.
Dark/light rendered component previews and a 520px pane were inspected using sample data.
No Rust or migration files changed.

**Review:** Fixed root inline-containment sizing in the real `SplitContent` flex wrapper.
Browser regression reproduced a 0px Log tool before the fix and measured full 1000px/520px pane widths after adding flex growth.
