# Starter kits — templates, `npm init @mailwoman`, generated starter repos — design

**Date:** 2026-08-04
**Status:** approved by operator (conversation, 2026-08-04)
**Depends on:** the wave-2 docs site (tutorials are the source of each kit's worked example); the `mailwoman data` CLI; the candidate-default resolver backend (#1444).

## Problem

The ten-minute trial still asks a developer to assemble a project by hand. Starter kits compress the journey to one command, and template repos make the same journey visible on GitHub. Both surfaces must stay true the way the docs now stay true: single-sourced, executed before shipped.

## Decisions (operator-approved)

1. **Four kits:** `geocoder` (Node parse+geocode app), `server` (self-hosted API with Docker), `browser` (web-loader + WASM resolver, self-hosted weights), `dropin` (Photon/Nominatim-compatible server for existing clients).
2. **Single source:** a `templates/` tree in the monorepo is the only hand-edited copy. Everything else is generated from it.
3. **The engine lives in the mailwoman CLI** (operator amendment 2026-08-04: "ideally they have it from day 1"): `mailwoman create [template] [dir]` is a Pastel command in the entry package, templates bundled with it — anyone with mailwoman installed has the scaffolder. `@mailwoman/create` (`npm init @mailwoman` → picker) and `@mailwoman/create-{geocoder,server,browser,dropin}` (`npm init @mailwoman/geocoder`) are thin delegates over the same engine module, kept for the npm-init ergonomics only.
4. **Generated repos live in the mailwoman GitHub org:** `mailwoman/starter-{geocoder,server,browser,dropin}` — template-flagged, force-synced from `templates/` at release time, banner marking them generated ("PRs go upstream"). Anything outside the monorepo goes in that org.
5. **Executed before shipped:** monorepo CI runs a pack-based cold-scaffold smoke per template; each generated repo carries a scheduled action running the same smoke against published npm (the publish-reality canary).

## Shape

- **`templates/<kit>/`** — a complete minimal project: `package.json` with versions **stamped at publish time** from the workspace release (never `latest`), a first-run script opening with `mailwoman doctor`, the kit's worked example lifted from its tutorial, a `smoke.sh` asserting the first command's output, a generated-header README. Shared scaffolding (data-pull bootstrap, doctor-first) lives once under `templates/_shared/` and is composed at build.
- **`@mailwoman/create`** — prompts: project name, template (skipped when preselected), offer-not-run for `data pull` (print the command; never download during scaffold). Copy → rename → `npm install` → print next steps. Node floor mirrors the `mailwoman` package's engines.
- **Shims** — depend on the engine, pass the template name, nothing else.
- **Repo sync** — a release-time CI job renders each template (stamped versions) and force-pushes to its `mailwoman/starter-*` repo; repo settings: template flag on, issues off (or a redirect note), the generated banner in the README.
- **Docs integration** — trial page gains the one-liner entry; each tutorial links its starter as the skip-the-setup path; Product capabilities links the org's starter repos.

## Acceptance

- `npm init @mailwoman -- --template geocoder` in an empty dir on a clean machine produces a project whose `npm start` (or the kit's first command) succeeds after the printed next steps — verified by the pack-based smoke in CI for all four kits.
- The four `mailwoman/starter-*` repos exist, are template-flagged, carry the generated banner, and match the release's rendered templates byte-for-byte.
- All five packages published (first-publish blessing is an operator step; the runbook documents it).
- Docs pages updated and gate-green.

## Non-goals

- No interactive TUI beyond the template picker; no framework-specific variants (Next/Vite adapters are future kits); no telemetry; no scaffold-time downloads.
