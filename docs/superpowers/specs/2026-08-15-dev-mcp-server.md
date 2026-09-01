# Development MCP server — design spec

**Status:** proposal, not implemented. **Written:** 2026-08-15. **Three forks decided 2026-08-16** (§9):
the workspace lives in-repo, the confound guard warns rather than refuses, and a small sample always gets its
aggregate with the confidence bound attached. **Build §11 first** — it is three tools, and it tests the one claim the
rest of the design rests on.

A long-lived daemon holding warm geocoder state, plus an MCP tool surface over it, so an agent working
in this repo reaches for a measurement instead of writing a throwaway probe script. The design goal is
narrower than "expose mailwoman to agents" — that already exists and ships (`packages/mcp/`). This one
exists to make **well-powered measurement the cheapest thing to do**, because the measured failure it
answers is sample selection, not reasoning.

---

## 1. Why this exists

### 1.1 The failure this is aimed at

Over one working day (2026-08-15) an agent wrote nine single-use probe scripts into `scratchpad/` to
answer questions the system should answer directly:

| Script                              | Question                                                | What happened                                                       |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| `fst-probe.ts`                      | Does the gazetteer FST prior change a parse?            | 10 self-chosen cases, none changed, concluded **"zero effect"**     |
| `fst-board-probe.ts`                | Same question, all 837 board inputs                     | **24 changed, 22 clear improvements.** The 10-case answer was wrong |
| `hierarchy-benefit.ts`              | Does `hierarchyCompletion` change anything?             | 0 of 837 — a real zero, because the denominator was stated          |
| `affix-diff.ts`                     | Which fixture row moved between two model versions?     | worked, cost a full cold start                                      |
| `pgn-probe.ts`                      | Which pipeline stage introduces a bad node?             | worked, cost a full cold start                                      |
| `icu-probe.mjs`, `keynorm-probe.ts` | Does this data source / normalizer cover these strings? | worked, cost a full cold start                                      |
| `bench-reverse-throughput.ts`       | How fast is reverse geocoding?                          | worked, cost a full cold start                                      |
| `acceptance-probe.ts`               | Parse one address under a specific weights cache        | worked, cost a full cold start                                      |

Four published conclusions were overturned by wider measurement in that one day. In every case the
reasoning was sound and the panel was not: the agent chose a small sample, and it chose cases
confirming the shape it already believed.

The FST pair is the whole argument in one number. **Zero differences in 10 trials rules out only true
rates above about 26%** (exact 95% upper bound `1 − 0.05^(1/10) = 0.259`; the rule-of-three
approximation gives `3/10 = 30%`). The true rate was `24/837 = 2.9%`, so a 10-case panel had roughly a
**75% chance** of observing exactly what it observed and concluding the opposite of the truth. Nothing
about that is a reasoning error. It is a design error in the instrument, and it is fixable in the
instrument.

This is the repo's own standing discipline — "the aggregate is not the verdict", "a magnitude never
carries its own absence", `AGENTS.md`'s **"the defects that survive review live in the input tail"** —
applied to the agent's own probes rather than to the parser.

### 1.2 The cost that makes small panels attractive

Measured on this box, 2026-08-15, with the OS page cache warm:

```
$ node packages/mailwoman/out/cli.js geocode --timing "350 5th Ave, New York, NY 10118"
[timing] startup.command_and_router   200.87 ms
[timing] startup.session_import        81.89 ms
[timing] init.weights                1004.79 ms      ← the dominant fixed cost
[timing] init.resolver_import          54.79 ms
[timing] init.backends                  2.00 ms
[timing] init.optional_providers        6.18 ms
[timing] init.placer_and_priors        22.87 ms
[timing] init.total                  1091.16 ms
[timing] geocode.total                253.28 ms      ← first query (includes ONNX warmup)
```

So roughly **1.37 s of fixed cost before the first answer**. Then, feeding 20 board inputs through one
process (`geocode --stdin`): **3.83 s wall**, which is about **123 ms per query** once warm.

Twenty inputs cost **3.8 s in one warm process versus about 30 s spawned per row — 7.8×**. The
existing benchmark scorer at `$MAILWOMAN_DATA_ROOT/pelias-rig/benchmark-scorer-panel-v2.mjs` drives
its mailwoman arm by spawning `node mailwoman/out/cli.js geocode` **once per row**, and panel-v2 is
420 rows: about **10.5 minutes of pure process startup** per arm, against about **52 seconds** of
actual work warm.

A daemon does not merely make experiments faster. It changes which experiments an agent is willing to
run, which is the same thing as changing which panel it picks.

### 1.3 The two claims this spec rests on

1. **Full-corpus measurement must be the path of least resistance.** A hand-picked panel must cost
   more to express than the whole board, not less.
2. **A result must carry its own denominator.** Every number the surface emits states what it was out
   of, how many rows errored, and what the input set did not cover.

---

## 2. What already exists, and what this must not duplicate

Grounding, so the spec proposes implementation rather than re-describing it.

### 2.1 `@mailwoman/mcp` — the shipped, public MCP server

`packages/mcp/` is a published workspace (`@mailwoman/mcp@9.1.0`) exposing nine tools over stdio:
`mailwoman_parse`, `mailwoman_geocode`, `mailwoman_poi_search`, `mailwoman_overpass_export`,
`mailwoman_layer_manifest`, `mailwoman_bdc_filing_landscape`, `mailwoman_plausibility_check`,
`mailwoman_filer_lookup`, `mailwoman_filer_family` (`packages/mcp/lib/tools.ts:260-412`).

Facts that constrain this design:

- It builds its geocoder by hand rather than through `createGeocodeSession`: a `corePromise` memo at
  `packages/mcp/lib/cli.ts:102`, `loadCore()` at `:115-163`, `geocodeAddress(...)` at `:212`. It therefore
  never sees `GeocodeTrace`, `PipelineTiming`, or `initTiming`.
- Deps are lazy and cached for the process lifetime; there is **no shutdown handler at all** — no
  `close()` on the resolver or `RegionDatabaseProvider`. Exit reclaims them.
- Locale is hardcoded `en-US` (`cli.ts:149`). One process, one geocode at a time; parallel tool calls
  serialize (`docs/articles/developers/how-to/use-the-mcp-server.mdx`, "Limits").
- No trace, debug, verbose or logging surface of any kind.
- The tool list is **pinned outside the package** by `MCP_EXPECTED_TOOLS` in
  `scripts/smoke-clean-install.ts:156-166`.
- The server name `mailwoman` and the bin `mailwoman-mcp` are taken.

**Consequence:** the dev server is a separate workspace with a separate server name, a separate bin,
and a distinct tool prefix. It must not appear in `MCP_EXPECTED_TOOLS`. It is `private: true` and
absent from `.release-it.json` — see §7.4 for the workspace accounting that implies.

### 2.2 `createGeocodeSession` — the warm-session abstraction that already exists

`packages/mailwoman/lib/geocode-session.ts:269` is the closest thing to the daemon today, and its header
(`:6-27`) states the purpose in the same terms: "a caller that geocodes more than once … pays for the
classifier, the gazetteer backend and the shard handles ONCE."

It returns `GeocodeSession { initTiming, geocode(input): Promise<GeocodeRun>, close() }` (`:172-179`),
where `GeocodeRun` carries `result`, the `AddressTree` it resolved from, a `PipelineTiming`, and an
optional `GeocodeTrace` (`:124-166`) holding `NeuralParseTrace`, `QueryShape`, the kind verdict, the
`InputMode` and the locale. It has a documented `close()` that releases every handle (`:411-418`), and
its construction order **is** the CLI's error contract (`:10-18`).

**The dev daemon builds on this, not beside it.** Everything the trace surface needs is already
assembled; `packages/mcp/lib/cli.ts` simply does not use it.

### 2.3 The eval harness — the graders already exist

- `packages/mailwoman/lib/eval-harness/gauntlet/harness.ts:228` `buildGauntletDeps` builds full-pipeline
  geocode deps with an optional **candidate model** and **resolver lever pins**
  (`GauntletResolverLevers`, `:70-77`). It already knows how to swap only the ONNX, or a whole
  package-shaped weights cache, and it routes per-country weights overlays (`:283-290`).
- `packages/mailwoman/lib/eval-harness/gauntlet/run.ts:186` `runGauntlet` runs the four layers —
  `regression`, `metamorphic`, `holdout`, `ablation` — and emits the combined verdict.
- `packages/mailwoman/lib/eval-harness/promotion-gate.ts` runs the full battery against a gate spec in
  `eval-harness/gates/*.json` and writes `verdict.json`.
- The board corpus is **837 rows** across 129 case directories under
  `packages/mailwoman/lib/eval-harness/gauntlet/cases/` (128 ISO country directories plus
  `generalization`), dominated by `regression.jsonl` (115 files) and `street-name-boundaries.jsonl`
  (25).
- `parity-corpus.ts` holds the 321-row triaged parse-parity fixture set with pre-registered floors;
  `preset-compare.ts` holds a **hardcoded 6-address eyeball comparison with no scoring at all**
  (`preset-compare.ts:13,39`) — a small self-selected panel wired into the release gate, and a good
  example of the shape this surface should make unattractive.

### 2.4 The head-to-head benchmark rig — the protocol is already locked

`docs/superpowers/plans/2026-08-06-local-pelias-benchmark-rig.md` §4 pre-registers the protocol, and
this spec adopts it verbatim rather than inventing a second one:

- top-1 result only; haversine with R = 6371 km; thresholds **1 / 5 / 25 km**
- a no-result (empty array **or** query failure) is a **miss at every threshold**
- the **same raw query string** to every arm, with no per-arm normalization
- bootstrap confidence intervals per locale with a pinned seed; a parity claim needs a TOST-style
  equivalence bound of **±5 pp @ 25 km**
- every row carries a pre-hoc `truth_type` (`rooftop` / `venue` / `city-only`) and
  `local_coverage_hint`, and **"@1km lives or dies on `truth_type`, reported per stratum, never
  blended silently"**

Five scored arms are named: mailwoman, local Pelias, local Nominatim, local Photon, hosted
geocode.earth. Public `photon.komoot.io` and `nominatim.openstreetmap.org` are explicitly _unpinned
sanity checks, never scored arms_.

The rig is built and running: `scratchpad/benchmark-rig/` (podman lifecycle for Pelias on
`127.0.0.1:4000`), `scratchpad/photon-rig/` (upstream Photon 1.3.0 on `127.0.0.1:2323`; port 2322 is
reserved for mailwoman's own Photon drop-in). Panels live outside the repo at
`$MAILWOMAN_DATA_ROOT/pelias-rig/panel/` — `panel-v2.jsonl` is 420 rows with a pinned SHA-256,
`panel-v3.jsonl` is 424.

### 2.5 `@mailwoman/geocode-oracle` — reference geocoders, already wrapped

`packages/geocode-oracle/` is `private: true` and wraps **Google Geocoding** and the **US Census
geocoder**, both answering in `@mailwoman/record`'s `PostalAddress` so comparison is field-to-field.
Both are `APIClient`s with disk caching under `$MAILWOMAN_DATA_ROOT/geocode-oracle/`, 60 requests per
minute, and `minRequestIntervalMs` set alongside the budget. Google requires
`$private.GOOGLE_MAPS_API_KEY` and is **billed**; Census needs no credential.

Its header states the boundary this spec inherits: _"Not truth, and not a gate. … Nothing here should
ever decide whether a build ships; a human reads it and decides what to pin."_

### 2.6 `packages/mailwoman/lib/dev-tools/*.run.ts` — the sanctioned probes

Twenty-eight committed probes already exist, several of which are exactly the tools proposed below
(`probe-fst-bias.run.ts`, `probe-query-intent.run.ts`, `router-kind-probe.run.ts`,
`failure-census.run.ts`). They are CLI scripts with `parseArgs`, and each pays the full cold start.
**The dev server should call these modules, not reimplement them** — several already encode the
meaning-of-zero distinction the surface needs (`probe-fst-bias.run.ts:19-21`: "`MISS` means the FST
does not accept the surface at all … A printed `0` means the FST DOES know the surface and scores it
zero. The two are different facts and the output keeps them apart.").

---

## 3. Architecture

### 3.1 Three process roles, not one

```
  agent (Claude Code)
        │  MCP stdio
        ▼
  mwdev-mcp            thin, stateless, one per agent process
        │  JSON-RPC over a Unix domain socket
        ▼
  mwdevd  (supervisor)  long-lived; owns the engine registry, the job queue, the run store
        │  fork/IPC
        ├── engine worker  (config A)   ← one process per resident configuration
        ├── engine worker  (config B)
        └── job worker     (gauntlet / gate / bench)
```

**Why the MCP process is not the daemon.** MCP stdio servers live and die with the agent process. The
state being amortized — a 1.0 s ONNX load, a 2.0 GB `candidate.db` handle, the shard providers — must
outlive agent restarts, context compactions and subagent spawns, and must be shared between them. The
MCP shim holds no engine state; it forwards, and it is cheap to restart.

If no daemon is reachable, the shim starts one and waits. `mwdev_daemon({action:"status"})` reports
which case applied. A single-process `--embedded` mode exists for CI, where nothing is shared and
warmth is worthless.

**Why one worker process per configuration.** Three reasons, each concrete:

1. **Reload.** The daemon runs _source_, not `out/` (§3.4). Node's ESM module cache means a source edit
   is invisible to an already-loaded module graph. The only reliable reload is a fresh process.
2. **Eviction.** Two resident candidate gazetteers are 4 GB of mapped state. Evicting a worker returns
   the RSS; dropping a reference inside a shared process does not, reliably.
3. **Isolation.** A candidate model that segfaults `onnxruntime-node` takes down one worker, not the
   registry.

**Concurrency is capped, and low on purpose.** `packages/mailwoman/lib/geocode-stream.ts:23-28` records
the measurement: on a shared multi-GB WOF SQLite, throughput peaked at **2 workers (~1.4×)** and
_degraded_ from there — 4 workers ≈ baseline, 6 ≈ no gain, because memory bandwidth and the shared DB
are the ceiling, not core count. The supervisor therefore defaults to a small concurrency budget and
serializes within an engine. `session.run()` in `onnxruntime-node` blocks the thread it is on, so
in-worker parallelism buys nothing.

### 3.2 The engine registry

An **engine** is one `GeocodeSession` (or one `GauntletDeps`) plus the configuration that produced it,
addressed by a content hash.

```ts
interface EngineKey {
	weights: { locale: string; cacheRoot?: string; modelPath?: string; modelMd5: string; cardVersion: string }
	gazetteer: { backend: "candidate" | "fts"; path: string; size: number; mtimeMs: number }
	dataRoot: string
	construction: { gazetteerPrior: boolean; placeCountry: boolean; placeCountryThreshold: number; forkEntity: boolean }
	treeFingerprint: string // §3.4
}
```

Hash it; that string is the engine id, and it appears in the provenance block of every result the
engine produces.

**Construction-time versus per-call is the required split**, and the harness already draws it. In
`buildGauntletDeps`, the model, the overlays and the resolver backend are construction-time; the
per-call options are `GauntletGeocodeOpts` — `defaultCountry`, `caseCountry`, `fuzzyCountryScope`
(`harness.ts:110-127`) — and the lever pins are spread into each `geocodeAddress` call
(`harness.ts:392-403`). `postcodeCountryCoherence` is a _dep_, not a construction parameter.

The practical consequence, and it should be documented at the tool surface: **comparing two flag
settings is nearly free** (one resident engine, two calls per input), while **comparing two models or
two gazetteers is expensive** (two resident engines, two multi-GB footprints). An agent should know
which kind of comparison it just asked for before it waits.

Residency policy: LRU with an explicit memory budget, a `pin` flag for an engine an in-flight
comparison depends on, and refusal — not silent eviction — when a request would exceed the budget. The
refusal names what is resident and what it would cost.

### 3.3 What is warm

| Held                                                                                            | Cost to rebuild           | Owner                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------- |
| `NeuralAddressClassifier` + per-country overlay classifiers                                     | ~1.0 s (measured, §1.2)   | engine worker                           |
| Resolver backend (`WOFCandidateTableLookup` / `WOFSQLitePlaceLookup`)                           | ~2 ms open, 2.0 GB mapped | engine worker                           |
| `RegionDatabaseProvider`, `BANRegionDatabaseProvider`, `OSMRegionDatabaseProvider`, `POILookup` | ~6 ms                     | engine worker                           |
| `CoarsePlacer`, FST + street-morphology matchers                                                | ~23 ms                    | engine worker                           |
| Board corpus (837 rows) + its `regressionCorpusHash`                                            | ms                        | supervisor, re-verified per read (§3.4) |
| Benchmark panels, golden sets, parity fixtures                                                  | ms                        | supervisor                              |
| Run store (past run results, keyed by `run_id`)                                                 | —                         | supervisor, on disk outside the repo    |

### 3.4 Freshness: four staleness traps, four answers

This repo has scar tissue for three of these. The design adds a fourth of its own, and must answer it.

**(a) A stale compiled `out/`.** The pattern is documented twice. `corpus-stamp.ts:10-16` records
2026-08-06: `eval gauntlet-build regression-db` ran from a compiled tree whose `out/` loader still held
a deleted case array, wrote a DB, printed "built", exited 0, and every gate afterwards graded a corpus
nobody had. `promotion-gate.ts:250-278` carries the recompile-before-eval lore guard that walks
`packages/core` two levels deep for a `.ts` newer than `packages/core/out`.

_Answer:_ the daemon imports **source**. `packages/mailwoman/package.json`'s exports map puts a `node`
condition on `.ts` for every subpath (`"./eval-harness/*": { "node": "./eval-harness/*.ts", … }`), so
`out/` is not on the daemon's own path at all. The one place it re-enters is `mwdev_cli`, which shells
`out/cli.js`; that tool runs the same mtime walk and **refuses** with the `yarn compile` remedy rather
than running stale code.

**(b) A stale derived artifact.** `regression.db` is built from the committed JSONL and carries a
`gauntlet_meta` stamp — `corpus_hash`, `case_count`, `built_at` (`schema.ts:152-171`) — and every
runner refuses when the stamp disagrees with the corpus on disk _right now_
(`corpus-stamp.ts:assertCorpusStampFresh`). There is a separate emptiness guard, because a hash
comparison cannot catch a loader that resolved zero rows: "an empty loader on BOTH sides agrees with
itself."

_Answer:_ the daemon caches the corpus but re-runs `regressionCorpusHash` on every read. It never
caches a stamp verdict.

**(c) A drifted or under-fed model artifact.** Two existing guards, both in
`gauntlet/harness.ts`: `assertShippedModelMatchesCard` (#1024, `:137`) refuses when the materialized
`model.onnx` md5 disagrees with the model-card's `files_md5`, because a config/card drift once shipped
a superseded model past a silent gate. `assertDeclaredAnchorBins` (#1516, `:184`) refuses when a
weights package is missing the anchor artifact **its own card declares**, because that failure has no
signal of its own — the channel resolves OFF, the run scores three or four cases lower, and the
operator reads a model regression.

_Answer:_ every engine runs both guards at construction and records their output in the engine's
provenance block. Every result carries `model_md5`, `card_version`, and the fed-channel list. A run
whose engine warned about an unfed channel says so in the result, not only in a log the agent never
reads.

**(d) A source edit invisible to a long-lived process — new, created by this design.** An agent edits
`geocode-core.ts`, calls `mwdev_run`, and gets the old code with no signal whatsoever. This is the
`out/` trap wearing different clothes, and the daemon manufactures it.

_Answer:_ the supervisor computes a **tree fingerprint** — the max mtime over the workspace directories
any resident engine has imported, plus the git `HEAD` and dirty-file set — and stamps it into
`EngineKey`. On every tool call it re-computes the fingerprint; a change makes the existing engine
**unreachable rather than wrong**. Two behaviours, and the choice matters:

- For a _single_ run, the daemon transparently respawns the worker and proceeds. The result carries
  the new fingerprint.
- For a _comparison_, it **refuses**. Two arms that ran under different trees are not a comparison,
  and silently reloading between arms would produce exactly the sort of result this whole surface
  exists to prevent. The refusal names both fingerprints.

Every result carries its `tree_fingerprint`, and `mwdev_compare` refuses arms that disagree on it
unless the fingerprint is itself the declared variable (§6).

### 3.5 Lifecycle

- **Start.** `mwdevd` is started on demand by the MCP shim, or explicitly. It binds a Unix domain
  socket under `$XDG_RUNTIME_DIR` (falling back to the data root), one socket per `(dataRoot, repo
path)` pair so two checkouts do not share a daemon. It holds **no** engine at startup; the first
  tool call that needs one builds it. This mirrors `packages/mcp/lib/cli.ts:14-17`'s laziness contract, and
  for the same reason: an agent may connect, list tools, and never call one.
- **Idle.** Engines are evicted after a configurable idle interval; the daemon exits after a longer one
  with no clients. Both intervals are reported by `mwdev_daemon`.
- **Reload.** `mwdev_daemon({action:"reload"})` respawns every worker. Automatic on a tree-fingerprint
  change (§3.4d).
- **Stop.** SIGINT/SIGTERM close every session through `GeocodeSession.close()`
  (`geocode-session.ts:411`) before exit. Note that `packages/mcp` has no shutdown handler at all; that
  gap is not inherited, because this daemon may hold write-free but exclusive SQLite handles for hours.
- **Crash.** A worker crash is reported as a tool error naming the engine id and the last input; the
  supervisor does not silently restart mid-comparison.

### 3.6 Transport

MCP stdio between the agent and `mwdev-mcp`, matching `packages/mcp` (`server.ts:11,32,35`, SDK
`@modelcontextprotocol/sdk ^1.30.0`). Between the shim and the daemon, JSON-RPC over a Unix domain
socket — no TCP, no HTTP, no network listener (§7).

Two departures from `packages/mcp`'s tool envelope, both earned:

1. **Declare `outputSchema` and return `structuredContent`.** `packages/mcp/lib/server.ts:42` stringifies
   every result into one text block. That is fine for a parse tree; it is wrong for a comparison
   result, whose denominators and verdict fields must be machine-readable so a wrapper can enforce
   §5's rules rather than trusting the agent to read prose.
2. **Support progress notifications and a `job_id` handshake.** A gauntlet run is minutes, not
   milliseconds. Tools that can exceed a few seconds return a `job_id` immediately and are polled
   through `mwdev_job` (§4).

Input key casing is **snake_case throughout**. `packages/mcp/lib/tools.ts` mixes camelCase and snake_case
across its nine tools and hand-maps between them (`tools.ts:337-339`); one convention, chosen once.

---

## 4. Tool surface

Prefix `mwdev_`, server name `mailwoman-dev`, bin `mwdev-mcp`. Eleven tools.

| Tool             | Purpose                                                              | Replaces                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `mwdev_daemon`   | status / reload / evict / stop                                       | `autoload-check.ts`, `mailwoman doctor`                                                                                                       |
| `mwdev_inputs`   | list and describe input sets; report coverage and denominators       | the implicit "which cases shall I use?" step                                                                                                  |
| `mwdev_run`      | parse or geocode one input set under one configuration               | `acceptance-probe.ts`, most one-off parse scripts                                                                                             |
| `mwdev_compare`  | two arms over one input set, diffed and graded                       | `fst-probe.ts`, `fst-board-probe.ts`, `hierarchy-benefit.ts`, `affix-diff.ts`, `backend-parity.ts`, all Pelias/Photon/Nominatim head-to-heads |
| `mwdev_trace`    | per-stage evidence for a handful of inputs                           | `pgn-probe.ts`                                                                                                                                |
| `mwdev_gauntlet` | run gauntlet layers, whole or single, with model and lever pins      | `mailwoman eval gauntlet` spawns                                                                                                              |
| `mwdev_gate`     | run the promotion gate against a spec                                | `mailwoman eval gate` spawns                                                                                                                  |
| `mwdev_lookup`   | direct data-source probes (FST, candidate table, normalizer, poi.db) | `icu-probe.mjs`, `keynorm-probe.ts`, `probe-fst-bias.run.ts`                                                                                  |
| `mwdev_bench`    | latency and throughput, cold and warm distinguished                  | `bench-reverse-throughput.ts`                                                                                                                 |
| `mwdev_cli`      | allowlisted read-only CLI passthrough                                | ad-hoc `Bash` invocations of the CLI                                                                                                          |
| `mwdev_job`      | poll, stream logs from, and cancel long-running jobs                 | backgrounded shell jobs                                                                                                                       |

### 4.1 `mwdev_daemon`

```
in:  { action: "status" | "reload" | "evict" | "stop", engine_id?: string }
out: { pid, uptime_s, socket, tree_fingerprint, git_head, dirty_files: string[],
       engines: [{ engine_id, config_summary, resident_mb, last_used, pinned, build_ms }],
       memory: { budget_mb, used_mb },
       artifacts: { candidate_db: {path, size, mtime} | null, wof_shards: […],
                    weights: [{locale, package_dir, model_md5, card_version, declared_artifacts_present: bool}],
                    board: { rows, corpus_hash, stamp_matches: bool },
                    poi_db, ban_shards, osm_shards, panels: […] },
       warnings: string[] }
```

`artifacts` is the honest inventory. Absent is reported as `null` with a reason, never as zero or an
empty object — the rule `packages/mailwoman/lib/eval-harness/gauntlet/ablation-report.ts:8-13` already
enforces for the ablation map. `mailwoman doctor`'s existing check functions (`packages/mailwoman/lib/doctor/checks.ts`)
supply most of this; reuse them rather than re-deriving.

### 4.2 `mwdev_inputs`

The tool that makes sample selection explicit and visible.

```
in:  { action: "list" } | { action: "describe", set: InputSetRef }
out (describe): { set_id, n, sha256, source, strata: { by_country: {…}, by_address_kind: {…},
                  by_truth_type: {…}, by_status: {…} },
                  has_truth: { coordinates: n, components: n, tier: n, none: n },
                  not_covered: string[], notes: string[] }
```

`InputSetRef` is a discriminated union:

- `{ kind: "board" }` — all 837 rows. **The default everywhere.**
- `{ kind: "board", country: "gb" }` / `{ kind: "board", address_kind: "us_po_box" }` /
  `{ kind: "board", status: "pass" }` — a declared slice, reported with its own denominator and with
  what the slice excluded.
- `{ kind: "panel", version: "v2" | "v3" }` — the benchmark panel (420 / 424 rows), which carries
  `truth_type` and so supports stratified reporting.
- `{ kind: "golden", version: "v0.1.3", split: "dev" }`
- `{ kind: "parity" }` — the 321-row triaged parse-parity fixtures.
- `{ kind: "holdout", source: "fr" | "us", n: 300, seed: … }` — a fresh draw, the only set the model
  cannot have memorized (`gauntlet/holdout.ts`).
- `{ kind: "literal", inputs: string[], why: string }` — hand-picked. `why` is **required**; it is
  echoed into every result derived from the set, and it triggers §5's aggregate refusal.

`describe` is cheap and idempotent, so an agent can be told to call it first. `not_covered` is the
field that answers "what would this panel have been blind to?" before the run rather than after.

### 4.3 `mwdev_run`

```
in:  { inputs: InputSetRef, config: EngineConfig, mode: "parse" | "geocode",
       trace?: boolean, limit?: number }
out: { run_id, provenance: Provenance, n_requested, n_evaluated, n_errored, errors: […],
       rows: [{ id, input, components, lat, lon, tier, hierarchy, timing, trace? }],
       elapsed_ms, engine_build_ms }
```

`EngineConfig` is a single flat record covering every construction- and call-time lever, derived from
`GeocodeCommandOptions` (`packages/mailwoman/lib/geocode-command-options.ts:9-35`) and
`GauntletGeocodeOpts` so the vocabulary is the CLI's: `locale`, `country_scope`, `default_country`,
`candidate_db`, `resolve_db`, `weights_cache`, `model_path`, `gazetteer_prior`, `place_country`,
`postcode_country_coherence`, `fork_entity`, `bias`, and so on. **Unset means the production default**,
following `GauntletResolverLevers`'s rule (`harness.ts:69`): "`undefined` means 'production default',
not 'off': the library defaults are the thing under test."

`Provenance` is on every result of every tool:

```ts
interface Provenance {
	engine_id: string
	tree_fingerprint: string
	git_head: string
	dirty: boolean
	model: { path: string; md5: string; card_version: string; locale: string; overlays_loaded: string[] }
	gazetteer: { backend: "candidate" | "fts"; path: string; size: number; mtime: string }
	channels_fed: string[]
	channels_unfed: string[] // from unfedChannelWarner
	config_effective: Record<string, unknown> // every lever, defaults resolved
	input_set: { set_id: string; n: number; sha256: string; selection: "full" | "slice" | "hand-picked" }
	warnings: string[]
}
```

`config_effective` matters more than it looks. Two arms whose _stated_ configs differ in one field can
differ in three effective ones — `--country-scope auto` means "scope on FTS, no scope on candidate"
(`docs/engineering/reference/resolver-backends.mdx:34-46`), so switching backend also switches country
scope. Resolving defaults before recording is what makes §6's confound check possible.

`limit` exists, is never the default, and is reported in `n_requested` versus the set's real `n`.

### 4.4 `mwdev_compare`

The centre of the design. Specified in §6.

### 4.5 `mwdev_trace`

```
in:  { inputs: string[] (max 20), config: EngineConfig, stages?: string[] }
out: { provenance, rows: [{ input, normalized, query_shape, locale_hint, kind, phrase_proposals,
        parse_trace: NeuralParseTrace, tree, per_stage_nodes: […], timing }] }
```

Deliberately small-n and deliberately **not** a measurement tool. It answers "which stage introduced
this node?" (`pgn-probe.ts`) and emits **no rates and no verdict at all** — only per-row evidence. It
is the sanctioned way to look at a handful of cases, which removes the temptation to get the same
answer out of `mwdev_run` with a hand-picked set and then aggregate it.

It is built on `GeocodeSession`'s existing trace path (`geocode-session.ts:124-166,496-514`) plus
`runPipeline`'s `PipelineResult`, which carries `queryShape`, `locale`, `kind`, `phraseProposals`,
`faults`, `intentMarkers` and `path`.

### 4.6 `mwdev_gauntlet`

```
in:  { layer?: "regression" | "metamorphic" | "holdout" | "ablation" | "all",
       candidate?: string, weights_cache?: string, tokenizer?: string, card?: string,
       levers?: { postcode_country_coherence?: boolean },
       source?: "fr" | "us", n?: number, components?: string[] }
out: { job_id }  →  { verdict, layers: [{name, pass, …}], levers_described, corpus_stamp, provenance, log }
```

A direct passthrough to `runGauntlet` (`gauntlet/run.ts:186`) in a job worker. It adds nothing to the
grading and **must not**: the gauntlet is the release authority, and a second implementation of it
would be a second answer key.

Two properties it must surface rather than bury in the log:

- `describeResolverLevers`'s line, which prints on every run, pinned or not, because "two gate logs
  that differ only in a flag someone typed are not evidence about that flag unless each log says which
  configuration it graded" (`run.ts:220-222`).
- The **firing count** — how many rows the pinned mechanism actually spoke on
  (`GauntletResult.postcode_country_scope`, `harness.ts:441-445`). §6 generalizes this.

### 4.7 `mwdev_gate`

```
in:  { gate: string, weights_cache: string, int8_weights_cache?: string, model?: string,
       int8?: string, tokenizer?: string, card?: string, out_dir?: string }
out: { job_id } → { exit_code, verdict_json, floors: [{metric, floor, observed, margin, pass}],
                    provenance_txt, gate_spec_path }
```

Passthrough to `runPromotionGate`. Runs its own lore guards, which will refuse a stale `packages/core/out`
even though the daemon itself runs source — that refusal is correct and should be surfaced verbatim
rather than worked around.

`mwdev_gate` **never writes the eval ledger.** `mailwoman eval ledger-append` is state change (§7).
The tool prints the pre-filled command the gate already emits on PASS, and the operator runs it.

### 4.8 `mwdev_lookup`

```
in:  { source: "fst" | "street_morphology" | "candidate" | "wof" | "normalize" | "poi" | "codex" | "postcode",
       queries: string[], locale?: string, options?: {…} }
out: { provenance, rows: [{ query, hit: boolean, entries: […] | null, note?: string }] }
```

`hit: false` with `entries: null` is **absence**; a hit with a zero score is a **zero**. Keeping those
apart is the whole point, and `probe-fst-bias.run.ts:19-21` already documents it for the FST case.
Reuse that module's collapse rather than re-deriving what `applyBias` actually reads.

### 4.9 `mwdev_bench`

```
in:  { operation: "parse" | "geocode" | "reverse" | "resolve", inputs: InputSetRef,
       config: EngineConfig, repetitions?: number, include_cold?: boolean }
out: { provenance, cold: {…} | null, warm: { n, p50_ms, p90_ms, p99_ms, max_ms, throughput_per_s },
       concurrency: 1, note: "single-threaded; session.run() blocks the calling thread" }
```

Reports cold and warm **separately and always**, because a warm daemon makes it very easy to publish a
throughput number that no user will ever see. `cold: null` when `include_cold` was false — absence,
not zero. Percentiles come from `@mailwoman/core/utils`'s `percentile`, which takes `p` in **[0, 100]**
(AGENTS.md flags the unit specifically, because local copies elsewhere took a fraction).

### 4.10 `mwdev_cli`

```
in:  { args: string[], timeout_s?: number }
out: { exit_code, stdout, stdout_json?, stderr, command, compiled_tree_checked_at }
```

Passthrough to `node packages/mailwoman/out/cli.js`, with three guards:

1. **Subcommand allowlist.** Read-only verbs only: `parse`, `geocode`, `reverse`, `doctor`,
   `eval …`, `gazetteer stats`, `poi …`, `--help`. Everything else refuses with a message naming the
   boundary. Explicitly denied: `data pull`, `gazetteer build`, `gazetteer inspect sync`,
   `coverage build`, `tiles publish`, `release …`, `corpus …` writes, `eval ledger-append`. Two of those
   are nested under a verb that is read-only elsewhere — `eval ledger-append` writes the score ledger, and
   `gazetteer inspect sync` clones country repositories into the shared data root while its `inspect`
   siblings (`tree`, `graph`, `mermaid`) only read.
2. **Stale-tree refusal** (§3.4a).
3. **No shell.** `args` is an array passed to `spawn` without a shell, so nothing composes a pipeline
   through this tool.

This tool exists because the CLI's surface is larger than the daemon's and will stay that way. It is a
deliberate override, not the main road — every call pays the full cold start measured in §1.2, and
the result says so.

### 4.11 `mwdev_job`

```
in:  { action: "list" | "status" | "logs" | "cancel", job_id?: string, tail?: number }
out: { jobs: [{ job_id, tool, state, started_at, elapsed_s, progress?, result? }] }
```

Long-running tools return a `job_id` immediately. Progress is also pushed as MCP progress
notifications where the client supports them, but polling must work regardless.

---

## 5. Making measurement honest by construction

This is the section the rest of the design serves. Each rule is mechanical, checkable, and tied to a
discipline the repo already has rather than a new vocabulary.

### 5.1 The full corpus is the default; a panel costs more to type

Every measuring tool takes `inputs: InputSetRef`, and `{ kind: "board" }` is the shortest legal value.
A hand-picked set requires `{ kind: "literal", inputs: [...], why: "..." }` — an array **and** a
justification string. The cheap thing to type is the well-powered thing.

### 5.2 A small sample always gets its aggregate, with the bound welded to it

**Decided 2026-08-16: always report, never refuse.** An earlier draft withheld the aggregate below
`n = 30`. Two things argued it down. The threshold was a convention rather than a measurement —
`parity-corpus.ts` uses 8 for bucket stability — and, more importantly, a refusal an agent cannot
override is a reason to go write a probe script, which is the exact behaviour this whole surface exists
to remove. A tool that says no is a tool that gets bypassed, and a bypassed tool measures nothing.

So the rule is placement, not refusal. The bound goes **inside the summary string**, in the same
sentence as the count, because §5.8 already establishes that the summary is what an agent relays:

```json
{
	"verdict": "no-difference-observed",
	"summary": "0 of 10 hand-picked inputs differed — consistent with any true rate below 25.9%, so this cannot support a claim of no effect. The board is 837 inputs.",
	"power": { "observed_differences": 0, "n": 10, "upper_bound_95": 0.259, "selection": "hand-picked" }
}
```

A number in a `power` field is a number that can be dropped on the way to the operator. A clause in the
sentence being quoted cannot be, without the quoter noticing they are editing it.

This is the exact repair for the `fst-probe.ts` failure. What happened there was not that an agent
ignored a bound — **there was no bound to ignore.** It wrote "zero effect" from 10 rows; the true rate
was 2.9%. The sentence above makes writing that conclusion require deleting the clause that
contradicts it.

The bound is the exact one-sided Clopper–Pearson upper limit for zero events, `1 − α^(1/n)`; for
non-zero counts, the Wilson interval, which is what the gate specs already cut their floors from
(`gates/v9.0.0-base.json`'s `$margin_rationale`: "2 × the downward Wilson 95% half-width at the
metric's own support").

`parity-corpus.ts` already encodes the same instinct with `MIN_BUCKET_EXAMPLES = 8` before a bucket's
rate is considered stable. This generalizes it and makes it a refusal rather than a convention.

### 5.3 Every result carries its denominator and its absences

Mandatory on every measuring result: `n_requested`, `n_evaluated`, `n_errored` (with the errors),
`n_skipped` (with reasons), and `not_covered` — the strata present in the corpus but absent from this
set, and the strata present in the set but with support below the reporting threshold.

**A cell nobody measured never renders as zero.** This is the repo's existing meaning-of-zero rule, and
`ablation-report.ts` is the worked example: `ABLATION_ABSENT` covers three distinct absences — no cell,
zero support, and real support that no ladder could grade (`:8-13`) — and the renderer takes
`AblationCell | undefined` rather than a number precisely so a zero cannot be manufactured (`:22-31`).
The same sentinel and the same discipline apply here.

### 5.4 Report what the mechanism actually did, not only whether the verdict moved

Every comparison reports `arms_differed_on: n / N` alongside improved/regressed/neutral. `run.ts:32`
states the reason: _"an unchanged verdict from a mechanism that never ran proves nothing."_
`GauntletResult.postcode_country_scope` exists solely as a firing count for exactly this
(`harness.ts:441-445`).

Where the mechanism under test has its own firing signal — a lever that records what it overrode, a
prior that records whether it participated — the comparison surfaces it as `mechanism_fired_on: n / N`
separately from `arms_differed_on`. A lever that fired on 400 rows and changed 0 outcomes is a
different fact from a lever that never fired, and both differ from a lever with no firing signal at
all, which reports `mechanism_fired_on: null`.

### 5.5 A diff is not a verdict

`mwdev_compare` distinguishes three grading modes and never silently picks the flattering one:

- **`grade: "truth"`** — the input set carries truth (board coordinates and tiers, panel truth points,
  golden components). Report improved / regressed / neutral against truth, plus the significance test.
- **`grade: "diff-only"`** — no truth available. Report `changed / N` and set
  `verdict: null, verdict_withheld_reason: "no truth for this input set; changes are described, not graded"`.
- **`grade: "auto"`** — pick `truth` where the set has it, `diff-only` otherwise, and say which was
  chosen per row.

The `fst-probe.ts` conclusion was a `diff-only` result read as a `truth` result. The board version
happened to have truth, which is why "24 changed" could become "22 are clear improvements."

### 5.6 State the test, and state the minimum detectable effect

Comparisons report a two-proportion z-test on the paired rows — the same instrument the held-out layer
already gates on (`holdout.ts`, `Z_CRITICAL_95_TWO_SIDED = -1.96`) — plus, always, the **minimum
detectable effect at this n**. When the observed delta sits inside noise the verdict is
`"indistinguishable"`, never `"no effect"`, and the MDE says how large an effect this run could have
missed.

For a head-to-head parity claim against another geocoder, the bound is the pre-registered TOST
equivalence bound of **±5 pp @ 25 km** (§2.4), not an eyeball on two percentages.

### 5.7 Grade at a named tier, on a stratum, and never on an incomparable field

Three refusals, all drawn from `docs/engineering/reference/resolver-backends.mdx`:

- **Named tier.** Refuse "the deepest coordinated node" as a grading target. The candidate table
  carries 3.66 M postcodes the FTS admin shard has none of, so "deepest" silently means _postcode_ on
  one arm and _locality_ on the other; grading that way once reported a 54-row sub-kilometre collapse
  that was a commune centroid compared against a postcode-area centroid (`:111-127`).
- **Stratum.** Panel results are reported per `truth_type`, never blended — the benchmark plan's own
  words are "@1km lives or dies on `truth_type`."
- **Incomparable fields.** `node.metadata.resolver_score` is bm25-derived on FTS (≈19–41) and
  population-derived on candidate (≈5–7); the tool refuses to compare it across backends, and refuses
  to threshold on it at all, because within either backend the wrong answers' range sits inside the
  correct answers' range with a _higher_ mean (`:162-170`).

### 5.8 The result text says the thing the agent will relay

Tool output carries a one-paragraph `summary` field written to be quoted verbatim, and it always
contains the denominator and the selection kind. An agent that relays `summary` cannot accidentally
relay "zero effect" when the underlying object says "0 of 10, hand-picked, aggregate withheld."

---

## 6. Comparison as one operation

Two models, two gazetteers, two flag settings, two backends, mailwoman-versus-Photon,
mailwoman-versus-Pelias, today-versus-last-week — all the same shape: **run one input set through two
configurations and diff the graded results.** One tool.

### 6.1 Shape

```ts
mwdev_compare({
  inputs: InputSetRef,
  arms: { a: ArmSpec; b: ArmSpec },
  mode: "parse" | "geocode",
  variable: string[],                       // REQUIRED — what differs between the arms
  grade?: "auto" | "truth" | "diff-only",   // default "auto"
  tier?: "address_point" | "interpolated" | "street" | "admin" | "venue",
  thresholds_km?: number[],                 // default [1, 5, 25]
  stratify_by?: "truth_type" | "country" | "address_kind" | "status",
})
```

```ts
type ArmSpec =
	| { kind: "mailwoman"; config: EngineConfig }
	| { kind: "external"; engine: "pelias" | "photon" | "nominatim"; endpoint: string; version?: string }
	| { kind: "oracle"; provider: "census" | "google" } // gated, §7.3
	| { kind: "recorded"; run_id: string } // a stored past run
```

### 6.2 Output

```
{ provenance_a, provenance_b,
  n_requested, n_evaluated_both, n_errored_a, n_errored_b, n_no_result_a, n_no_result_b,
  arms_differed_on: { n, of },
  mechanism_fired_on: { n, of } | null,
  graded: { improved, regressed, neutral, ungradeable },
  thresholds: { "1km": { a, b, delta, of }, "5km": {…}, "25km": {…} },
  strata: { "<stratum>": { … same shape … } },
  significance: { test: "two-proportion z", z, p, verdict: "a_better"|"b_better"|"indistinguishable",
                  mde_pp_at_this_n },
  rows_changed: [ … every differing row, with both arms' output and the grade … ],
  summary: "…",
  warnings: [ … ] }
```

`rows_changed` is complete, not truncated to the first thirty. The 837-row FST run produced 24 changed
rows; that is a readable list and it is the actual evidence.

### 6.3 The confound guard

`compare` canonicalizes both arms into `config_effective` (defaults resolved, §4.3), computes the
symmetric difference of the two records, and checks it against what `variable` declares.

**Decided 2026-08-16: an undeclared difference warns, it does not refuse.** The warning names the
offending keys, sets `attribution: "ambiguous"`, and lists every moved key in `variable_effective` — so
the result still reports which arm won, and reports that the delta cannot be assigned to the variable
the caller thought they were testing. Same reasoning as §5.2: this was the strongest honesty mechanism
in the design and also the one most likely to block a legitimate quick look, and a blocked quick look
becomes a shell command with no guard on it at all. A warning that travels in `summary` survives the
relay; a refusal only survives if the agent stays inside the tool.

This mechanizes an already-documented hazard rather than inventing a rule.
`docs/engineering/reference/resolver-backends.mdx:63-64` states it outright: _"Any comparison between
backends must pin `--country-scope` to `locale` or `none` across both arms, or run the full 2×2."_
Under the default `--country-scope auto`, switching backend **also** switches country scoping, and the
document's own table shows `12 Rue de Rivoli, 75001 Paris` landing in Texas or France depending on
which of the two variables you actually moved. Declaring `variable: ["backend"]` while
`country_scope` also differs is precisely what the guard catches.

`tree_fingerprint` participates in the same check (§3.4d), so an arm captured before an edit and an
arm captured after cannot be silently compared.

Declaring the confound explicitly — `variable: ["backend", "country_scope"]` — is the same run without
the warning, because the caller has said the thing the warning would have told them. That is the honest
description of a 1×2 slice of a 2×2.

### 6.4 External arms

`{ kind: "external" }` speaks the pre-registered protocol from §2.4 and nothing else: top-1 only,
haversine R = 6371 km, thresholds 1/5/25 km, a no-result counted as a miss at every threshold, the
same raw query string to every arm with no per-arm normalization.

Endpoints are **explicit and local by default** — Pelias `http://127.0.0.1:4000`, upstream Photon
`http://127.0.0.1:2323`, Nominatim per the rig. The server ships no default pointing at a public
instance, and refuses `photon.komoot.io` and `nominatim.openstreetmap.org` outright: the benchmark plan
classifies them as unpinned sanity checks that are **never a scored arm**, and a tool that makes it
easy to score them will eventually score them.

Every external arm result records the arm's reported version and data vintage where the API exposes it
(`system_scope`, `source_vintage`, `interpolation_enabled`, `result_type`, `response_version` — the
columns the plan's §7 already specifies), and reports `null` where it does not.

This is where the daemon pays for itself twice over: the existing scorer spawns the compiled CLI once
per row (§1.2), so a 420-row three-arm comparison spends around 10 minutes per mailwoman arm on
process startup alone.

### 6.5 `{ kind: "recorded" }`

Every `mwdev_run` and `mwdev_compare` result is written to a run store outside the repo, keyed by
`run_id`, with its full provenance. An arm may be a stored run, which makes "did this change anything
since Tuesday?" a comparison rather than an archaeology exercise — and makes the _old_ arm
reproducible even after the tree moved, because the stored provenance says exactly what produced it.

The confound guard applies unchanged: a recorded arm's `tree_fingerprint` will differ, so the caller
must declare it as a variable. That is correct — comparing across a tree change _is_ comparing across
a tree change.

---

## 7. Safety and scope

### 7.1 The boundary

**The server gathers evidence. It does not change state that anything else reads.**

Concretely, refuse:

- **Any write to a sealed database.** Every built SQLite artifact is chmod 0444 via `sealDatabase`
  (`@mailwoman/core/utils`), and `openBuiltDatabase` enforces read-only with a named error. All handles
  the daemon opens are `readOnly: true`, matching `packages/mcp/lib/cli.ts`'s posture.
- **Artifact builds.** `gazetteer build`, `coverage build`, `tiles publish`, `corpus` ingest,
  `data pull` (multi-gigabyte downloads). These are hours and disk, and they are the operator's call.
- **Promotion and release.** `release …`, `bless-package`, `npm publish`, Hugging Face staging,
  `release.config.json` / `model-card.json` / `.release-it.json` edits, and
  `eval ledger-append` — which writes `evals/scores-by-version.json`, the score ledger.
- **Anything costing money or GPU time.** No `modal run`, no training launch, no cloud job. Google
  Geocoding calls are billed; see §7.3.
- **Git mutation.** Reads (`status`, `log`, `diff`, `rev-parse`) are fine and feed the tree
  fingerprint. No commit, no branch, no push, no checkout — the repo is a shared working tree and a
  daemon must never move it under an operator.
- **Writes anywhere inside the repository**, with no exception. Run artifacts, logs and the run store
  live under `$MAILWOMAN_DATA_ROOT/dev-mcp/` or a scratch directory. The daemon has no reason to touch
  `packages/`, and a bug that made it try should fail rather than succeed.
- **Network listeners.** Unix domain socket only. No TCP bind, no HTTP server, no remote clients.
- **Outbound network by default.** Only explicitly configured local endpoints (§6.4) and, when
  enabled, the metered oracles.

### 7.2 The public repository

`sister-software/mailwoman` is **public** (verified 2026-08-15; `AGENTS.md`'s note that provenance
attestation waits on the repo becoming public is stale). Everything committed is world-readable, which
constrains this package specifically because it is a _lab_ tool:

- **No literal lab paths anywhere in committed code, docstrings, defaults or fixtures.** Use
  `dataRootPath` / `mailwomanDataRoot` (`packages/core/lib/utils/data-root.ts`) and write
  `$MAILWOMAN_DATA_ROOT` in prose, per AGENTS.md. The benchmark panels and the Pelias rig's scorer live
  outside the repo today; the tool references them by data-root-relative path and never by absolute
  path.
- **No credentials, and no credential-shaped defaults.** `GOOGLE_MAPS_API_KEY` is read through
  `$private` (`packages/core/lib/env/schema.ts:211`) and is never echoed into a result, a cache key, a log
  or a URL — the oracle client already takes care of the last one by injecting it as an Axios
  instance-level default.
- **Result payloads are model-visible.** Anything the daemon puts in a tool result may end up in a
  transcript. Absolute paths under the data root, internal issue numbers and unpublished eval numbers
  are fine in a _result_ (the operator's own session) but must not be baked into _committed_ defaults,
  fixtures or docstrings.
- **No vendor names or attributions in committed artifacts**, per standing project policy — the
  external-arm engine identifiers are unavoidable and factual; marketing comparisons are not.

### 7.3 Oracles are metered and off by default

`{ kind: "oracle", provider: "census" }` is free and allowed. `provider: "google"` is **billed** and:

- requires an explicit opt-in in the daemon's config file, not a tool argument;
- carries a per-daemon-lifetime call cap that the tool reports as it consumes;
- inherits the existing disk cache under `$MAILWOMAN_DATA_ROOT/geocode-oracle/google` (30-day TTL) and
  60 req/min pacing, so a repeated panel costs nothing;
- is **never** a scored arm and never a grading truth. `packages/geocode-oracle/lib/index.ts`'s own header
  is explicit: _"Not truth, and not a gate … Nothing here should ever decide whether a build ships."_
  A comparison with an oracle arm always reports `grade: "diff-only"` and `verdict: null`, and its
  purpose is flagging rows for a human to read.

### 7.4 Workspace accounting

**Decided 2026-08-16: in-repo.** The standing policy routes code outside the monorepo to the `mailwoman`
GitHub org, and this is the exception the policy's own rationale makes: it imports `mailwoman/eval-harness/*`
and `geocode-session`, neither of which is a published export, so living outside means a path dependency on
a sibling checkout — a second thing to keep in sync for no benefit. A private in-repo workspace is also the
only shape where the eval harness moving underneath it is a compile error rather than a silent drift.

The package is `packages/dev-mcp/`, `private: true`, and absent from `.release-it.json`. That makes it
the **56th** entry in the root `workspaces` array and the **seventh** name printed by AGENTS.md's
arithmetic check:

```bash
node -e "const w=require('./package.json').workspaces,r=require('./.release-it.json').plugins['@release-it-plugins/workspaces'].workspaces;console.log(w.filter(x=>!r.includes(x)))"
```

AGENTS.md requires every printed name to have a reason someone can state. This one's reason is: _a
maintainer-only development tool that imports the eval harness and is never installed by a user._ That
sentence belongs in `AGENTS.md` in the same commit that adds the workspace, or the count silently stops
meaning anything — which is exactly the failure mode `neural-weights-en-au` demonstrates.

It must also **not** be added to `MCP_EXPECTED_TOOLS` in `scripts/smoke-clean-install.ts:156-166`, which
pins the _published_ server's tool list.

---

## 8. Non-goals

- **Not a replacement for `@mailwoman/mcp`.** That is the user-facing, published, supported surface.
  This one is maintainer-only, unpublished, and free to break.
- **Not a new grader.** It calls `runGauntlet`, `runPromotionGate`, `checkCase`, `runParityEval` and
  the resolver-eval harness. It never re-implements a metric, and it cannot invent or relax a floor.
  The gate stays the release authority.
- **Not a general code-execution tool.** A `run_typescript` tool would subsume every probe in §1.1 in
  one afternoon and would re-open the exact hole this surface exists to close: it would let an agent
  choose its own panel, its own denominator and its own grading, invisibly. If an experiment genuinely
  needs code, it should become a `dev-tools/*.run.ts` module with a docstring, reachable through
  `mwdev_cli` — which is a higher bar on purpose.
- **Not a training, orchestration or Modal surface.** No job launch, no checkpoint management, no
  weight staging.
- **Not an eval ledger or a results database.** The run store is a cache with a retention policy, not a
  record. `evals/scores-by-version.json` and `docs/records/evals/` remain the record, written by
  humans and by `eval ledger-append`.
- **Not multi-user, not networked, not authenticated.** One operator, one box, one Unix socket.
- **Not a demo, a benchmark publication tool, or anything that emits a shippable number.** It produces
  evidence for a human to read and decide on.

---

## 9. Open questions

These need a decision from the operator; each is a real fork, not a detail.

1. **Does the daemon get to rebuild `regression.db`?** Adding a board case is a common agent task, and
   the case is inert until `eval gauntlet-build regression-db` runs. That build is a derived artifact
   the gate reads, which puts it on the wrong side of §7.1's boundary — but refusing it makes
   case-authoring a two-tool dance with a shell step in the middle. The build already has a stamp and an
   emptiness guard, so the 2026-08-06 failure mode is closed. Allow it as the single sanctioned write,
   or keep the boundary clean?

2. **What is the memory budget, and is a two-gazetteer comparison affordable at all?** `candidate.db`
   is 2.0 GB and the FTS admin shard is 5.0 GB. Two resident engines with different gazetteers is 4–10
   GB before the ONNX sessions. On a 29 GB host that is survivable; alongside a running Pelias with a
   4 GB ES heap and a Photon JVM it may not be. Does `compare` across gazetteers run **sequentially by
   default** (rebuild between arms, slower but small) or **concurrently** (fast, and occasionally the
   thing that OOMs the box mid-benchmark)?

3. ~~**Is the undeclared-confound refusal (§6.3) worth its friction?**~~ **DECIDED 2026-08-16 — warn.**
   A refusal an agent cannot override is a reason to bypass the tool, and a bypassed tool guards
   nothing. The warning names the moved keys and sets `attribution: "ambiguous"`. See §6.3.

4. ~~**Is the small-panel aggregate refusal (§5.2) set at the right threshold?**~~ **DECIDED 2026-08-16 —
   always report, with the bound welded into the summary sentence.** The 2026-08-15 failure was not an
   agent ignoring a bound; there was no bound. Placement in the relayed sentence is the mechanism, not
   withholding. See §5.2.

5. ~~**Where does this workspace live?**~~ **DECIDED 2026-08-16 — in-repo, `packages/dev-mcp/`,
   `private: true`.** It imports non-published internals, so outside means a path dependency on a
   sibling checkout. See §7.4.

6. **Google oracle: allowed at all, and on whose budget? RESOLVED 2026-08-16 — allowed, opt-in, capped,
   and never a grading truth.** §7.3's proposal was taken rather than the exclude-Google alternative: the
   panels are multi-country and a US-only oracle cannot speak to most of them. Three properties make the
   permission safe to hold. The opt-in lives in `$MAILWOMAN_DATA_ROOT/dev-mcp/oracle-config.json` and
   deliberately **not** on a tool argument — a tool argument is set by whoever is driving the agent, which
   for a spend decision is the wrong signature, so an agent cannot talk its way into spending money. The
   cap is checked for the WHOLE run before the first query, so a set the caller cannot afford costs zero
   calls rather than a partial arm that can still be graded as a whole one. And the meter counts queries
   rather than issued requests, so a warm cache over-counts — the direction whose failure is refusing an
   affordable run. See `oracle-arm.ts`.

7. **Who runs the external arms? RESOLVED 2026-08-16 — the operator does; the daemon refuses.** The
   conservative branch, on §7.1's boundary: this surface gathers evidence and changes no state anything
   else reads. The deciding argument is what the two options do to a reader. "The benchmark rig was down"
   is a fact about the box that must reach them; a daemon that starts the rig turns that fact into an arm
   that lost, and one that scores rows against a service it just booted cannot say what vintage answered.
   An endpoint that is not already up is a refusal with the reason. See `external-arm.ts`, which also
   refuses the shared public instances outright.

8. **Retention. RESOLVED 2026-08-16 — 14 days, 200 runs, newest first.** Two rules rather than one,
   because neither bounds the store alone: a stored run only describes the tree that produced it, so after
   a fortnight of commits it documents a system that no longer exists (age); and the age rule by itself
   permits an unbounded number of runs inside the window, which a busy day reaches (count). Two smaller
   decisions fell out of implementing it. An **unparseable `created_at` is treated as OLD** — a run that
   cannot say when it happened cannot be trusted to describe a current tree, and keeping it forever is the
   worse failure. A run whose `tree_fingerprint` no longer matches is **not** pruned: it is still evidence
   about that tree, `{kind:"recorded"}` names both fingerprints and requires `tree_fingerprint` as a
   declared variable, and deleting it silently would cost more than it saves. See `run-store.ts`; the store
   is reported by `mwdev_runs`, which exists because inferring "pruned" from a failed recorded arm is the
   guessing this surface exists to remove.

9. **Does `mwdev_compare` earn the right to write a board case?** The natural end of an investigation is
   "this row now resolves correctly — pin it." That is a repo write, and it is the single highest-value
   thing the surface could do next. It is also the thing most likely to grow the corpus by capture
   rather than by judgment, which `gauntlet/schema.ts:6-11` warns about by name ("the Pelias acceptance-
   test false-trust pass-list").

10. **Should `mwdev_trace` be allowed to accept a `run_id`** so an agent can trace exactly the rows a
    comparison flagged, rather than retyping them? Convenient, and it also makes the small-panel path
    slightly easier to reach — which cuts against §5.1.

---

## 10. The debug evidence is already structured — it is only unreachable

Raised by the operator 2026-08-16: the rich per-stage debug output exists for JSON or for the Ink
`--debug` view, and this surface should carry it too. Reading the code changes the shape of that
problem, and the change is favourable.

### 10.1 What is actually there

`GeocodeTrace` (`packages/mailwoman/lib/geocode-session.ts:124-144`) is already a structured record, not a
rendering:

```ts
export interface GeocodeTrace {
	parse: NeuralParseTrace // pieces, soft-feature channels AS FED, locale head, prior
	// participation, viterbi path, repair diffs, final tokens
	queryShape: QueryShape // Stage-2 structural priors: known formats, segments, character class
	kind?: QueryKindResult // Stage-2.5 verdict — absent when a caller pinned the register
	inputMode: InputMode
	locale: string
}
```

`GeocodeRun.trace` carries it on any session opened with `trace: true`, and degrades to absent when the
loaded bundle's classifier cannot produce one — a property of the bundle, reported rather than faked.

The renderer is already Ink-free, and deliberately so. `debug-view/trace-rows.ts`'s own docstring:

> _Pure and Ink-free so the formatting is unit-testable without a render, and so a caller can truncate
> the result against a pane width without owning any of the vocabulary._

Every function there takes the trace and returns **one string**. It has its own `ABSENT` sentinel so
that "the model has no locale head" and "no channel was fed" cannot read as the same nothing — the
meaning-of-zero rule, already applied. `debug-view/static-render.ts` renders an Ink tree to a plain
string with no TTY and no timers. The `map-tui` pane is frame-first by design (`AGENTS.md`: _"Frame-first:
consumers own presentation"_), and a `MapFrame` is braille text, which is returnable in a tool result
as-is.

So two of the three layers are already renderer-agnostic. This is not an Ink-shaped debug system.

### 10.2 What is actually missing

Reachability, in two places.

**Nothing outside `debug-view/` consumes the trace.** Every importer of `GeocodeTrace` other than the
session that defines it lives in that directory — `command.tsx`, `DebugSessionApp.tsx`, `DebugFrame.tsx`,
`output-lines.ts`, `trace-rows.ts`. No JSON output path carries it, `@mailwoman/api` does not expose it,
and `@mailwoman/mcp` does not either. `mw geocode --json` returns the answer, never the evidence.

**Neither module is exported.** The package's `exports` map has no `./geocode-session` and no
`./debug-view/*`, so `packages/dev-mcp/` could not import either one today:

```
$ node -p "JSON.stringify(Object.keys(require('./packages/mailwoman/package.json').exports))"
["./package.json",".","./dev-tools/*","./eval-harness/*","./geocode-core","./geocode-stream",
 "./resolver-backend","./gazetteer-pipeline",…,"./cli-kit","./test-kit","./poi-overpass"]
```

That is the whole gap: **two subpaths in an exports map.** The precedent is already set by
`./eval-harness/*` and `./dev-tools/*`, which are exported for exactly this class of maintainer-facing
consumer. Follow `AGENTS.md`'s dual-map rule — the committed map is the DEV map only, and
`publishConfig.exports` is injected at pack time, never committed.

### 10.3 What `mwdev_trace` returns

Both forms, from one call, because they answer different questions and neither substitutes for the
other:

```
out: { rows: [{ input,
                trace: GeocodeTrace,        // structured — for an agent to compare across arms
                rendered: string[],         // trace-rows output — for a human to read in the transcript
                map?: string                // MapFrame braille, when a coordinate resolved
                … }] }
```

The structured form is what makes a trace _diffable_ — the thing no rendering can do, and the thing that
would have answered "which stage introduced this node?" without `pgn-probe.ts`. The rendered form is what
makes it _legible_ in a transcript without the agent paraphrasing it, which is where detail gets lost.
Returning only the first recreates the 2026-08-15 failure in a new place: an agent summarising evidence
it alone can see.

### 10.4 The one thing to watch

`trace: true` is not free — it is the decode-path record, kept per run. `mwdev_trace` is capped at 20
inputs (§4.5) and is explicitly not a measurement tool; the measuring tools run their sessions with
tracing **off**. If a future caller wants traces over a board-sized set, that is a different tool with a
different cost, not a larger `n` on this one.

---

## 11. First slice

> **§3.1 update, 2026-08-18.** The supervisor/socket split was resolved by a different cut than the
> one sketched here, driven by measured need: staleness (not warmth) was the binding cost — the
> refusal-on-source-edit locked the tool developer out for most of two working days. The shipped
> shape is a never-stale stdio SHIM (`cli.ts`, imports nothing from the repo runtime) forking a
> restartable WORKER (`worker.ts`, the whole module graph) over IPC, with `mwdev_restart` as a
> shim-owned tool emitting `tools/list_changed` after a swap. Matches the pattern the MCP ecosystem
> converged on (mcp-reloader, reloaderoo, mcp-hmr); `process.execve` was evaluated and rejected —
> it discards the initialized MCP session with the module graph. Warmth across restarts remains
> deliberately unbuilt: engines are lazy and rebuild on first use, which the restart report states.

> **Status, 2026-08-16.** This section is the plan of record and is kept as written. The slice shipped
> (#1698), and the prediction it tests held, so the deferrals below were taken in order rather than
> abandoned: every tool named here as waiting now exists, plus `mwdev_runs`. All four `ArmSpec` members
> are built. Of the §9 questions this section listed as downstream, oracle billing (§9.6), who starts
> Pelias (§9.7) and retention (§9.8) are resolved above; board-case writes (§9.9) and `run_id` tracing
> (§9.10) are still open. Read what follows for why the order was chosen, not for what is built.

The spec describes eleven tools, three process roles, an engine registry, a run store and external-arm
orchestration. That is a platform, and a platform specified in one pass is a platform that does not get
built. The evidence in §1.1 supports a much smaller thing, and the smaller thing tests the claim
everything else rests on.

**The claim under test:** a warm daemon changes which experiments get run — not merely how fast they
run. That is a behavioural prediction about the agent, and it is falsifiable in an afternoon.

Build exactly this:

| Tool                      | Why it is in the first slice                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `mwdev_daemon` (§4.1)     | Nothing else works without a lifecycle and the tree fingerprint (§3.4).                                                                  |
| `mwdev_run` (§4.3)        | The warm engine over `{kind:"board"}` by default. This is the whole §5.1 mechanism: the full corpus is the shortest legal thing to type. |
| `mwdev_trace` (§4.5, §10) | Two exports and a pass-through. Cheapest high-value tool in the spec, and it retires four of the nine probe scripts on its own.          |

Everything else waits: `compare`, `gauntlet`, `gate`, `bench`, `cli`, `job`, `lookup`, `inputs`, the run
store, recorded arms, external arms and the oracles. Seven of the ten §9 questions are downstream of one
of those and cost nothing to defer — regression.db writes, the memory budget, oracle billing, who starts
Pelias, retention, board-case writes, `run_id` tracing.

**How the slice reports on itself.** After it exists, the check is not "is it faster" — that is already
measured at 7.8× (§1.2) and was never in doubt. The check is whether the next investigation's panel is
the board or a hand-picked ten. Count it: over the following working period, what fraction of measurement
claims cite `n ≥ 100` versus a self-chosen sample, and how many new one-off scripts land in `scratchpad/`.
If probe scripts keep appearing, the daemon did not remove the reason they get written, and building the
other eight tools would not have removed it either.

That is the honest version of this spec's own §5 discipline turned on the spec.
