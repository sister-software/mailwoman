# Hono API surface, Phase 4b: the cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut `mailwoman serve` over to `@mailwoman/api` with a fully wired engine, delete `mailwoman/server/` and the last express dependency, repoint the RemoteResolver protocol to `/v1/resolve`, re-stamp the three drop-in documents with full info (redocly-clean), and true up the docs (AGENTS.md workspace table, spec amendments).

**Architecture:** One more dependency-wall amendment, recorded like the others: the drop-in packages depend on `mailwoman` (their CLIs wire engines from `mailwoman/geocode-core`), so `mailwoman serve` importing `createPhotonApp` et al. would cycle. **`mailwoman serve` therefore serves the native surface only.** The spec's "mounts all four at prefixes" is amended (annotated) — every surface app and its engine wiring are exportable, so a unified process is a ten-line user script (documented as an example), and the per-package `serve` CLIs remain the deployment story. The engine wiring lives in a new `mailwoman/api-engine.ts` — the port of `GeocodeRouter.getDeps` + the express handlers' engine-side behaviors, honoring the 4a handoff notes: batch rows trimmed, per-row batch metrics + resolve-tree street-tier metric recorded via api-kit's `recordTimed`, boot-time friendly preflight instead of runtime 503s (the drop-ins' #1009 pattern).

**Tech Stack:** as phases 1–4a. Exemplars on main: `api/*`, the drop-ins, `api-kit/*`.

## Global Constraints

- **Wire notes:** the native surface is ours — `/v1/*` replaces `/parse` + `/api/*`. `RemoteResolver` reads only `res.ok` + `json.tree.roots` (verified in the 4a final review), so the repoint is config/docs, not code: its docstring example, any env-schema description, and any default endpoint strings change from `/api/resolve-tree` to `/v1/resolve`. `RemoteResolver` itself is caller-configured — DO NOT change its class code.
- **Deletions are final** (no shims): `mailwoman/server/` (all routers, metrics.ts + its test, `static/` — the old Pelias-debug pages), `express` from `mailwoman/package.json`. `mailwoman/server`'s subpath export in `mailwoman/package.json` (check both exports maps) goes too — breaking, next-major train continues.
- **Engine behaviors carried from express** (the 4a handoff notes in `api/routes.ts` + ledger): batch rows trimmed before geocode; per-row batch metrics (`recordTimed` per row with the row's tier); resolve-tree records the street node's stamped tier (`collectStreetTier` port, `"admin"` fallback, `"error"` on throw); geocode's `defaultCountry` heuristic (candidate backend → undefined, FTS → "US"); interp calibration threading; `MAILWOMAN_BATCH_CONCURRENCY`/`MAILWOMAN_BATCH_MAX` env reads via `$public` stay in the engine/serve layer (never raw env).
- **Boot preflight:** `mailwoman serve` fails friendly at boot when neural/resolver deps or WOF data are missing (message shape mirrors the drop-ins' #1009 block, pointing at `MAILWOMAN_WOF_DB` + the gazetteer fetch), instead of express's lazy 503s. The `/health` endpoint still answers even when degraded (health data provider ports from `HealthRouter` — model card read, shard counts, release manifest).
- **Graceful shutdown** (spec's deferred house flag, landing now): the serve command handles SIGINT/SIGTERM → `server.close()` → exit; cluster primary forwards to workers. Keep the Pastel/Ink cluster UI structure (ClusterManager/WorkerStatus untouched except the boot swap in ChildThread).
- **Drop-in doc re-stamp:** the three drop-in `app.ts` files pass full `OpenAPIDocInfo` (license AGPL-3.0-only OR LicenseRef-Commercial + identifier, contact Sister Software + site, externalDocs → their switching pages, servers with host/port template vars matching each CLI's defaults, `security: []`, tags matching their route tags). Receipt: redocly lint each emitted document — zero errors ×3.
- **Docs trued up:** AGENTS.md workspace table gains `api-kit/` + `api/` rows (count 34→36 workspaces, publishable 33→35) and the `mailwoman` row's description drops the express server mention; spec gets TWO annotated amendments (endpoint sketch → the implemented set incl. POST-only + batch/reload/metrics; serve-mounting → native-only with the cycle rationale + compose-your-own pointer).
- Tests: the three `mailwoman/test/*-router.test.ts` files port to the wired engine (same skip-if-stack gates: error paths unconditional via `createMailwomanAPI(wiredEngine)`… note error paths need NO stack — use the engine factory's preflight-bypassed form or fixture engines; success paths gate on WOF+shards as today). `server/metrics.test.ts` dies with its module (api-kit's port owns the coverage — verify api-kit/metrics.test.ts covers every assertion the old file had before deleting; anything missing moves over).
- Standing rules: `erasableSyntaxOnly`; `.ts` imports; acronym casing; both exports maps when touched; lockfile with its change; compile before `out/`; oxfmt; one `--dir` per vitest run; exact-PID kills; git ops sequential.

---

### Task 1: `mailwoman/api-engine.ts` — the wired engine + ported tests

**Files:**

- Create: `mailwoman/api-engine.ts`
- Create: `mailwoman/test/api-engine.test.ts` (ports the three router test files' coverage)
- Modify: `mailwoman/package.json` (add `"@mailwoman/api": "workspace:*"` dep — NOT the reverse; verify no cycle: api does not depend on mailwoman)

**Interfaces:**

- Produces: `createServeEngine(): Promise<ServeEngine>` where `ServeEngine = { engine: MailwomanAPIEngine; preflight: { ok: true } | { ok: false; message: string } }` — builds the shared stack ONCE (classifier, resolver backend from `wofPaths()`/candidate detection, `ShardProvider`, parser) mirroring `GeocodeRouter.getDeps` + `AddressRouter`'s parser + `HealthRouter`'s health data; wires every `MailwomanAPIEngine` method:
  - `parse` — `createAddressParser().parse(address, { verbose: true })` → the `ParseOutcome` shape (input span + serialized solutions + optional diagnostic report when `debug`), ported from `AddressRouter`.
  - `geocode` — `oneGeocode` port (geocodeAddress with classifier/resolver/shards/defaultCountry/interpCalibration). Route records the whole-call metric already; the engine records nothing extra here.
  - `batch` — ported worker-pool (bounded by `$public.MAILWOMAN_BATCH_CONCURRENCY`), rows TRIMMED, per-row `recordTimed(rowLatency, rowTier)` with `"error"` rows recorded and isolated to `{ input, error }` slots. Cap enforcement stays in the route (`batchMax` from `$public.MAILWOMAN_BATCH_MAX` is passed by serve when creating the app).
  - `resolveTree` — ported `resolveTreeHandler` body: region slug → shard selection → opts merge (defaultCountry, interp calibration) → `resolver.resolveTree` → `recordTimed` with the ported `collectStreetTier` result (`"admin"` fallback; `"error"` + rethrow on fault).
  - `reload` — `shards.reload()` port.
  - `health` — ported `HealthRouter` data block (model card, data_root, versions, wof_dbs, shard counts) as the `HealthData` object (top-level `status`/`uptime_s` are the route's).
  - Deps missing → `preflight.ok: false` with the #1009-style message; the engine object then carries ONLY `parse` (parser needs no gazetteer) + `health` — serve decides whether to boot (flag) or die friendly.
- Tests: port every assertion from `geocode-router.test.ts` / `resolve-router.test.ts` / `health-router.test.ts` onto `createMailwomanAPI((await createServeEngine()).engine)` + `app.request()` — error paths unconditional (fixture-level: the 400s come from the routes and need no stack; assert them against a `createMailwomanAPI({})`-with-wired-parse variant where stack is absent), success paths behind the SAME `describeIfStack`/`describeIfWOF` gates and equivalent assertions (geocode Austin TX success shape, batch order + isolation, resolve-tree roots, health/metrics shapes). Old `/api/resolve` XML-endpoint tests DO NOT port (endpoint retired with the debug pages — note it in the commit).

- [ ] Steps: read the three test files fully; write `api-engine.ts`; write the ported test file; `yarn vitest run --dir ./mailwoman` (new tests green, old router tests still green — they're deleted in Task 2, not here); `yarn compile`; oxfmt; commit `feat(mailwoman): wired MailwomanAPIEngine (api-engine) — the express router behaviors, engine-side`.

---

### Task 2: `mailwoman serve` cutover + server deletion + RemoteResolver repoint

**Files:**

- Modify: `mailwoman/commands/serve.tsx` (ChildThread boot swap + preflight + graceful shutdown; ClusterManager/WorkerStatus untouched)
- Delete: `mailwoman/server/` (entire directory incl. `static/` + `metrics.test.ts`), `mailwoman/test/geocode-router.test.ts`, `mailwoman/test/health-router.test.ts`, `mailwoman/test/resolve-router.test.ts`
- Modify: `mailwoman/package.json` (drop `express`; remove the `./server` subpath from BOTH exports maps if present; lockfile)
- Modify: `resolver/remote-resolver.ts` (docstring endpoint example only), plus every `/api/resolve-tree` reference found by `grep -rn "api/resolve-tree" --include="*.ts" --include="*.mdx"` (env-schema descriptions, docs) → `/v1/resolve`
- Verify-only: `mailwoman/commands/geocode.tsx` and any other `../server/` importer compiles clean after deletion (grep first; migrate stragglers to the api equivalents)

Boot swap sketch (ChildThread):

```tsx
useEffect(() => {
	let handle: ServerHandle | undefined

	void (async () => {
		const { engine, preflight } = await createServeEngine()

		if (!preflight.ok) {
			console.error(preflight.message)
			process.exit(1)
		}
		const app = createMailwomanAPI(engine, { batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX) })

		handle = serveNode({
			fetch: app.fetch,
			port,
			hostname: host,
			onListen: () => cluster.worker?.send("HTTP server ready"),
		})
		const shutdown = () => {
			void handle?.close().finally(() => process.exit(0))
		}

		process.once("SIGINT", shutdown)
		process.once("SIGTERM", shutdown)
	})()

	return () => void handle?.close()
}, [host, port])
```

(Adapt to the file's actual conventions — the NOTE(retrofit) comment updates; `process` import already present; `$public` import added. Static-file serving is DELETED with the debug pages — no replacement.)

Before deleting, run the metrics-coverage check from Global Constraints: diff `mailwoman/server/metrics.test.ts` assertions against `api-kit/metrics.test.ts`; move anything missing.

- [ ] Steps: grep server importers → boot swap → deletions → dep/exports-map edits + `yarn install` → repoint greps/edits → `yarn vitest run --dir ./mailwoman` + `--dir ./api` + `--dir ./resolver` → `yarn compile` (clean-tree: `rm -rf mailwoman/out` first — deletions + stale out lie together) → `yarn test:integration` → oxfmt → commit `feat(mailwoman)!: serve on @mailwoman/api; delete the express server (RemoteResolver protocol moves to /v1/resolve)`.

---

### Task 3: Drop-in doc re-stamp (redocly ×3) + docs true-up

**Files:**

- Modify: `libpostal/app.ts`, `photon/app.ts`, `nominatim/app.ts` (full `OpenAPIDocInfo` per Global Constraints)
- Modify: `AGENTS.md` (workspace table: + `api-kit/` + `api/` rows in the appropriate groups, counts updated, `mailwoman` row description drops the express server)
- Modify: `docs/superpowers/specs/2026-07-12-hono-api-surface-design.md` (two annotated amendments per Global Constraints)
- Docs sanity: `grep -rn "mailwoman/server\|/api/geocode\|/api/resolve" docs/articles --include="*.mdx"` — update live references to the /v1 equivalents (dated eval/postmortem docs stay untouched)

- [ ] Steps: re-stamp ×3 with per-package suites green (doc-config-only changes; each suite's `/openapi.json` test still passes) → redocly receipt ×3 (emit to scratchpad, lint, zero errors each — capture output) → AGENTS.md + spec + docs edits → oxfmt → commit in two: `feat(drop-ins): full-info OpenAPI documents (redocly-clean ×3)` + `docs: workspace table + spec amendments for the 4b cutover`.

---

### Task 4: Repo-wide green + live smoke + branch wrap

- [ ] Clean rebuild (`rm -rf mailwoman/out api/out && yarn compile`); suites: api 37, api-kit 17+, mailwoman (ported), libpostal 25, photon 31, nominatim 24; `yarn test:integration`; `node scripts/smoke-clean-install.ts`; `yarn lint:oxlint`; scoped oxfmt checks.
- [ ] **Express eradication receipt:** `grep -rn '"express"' */package.json` → zero hits; `grep -rn "from \"express\"" --include="*.ts" --include="*.tsx" .` (excluding node_modules/out/worktrees) → zero hits.
- [ ] **Live smoke** (compiled CLI, real stack, exact-PID kill): `node mailwoman/out/cli.js serve --port 13000 --cpus 1` & → curl `/v1/parse` (POST+GET), `/v1/geocode` (Austin TX address → address_point tier), `/v1/batch` (2 rows), `/v1/format`, `/health`, `/metrics` (reflects the calls), `/openapi.json`; then SIGTERM the exact PID and confirm clean exit (graceful-shutdown receipt).
- [ ] Push `feat/hono-serve-cutover`; PR: plan/spec links; the serve-mounting amendment rationale (dependency cycle, compose-your-own example); deletion inventory; RemoteResolver repoint note (config-compatible — endpoint is caller-supplied; docstring + env-description updates listed); redocly ×3 receipts; express-eradication receipt; graceful-shutdown receipt; breaking notes (server subpath + endpoints retired — next-major train). Attribution line.
- Controller: final whole-branch review (fable) → fix wave if needed → CI → merge under the standing grant.
