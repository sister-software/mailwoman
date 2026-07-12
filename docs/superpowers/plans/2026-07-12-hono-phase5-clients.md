# Hono API surface, Phase 5: typed schemas, spec emission, client generation, docs sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the arc: type the flagship wire schemas (client generators need them), make spec emission a first-class CLI affordance (each surface prints its own document; the docs site regenerates its copies at build), stand up the Python/Rust client-generation pipeline as a GATED release-workflow job (generation + artifact always; registry publishing off until the operator provisions PyPI/crates.io), and pay down the docs debt. `feat/api-clients` is superseded, its layout/publishing notes salvaged.

**Architecture:** Everything stays one-directional: route tables → emitted documents → generated clients, nothing committed downstream of the spec. Spec emission = an `openapi` subcommand on each drop-in CLI (each already owns its app; zero new deps) + a `mailwoman openapi` command for the native surface (`mailwoman` deps `@mailwoman/api` already). The docs site's static spec copies become build products (docs prebuild runs the emitters), killing the staleness class permanently. Client generation salvages the abandoned branch's layout decisions (`mailwoman_client` Python package with per-surface modules; progenitor compile-time Rust crate) — the operator authored those names; the difference is the specs now come from the emitters, and nothing generated lands in git.

**Publishing gate (operator dependency, explicit):** PyPI/crates.io publishing requires accounts/tokens the operator hasn't provisioned. The workflow job GENERATES and uploads artifacts unconditionally on dispatch; the publish steps run only when `publish_clients=true` AND the secrets exist. RELEASING.md documents both halves.

**Tech Stack:** hono/zod stack as before; `uvx openapi-python-client@0.29` (present); `cargo` 1.96 + progenitor (salvage version pin from the branch); GitHub Actions.

## Global Constraints

- One-directional artifacts (no generated client source in git; docs spec copies are build products, `.gitignore`d where generated).
- Scripts drawer stays CLOSED: emitters are owning-package CLI subcommands (`mailwoman-libpostal openapi`, `mailwoman-photon openapi`, `mailwoman-nominatim openapi`, `mailwoman openapi`), Pastel/parseArgs per each CLI's existing style. Each prints the v31 document to stdout by default; `--flavor 3.0` prints the 3.0.3 document (progenitor's diet); `--out <path>` writes instead.
- Typed-schema pre-work is a doc-accuracy change ONLY — wire behavior frozen (suites prove it); the `z.infer` drift pin lives in `mailwoman` (which owns `GeocodeResult`) so `api` stays engine-agnostic.
- Salvage source: `origin/feat/api-clients` — read `clients/README.md`, `clients/PUBLISHING.md`, `clients/python/pyproject.toml`, `clients/rust/Cargo.toml` via `git show` for names/versions/layout; the branch itself stays untouched and unmerged (PR body records supersession).
- Standing rules: 5-point registration N/A (no new workspace); `erasableSyntaxOnly`; `.ts` imports; acronym casing; both exports maps if subpaths change; lockfiles with their change; compile-before-out; oxfmt; one `--dir` per vitest run; exact-PID kills; git ops sequential; `$public` for env.

---

### Task 1: Typed wire schemas + api/serve leftovers

**Files:**

- Modify: `api/schema.ts` (typed `GeocodeOutcomeSchema`; tighten `ParseOutcomeSchema.solutions` + `HealthResponseSchema` only where cheap and accurate), `api/routes.ts` (503 `detail` remediation hints), `mailwoman/commands/serve.tsx` (preflight banner prints once — dedup via a primary-side cheap existence check or a worker-0-only print; implementer's choice, documented)
- Create: `mailwoman/test/api-schema-drift.test.ts` (the `z.infer` ↔ `GeocodeResult` compile-time pin)
- Test: `api/index.test.ts` additions

Details:

- `GeocodeOutcomeSchema` models `GeocodeResult`'s wire shape from `mailwoman/geocode-core.ts` (read it: input, lat, lon, resolution_tier, uncertainty_m, locality, region, postcode, house_number, street, countryCode, hierarchy, candidates…) as a `.loose()` object with the real field types, all optional-where-nullable — hand-modeled in `api/schema.ts` with NO import from `mailwoman` (engine-agnosticism); the drift pin in `mailwoman/test/api-schema-drift.test.ts` does `const _pin: z.infer<typeof GeocodeOutcomeSchema> = {} as GeocodeResult` style compile-time assignability checks BOTH directions (comment which direction guards what) — a compile failure, not a runtime assertion, is the alarm.
- 503 hints: `apiError(c, 503, "geocoder not available", "install @mailwoman/neural + @mailwoman/resolver-wof-sqlite and provide gazetteer data (MAILWOMAN_WOF_DB / MAILWOMAN_CANDIDATE_DB)")` — same for batch/resolve/reload with their message; the express-era remediation text returns via `detail`. Update the pinned 503 tests to match (exact bodies).
- Redocly re-receipt for the native document (zero errors still).
- Commit: `feat(api): typed geocode wire schema + 503 remediation details; single preflight banner`

### Task 2: Spec emission CLIs + docs build products + jsonld doc accuracy

**Files:**

- Modify: `libpostal/cli.ts`, `photon/cli.ts`, `nominatim/cli.ts` (add the `openapi` subcommand — app construction with a stub engine `{}`, `emitOpenAPIDocuments`, print/write; update usage lines)
- Create: `mailwoman/commands/openapi.ts` (Pastel command; native document via `createMailwomanAPI({})`)
- Modify: `docs/package.json` + docs build (prebuild emits `docs/static/openapi/{libpostal,photon,nominatim,mailwoman}.json` via the four CLIs; DELETE the orphaned `docs/static/openapi/*.yaml` copies; gitignore the generated .json)
- Modify: `docs/articles/api.mdx` (table rows → the .json build products; prose already correct)
- Modify: `photon/routes.ts` + `nominatim/routes.ts` (jsonld 200 doc accuracy: the 200 response schema becomes the documented union — FeatureCollection | schema.org array (photon), result | array | FeatureCollection per format (nominatim) — via `.openapi()` metadata/oneOf on the RESPONSE content schema ONLY; handlers untouched; suites + parity semantics unchanged)
- Tests: one emission test per CLI addition is overkill — the per-package `/openapi.json` tests already pin content; add a single integration check in `mailwoman/test` that `mailwoman openapi` (compiled) prints a document starting `{"openapi":"3.1.0"` (compile first — CLI tests run out/).
- Commits: `feat: openapi emit subcommands on every surface CLI` + `docs: spec copies are build products; jsonld response unions documented`

### Task 3: Client generation pipeline (local, verified)

**Files:**

- Create: `clients-pipeline/` — NO. Owning-package rule: create `mailwoman/tools/generate-clients.ts` behind a `mailwoman clients generate` Pastel command (mailwoman owns the release tooling drawer per the Pastel arc): emits all four specs (3.0 flavor for Rust) to a work dir, runs `uvx openapi-python-client@0.29 generate` per spec into a salvaged-layout Python package, assembles the Rust crate (progenitor macro + vendored emitted specs, salvaged Cargo.toml pinned versions), then VERIFIES: `uvx --from ./<python-dir> python -c "import mailwoman_client"`-style import check (or `uv build` + wheel import), `cargo check` in the crate dir. Nothing lands in git — output under a gitignored `clients-build/` (add the gitignore entry).
- Salvage first: `git show origin/feat/api-clients:clients/PUBLISHING.md` (+ pyproject/Cargo.toml) — carry names (`mailwoman-client` PyPI / crate name as authored), version scheme (match npm version), license, and the useful README prose into a new `docs/articles/reference/api-clients.mdx` (or extend api.mdx — implementer reads the docs layout and picks the idiomatic spot).
- Receipt: full local run — four specs emitted, Python package builds + imports, `cargo check` passes. Capture output.
- Commit: `feat(mailwoman): client-generation pipeline — Python + Rust from the emitted specs (nothing committed downstream)`

### Task 4: The gated CI job

**Files:**

- Modify: `.github/workflows/publish.yml` (read its header docstring + RELEASING.md FIRST — this workflow has bitten before): add a `clients` job AFTER the npm publish steps: checkout, setup (node + uv + rust toolchain actions), compile, `mailwoman clients generate`, upload both artifacts (`actions/upload-artifact`); then two publish steps EACH gated `if: inputs.publish_clients == 'true'` AND secret-presence (`PYPI_API_TOKEN` / `CARGO_REGISTRY_TOKEN`) — `uv publish` / `cargo publish`. New workflow_dispatch input `publish_clients` (boolean, default false, description says operator must provision registry accounts first).
- Modify: `RELEASING.md` — a "Client packages" section: the artifact-always/publish-gated split, the operator TODO (account provisioning, token secrets, first-publish name claims), and the local `mailwoman clients generate` receipt command.
- Verification: `actionlint` if available (`npx --yes actionlint` or skip with a note); NO live workflow dispatch (publishing workflow — operator territory; the local Task-3 receipt is the generation proof).
- Commit: `ci(publish): gated client-generation job — artifacts always, registry publish behind publish_clients + secrets`

### Task 5: Wrap

- Repo green (all suites, integration, smoke-clean-install, lint), fresh compile.
- PR `feat: Hono API surface, phase 5 — typed schemas, spec emission, gated client generation` covering: the drift-pin mechanism; emission CLIs + docs build products (staleness class dead); jsonld doc unions; the salvage inventory from feat/api-clients + its formal supersession (branch left in place, unmerged, referenced); the publish gate + operator TODO list (PyPI/crates.io provisioning) called out prominently; docs sweep completion. Attribution line.
- Controller: final whole-branch review (fable) → fixes → CI → merge under the standing grant. After merge: notify operator with the arc-complete summary + the two operator handoffs (registry provisioning; hosted drop-in unit redeploys).
