# DevBench

A local-first desktop dev tool that unifies API testing, a Postgres browser, log tailing, and
email capture around one core action: fire a request, then see everything it did.

The differentiator is the **"what happened" rollup** — firing a request produces a before/after
diff of the Postgres tables you're watching (by primary key + content hash, so an `UPDATE` that
touches zero net rows still shows up), with zero backend instrumentation required. See
[PRODUCT.md](PRODUCT.md) for the full product vision and [DESIGN.md](DESIGN.md) for the visual
system.

## Status

This repo currently implements **v1 core loop** only: the app shell, the API tab (request
builder, response viewer, history), the DB tab (Postgres schema browser, row grid), and the
correlation/diff engine connecting them. Log tab, Email tab, Sessions/Archive, Split view,
Settings, and the AI chat dock are deliberately out of scope here — see
[docs/superpowers/plans/](docs/superpowers/plans/) for the implementation plan and its stated
scope boundaries, and PRODUCT.md for where those pieces fit in the full product.

## Stack

Bun + Turborepo (monorepo) · Vite + React + TypeScript + Zustand + Tailwind CSS v4 (frontend) ·
Tauri 2 + Rust + sqlx (backend — Postgres for the user's target database, SQLite for DevBench's
own local storage) · Vitest + React Testing Library (frontend tests) · Rust's test framework,
including integration tests against a real local Postgres for the diff/correlation logic
(never mocked — see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Prerequisites

- [Bun](https://bun.sh) — package manager and workspace runner (this repo uses it exclusively;
  no `npm`/`yarn`)
- [Rust](https://rustup.rs) (stable toolchain) — for the Tauri backend
- [Docker](https://docs.docker.com/get-docker/) — for the local Postgres instance used in
  development and required by the backend's integration tests

## Getting started

```bash
# 1. Start local Postgres (localhost:5432, db `devbench_test`, user/password `postgres`/`postgres`)
docker compose up -d

# 2. Install dependencies
bun install

# 3. Launch the app (opens a Tauri window)
cd apps/devbench && bun run tauri dev
```

The DB tab connects to the Postgres instance from step 1 by default. It starts empty — create
a table (via `psql`, or any client) to see it appear in the schema browser and try watching it.

## Testing

```bash
# Frontend
cd apps/devbench && bun run test        # Vitest
bunx tsc --noEmit                        # type check
bun run build                            # production build (tsc + vite build)

# Backend (requires the local Postgres from `docker compose up -d`)
cd apps/devbench/src-tauri && cargo test
```

## Contributing

Commit message, branch naming, and PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
