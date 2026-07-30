# Contributing

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>`

- `type` — one of `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `style`, `ci`, `build`
- `scope` — optional, the touched area (e.g. `devbench`, `correlation`, `db`)
- `subject` — imperative mood, lowercase, no trailing period (e.g. `add fire_request tauri command`)

```
feat(devbench): add fire_request tauri command

Fires an arbitrary HTTP request from Rust so the frontend never needs
its own HTTP client — keeps all network/DB access on one side of the
Tauri boundary.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

Body is optional — use it to explain *why*, not *what* (the diff already shows what).
Include the `Co-Authored-By` trailer whenever Claude authored or co-authored the change.

## Branch names

`<type>/<kebab-case-slug>`, matching the commit `type` above — e.g. `feat/devbench-core-loop`,
`fix/db-connection-leak`, `docs/contributing-guide`.

## Pull requests

- **PR title** — same format as a commit subject: `<type>(<scope>): <subject>`. This becomes the
  merge commit message on squash-merge, so keep it accurate.
- **PR description** — use the template at `.github/pull_request_template.md` (GitHub applies it
  automatically to new PRs).
