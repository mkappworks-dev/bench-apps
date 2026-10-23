# DevBench API UI polish

Status: Draft for review; implementation has not started.

## Intent and visual authority

Finish the existing API request → response → history experience for a developer
debugging a backend. Preserve DevBench's restrained, moderately dense interface:
neutral surfaces, inverted primary action, semantic status colors, system UI
type, and the existing mono stack for request data. This is Operate mode.

The user selected refinement of the existing mockup and DevBench styling.
Authorities: `DESIGN.md`, `apps/devbench/src/styles/tokens.css`, shared `Menu`,
`Tabs`, and `SecondaryButton`, and `docs/mockups/devbench-api-composer.html`.
The mockup includes Saved features; those remain outside this work.

Source baseline: integration commit `7286a13`, based on main `d7d92ed`.
Its verification was 650 frontend tests, a passing TypeScript/Vite build,
and 280 Rust tests passing with one OS-keychain test ignored. These are
historical results, not verification of this proposed polish.

## Evidence and limits

Source inspection found disappearing new Params rows, unsafe query decoding,
native selects in Body/Auth, incomplete tab semantics, mouse-only resizing,
unassociated Auth labels, a reversible Basic-auth preview, misleading empty
history while loading, UTF-16 character counts presented as bytes, and fixed
history sizing in split panes.

No rendered audit has been completed. Automatic approval review rejected
opening a collaborative preview because private rendered content could be
disclosed to an unapproved destination. No alternate browser was used to bypass
that decision. A rendered baseline and final visual check are required before
declaring the UI polished. Delegated design review is also unavailable under
the earlier repository-disclosure rejection; this draft received local review.

## Scope

1. Make Params editing reliable without creating a second persisted source of
   truth. Preserve incomplete blank-key rows as transient editor drafts. Persist
   and send only the URL. Editing the URL replaces the projected rows; echoes
   of the editor's own URL patch must retain its unfinished rows and focus.
2. Align composer controls, tabs, rows, and response/history presentation with
   the existing design. Complete keyboard, pointer, focus, loading, empty,
   disabled, error, and long-content behavior.
3. Keep the complete API workflow usable in desktop split panes and at zoom.
   Narrow-pane adaptation is part of this desktop app, not a new mobile app.

Saved requests, Save/rename/delete, collections, environments, syntax editors,
JSON validation, request replay, new auth schemes, new dependencies, global
shell redesign, and a new persistence model are excluded.

## Binding behavior

- Rust receives only method, URL, enabled `HeaderPair` entries, and optional
  body. No Rust auth types, enabled flags, or separate params payload.
- Method and URL remain controlled through `onPatchState`. Keep connection IDs,
  qualified watched tables, request/history IDs, correlation guards, per-tab
  isolation, and Email/history deep links.
- Headers/body/auth retain Plan 1's local state. Do not persist secrets or add
  a `params` field to tab storage during polish. Resizing is transient.
- No SQL changes. Existing migrations remain uniquely numbered 0001–0009;
  `0009_request_history_headers.sql` is not edited or renumbered.
- No fake Saved controls or sidebar-layout switch from the mockup.

## Detailed decisions

The following are proposed implementation choices, not additional user decisions.

**Params.** Split at the first query delimiter before the fragment, and the first
equals sign per pair. Keep duplicate keys, ordering, empty values, relative URLs,
and fragments. Decode `+` as a query-space and `%2B` as a literal plus. If decoding
a component fails, display its raw text rather than throwing. Direct URL typing
does not normalize the URL; row edits may encode it canonically with `%20` spaces.
Blank-key draft rows stay visible but are excluded from the URL and send payload.

**Composer.** Keep Method → URL → Send ordering and the existing PATCH option.
Use shared Menu pickers for Body type, Auth type, and API-key destination. Keep
the request tab underline and use the existing Base UI Tabs wrapper for semantics
and keyboard navigation. Default panel remains Headers. Give all inputs real
labels, including row-specific key/value names. Keep visible focus in both themes.
Use the existing SecondaryButton for row-add actions and inline SVG for removal.

**Row box.** Keep 168px initial height, 64px minimum, 420px maximum, and the centered
36×4px grip. Add pointer/touch support and a focusable horizontal separator:
ArrowDown/ArrowUp adjust by 16px; Home/End select the bounds. Expose current/min/max
values. End dragging on pointerup, pointercancel, loss of capture, and unmount.

**Body and Auth.** None disables the body editor without deleting its draft;
switching back restores it. Keep a 140px minimum body editor. All visible Auth
labels name their fields. Basic preview is `Adds header  Authorization: Basic
••••`, with no encoded credential prefix. Bearer/API-key masking follows the
existing short-secret rule. Actual auth resolution and body/header wire rules
remain unchanged. Long previews wrap inside the pane.

**Response and History.** Add the mockup's Response heading and proper Body/Headers
tabs, with status and duration still visible. Use success for 2xx, warning for 3xx,
danger for 4xx/5xx; status numbers remain explicit. Empty response body reads
`Empty response body.`. Preserve repeated response headers and full values.
Read-only Sent disclosure appears only for history; its body size is UTF-8 bytes.
History distinguishes loading, genuinely empty, fetch failure, and missing
deep-link target. Loading copy is `Loading history…`; retain existing error and
session-empty copy. Do not label failure as empty or discard focus behavior.

**Layout.** API owns its pane layout like DB/Query, replacing its negative-margin
compensation for shell padding. Scope CSS under an API root, using pane container
width rather than viewport width. At widths above 640px retain a 220px history
rail, 24px main padding, and the existing 720px maximum main column. At 640px or
below, put history above the main content with a 160px maximum scroll area and
12px main padding. At 480px or below, Send moves to a full-width row after Method
and URL. Keep a 16px gap between major content groups. Long data must wrap or
scroll within its own area; it must not widen the shell or obscure controls.

## Acceptance

The complete path works with mouse and keyboard: compose params/headers/body/auth,
send, inspect response tabs and rollup, select history, inspect Sent, follow an
Email deep link. Switching API instances must keep independent drafts and tab IDs.
The response and rollup remain reachable after adding many headers.

Check dark/light at desktop 1440×900 and 1024×768, plus API pane widths 640, 420,
and 320px and 200% zoom. Include a 2,000-character URL/header value, 20 header rows,
empty responses, Unicode bodies, and unresolved history fetches. No pane-level
horizontal overflow, clipped pickers, invisible focus, or console exceptions.
Semantic text and control/focus contrast must meet WCAG AA in both themes; use
stronger existing text tokens where faint text is insufficient.

Automated verification covers behavior and real IPC payload construction, not
CSS class snapshots. Run the full frontend suite/build and the final Rust suite.
Run the Impeccable detector once on changed UI, then one batched visual inspection,
one grouped correction pass if needed, and at most one confirming visual pass.
No polish completion claim while rendered verification is missing.
