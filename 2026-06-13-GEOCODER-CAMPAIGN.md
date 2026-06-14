# Geocoder v1 campaign — the confident lineup

_2026-06-13. The plan to get from "parser + proven street-level tiers on 2 regions" to a **geocoder
that works at street level with reasonable confidence**. Synthesized from the 73 open issues, the
current state, and a DeepSeek-pro sequencing consult. Supersedes the ad-hoc `#488` daily-queue order
for this sprint. Drives tonight's parallel-agent shift._

## Definition of done (locked metric)

**A US address resolves to a street-level coordinate with a calibrated confidence radius.** Concretely
(DeepSeek-anchored): **≥85% of addressable US inputs within 100 m of truth, with calibrated uncertainty
radii**, measured on a **non-circular** held-out set (ground truth that does NOT share lineage with our
situs shards). Until that metric is measured on independent truth, "done" is vacuous.

**✅ CHECKPOINT MET (2026-06-14).** On the Travis-County TX E-911 holdout (TxGIO/TNRIS, 1965 rows, acquired
as out-of-lineage truth): the full parse → situs → interpolation → admin cascade resolves **98.8% within
100 m (97.7% within 10 m)** — far past the 85% bar. **This is a geocoder.** Honest caveats: (1) the
98.8% leans on situs whose Overture/NAD lineage likely overlaps the E-911 truth (the 10 m tightness is the
tell) — the _fully_ independent number is **interpolation-only at 66% within 100 m**; (2) accuracy tracks
situs coverage (doorstep where Overture has points, neighborhood elsewhere). Remaining for a _shipped
national_ geocoder: national interp + (license-filtered) situs builds, the conformal confidence wrapper,
the forward service surface (#485). The architecture is proven; the rest is scaling + packaging.

## Standing constraints (this sprint)

- **No current users — we are our own customer.** Back-compat is a non-constraint; breaking changes
  (schema, pipeline rewire) are FREE. Take them now.
- **Non-Latin / multi-locale may degrade.** Deferred, not abandoned. US street-level is the DoD.
- **Avoid hours-long wheel-spinning compute.** Probe-confirmed: the national shard build is **~30–45 min**
  (measured), not hours, and runs detached. The only genuinely-hours item is the OPTIONAL Overture situs
  ingestion (precision cache, deferrable). **No corpus rebuild this sprint** (the corpus exists; these are
  resolver shards, a separate pipeline). A parser fix from the Stream-0 gate is the one conditional ~1.6h.

## The five streams

Wave structure: **Stream 0 gates Stream 2.** Streams 1, 3, 4 are independent and run concurrently from
the start. `#478` arbitration is false-independent — spec early, validate after coverage.

### Stream 0 — Parser-QA gate (FIRST; ~5–8 min compute) — **Opus (judgment)**

The fatal-mistake guard (DeepSeek): don't build national shards on a parser that's silently broken on
rural routes / Spanish-named streets. Assemble ~2k random US addresses across 50 states, run a
parser tag-accuracy audit (parse only, per-state street/house_number F1). **Gate: if street/HN F1
drops >5% vs the VT baseline, fix the top degraders before Coverage** (a fix may trigger one ~1.6h
retrain — the only conditional long-compute). Issues: feeds #564/#330/#435/#444 prioritization.

### Stream 1 — Eval-truth (non-circular) (~10–30 min acquire + ~5 min/run) — **Sonnet (acquire) → Opus (lock metric)**

Our 0.0km is partly self-licking (situs shard shares lineage with the gold). Acquire **out-of-distribution
ground truth** — a jurisdiction that doesn't feed Overture (NYC PLUTO points, a county parcel-centroid
file) — build a holdout eval slice in the OA-sample format, and run the existing resolver eval against
it. Lock the DoD metric. Issues: #375 (eval methodology), #229 (val-set stratification), #518.

### Stream 2 — Coverage (~30–45 min MEASURED, detached) — **Opus (decision) + Sonnet (per-state runs)**

The wall — but the timing probe (2026-06-13) defused it. National street-level coverage:

- **TIGER interpolation FIRST** (DeepSeek's unlock): TIGER has complete US road+range coverage →
  interpolation shards give street-level for ~80% of addresses at ±50–150m. Builder:
  `scripts/build-interpolation-shard.ts`.
- **MEASURED cost** (VT probe: 14 counties / 137K segments in **3.5s** → ~0.25s/county build, ~1.2s/county
  download of ~3.1MB): national ≈ **~13 min build + ~5–15 min parallelized download (~9.7GB)** =
  **~30–45 min total, detached.** NOT hours. (The genuinely-hours item is the OPTIONAL Overture situs
  ingestion — the precision cache — which stays deferrable.)
- **Situs is the DoD lever, not just a cache (PROVEN 2026-06-14).** On the non-circular Travis-County
  E-911 holdout: TIGER interpolation alone = 66% within 100m; **+ Overture/NAD situs = 98.8% within 100m
  (97.7% within 10m), 98.3% situs hit.** Builder `scripts/build-address-point-shard.ts --state TX` read
  the local 6.5GB Overture US parquet → 11.5M TX points in a few minutes. The honest split: situs (98.8%)
  is partly in-distribution (Overture/NAD ≈ the E-911 truth lineage); **interpolation-only (66%) is the
  genuinely independent number.** Real-world read: doorstep where situs points exist (dense via Overture),
  neighborhood-via-interpolation where they don't.
- **National situs: ✅ DONE (2026-06-14).** All 50 state shards built —
  **124,928,159 address points, 29 GB**, 0 failures — at `/mnt/playpen/mailwoman-data/address-points/`.
  Driver `scripts/build-national-situs.mjs` (PR #567): streams the parquet (DuckDB `fetchChunk`, after
  `runAndReadAll` OOM'd the 13M-row states), parallelizes states via spliterator `asyncParallelIterator`
  (the 40 not-already-built finished in **4.2 min** at concurrency 4 / 4 threads each), idempotent on a
  completeness check (rows + `idx_ap_streetkey`). DoD spot-check across CA/IL/DC/IA/MT/VT: **all 6
  `address_point`, 0–34 m from truth** (5 of 6 ≤1 m). **Licensing resolved (probe, not assumption):** the
  US parquet is NAD 68.4% (public domain) + OpenAddresses 31.6% (gov open data) + **zero OSM** → built
  **unfiltered**; `--license-filter` stays for narrowed/non-US shards. Complete attribution ledger at
  `address-points/ATTRIBUTION.json` (regenerable via `scripts/situs-attribution-manifest.mjs`).
- **GATED by Stream 0** (cleared). `STATE_FIPS` extended to all 50 + the national driver landed
  (`build-national-interpolation.mjs`, DE-verified). Issues: #483 (done-engine), #476, #470, #297.

### Stream 3 — Confidence (~minutes compute) — **Sonnet (build) + Opus (gate)**

The "reasonable confidence" half. Conformal prediction over resolved coordinates (#374) on the existing
2-region resolver — produces calibrated coverage radii. Abstention/coarse-placer router (#244) — know
when NOT to answer. Builds on shipped isotonic calibration (#59/#368). Independent of Coverage.

- **✅ Interp radius calibrated (2026-06-14, PR #569).** Split-conformal on 1562 Travis interp hits (full
  national TX shard, situs off): the raw half-segment radius covers only 71.9% of errors; **×Q̂=1.70 →
  91.5%** (target 90%). Median raw 87m → calibrated 148m, median error 52.7m, interp-only hit rate 79.5%.
  Shipped opt-in (`ResolveOpts.interpolationRadiusCalibration`, byte-stable default) + on-by-default in the
  `geocode` CLI (`--interp-calibration 1.7`). Report: `docs/articles/evals/2026-06-14-interp-radius-calibration.md`.
- **Open:** re-calibrate multi-region (1.70 is TX-only); promote to a loadable artifact (#59 pattern);
  abstention router (#244 — confidence-gated downgrade to admin). The 10m situs floor is conservative-safe;
  leave it.

### Stream 4 — Callable surface (~seconds compute; pure code) — **Sonnet (each a contract)**

Make it a callable geocoder. Reverse geocoding API (#484, engine built+green). Production service layer
(#485 — batch, RemoteResolver, observability). Autocomplete (#190, FST built). Demo UX (#377). All
independent of Coverage; engines exist, this is API surface + wiring.

- **✅ Street-level `/api/geocode` + `/api/batch` (2026-06-14, PR #571 — #485 piece 1).** The server was
  admin-only (`/api/resolve`); now it runs the full cascade. Extracted the cascade into
  `mailwoman/geocode-core.ts` (`geocodeAddress` + a per-state `ShardProvider` cache), refactored the CLI
  onto it (one implementation, re-validated byte-for-byte), and added `/api/batch` (bounded concurrency,
  per-row error isolation, BATCH_MAX guardrail). Tests 5; full server+resolver suite 49/49.
- **✅ Observability `/health` + `/metrics` (2026-06-14, PR #572 — #485 piece 2).** `/health` = "what's
  deployed in one curl" (model-card version + situs/interp shard counts, no model load); `/metrics` =
  per-tier counts + latency p50/p90/p99 from a bounded reservoir, recorded per request. The instrument the
  SLO targets need. Tests 4.
- **✅ RemoteResolver (2026-06-14, PR #573 — #485 piece 3).** The `Resolver` interface over HTTP:
  `RemoteResolver.resolveTree` POSTs the parsed tree + serializable opts to the service's `/api/resolve-tree`,
  which owns the shards, runs the cascade, returns the resolved tree. Drop-in for `WofResolver` → stateless
  parser nodes + a shared resolver service, and canary diffing. Pure fetch (browser-safe). Tests 6 + a live
  round-trip; 12/12.
- **✅ Versioned data switchover (2026-06-14, PR #574 — #485 piece 4, CLOSES THE EPIC).** Shards addressed
  as `<family>-us-<slug>-<version>.db` via a `releases.json` manifest (legacy unversioned fallback);
  `ShardProvider.reload()` atomically swaps changed versions with one-generation grace (zero-downtime).
  `POST /api/reload` cuts over after publishing; `/health` reports `data.versions`. Tests 4.
- **✅ #485 service layer DONE:** batch (#571) · observability (#572) · RemoteResolver (#573) · versioned
  switchover (#574). Deferred follow-ons (not blocking): Prometheus text exposition + calibration-drift
  wiring on `/metrics`; auth/rate-limiting (deployment-specific).

### Cross-cutting — Arbitration (#478) — **Opus**

Spec the policy-registry + reconcile + abstention layer now (so the pipeline is ≥v0 by construction),
but VALIDATE after Coverage exists — it needs real tiers to calibrate. False-independence flag.

**⚠️ FINDING (2026-06-14) — the existing reconcile stage was the OPPOSITE of ≥v0.** A
reconcile-vs-raw-neural audit found joint-reconcile (#427's default) BREAKS the street+house_number
geocode precondition on 77–84% of clean US addresses and fixes 0% (golden US+FR per-tag: street
−25.6pp, house_number −23.1pp, worse-or-flat on every tag). The phrase grouper bundles the house
number into `STREET_PHRASE` and `reconcileSpans` fuses the span. It was invisible because our evals
grade **raw neural**, not the assembled pipeline — so the demo + any `createRuntimePipeline` consumer
(the #485 service surface) were silently shipping broken parses. **Retired as default** (PR #566,
`jointReconcile` → `false`); root cause filed as #565. Lesson for #478: the arbitration layer MUST be
graded on the assembled pipeline against truth, never on raw-neural per-tag F1. Report:
`docs/articles/evals/2026-06-14-reconcile-retirement.md`.

## Deferred this sprint (accuracy-broadening, not DoD-blocking)

Parser multi-locale / FR-EU polish (#330/#435/#444/#241/#293/#294/#473/#296), typo-tolerance
(#530/#531), exotic source adapters (#29/#31/#35–41), Geographic Rule Engine breadth (#288), Studio
(#13). Hygiene (#379/#442/#397/#552/#480), corpus-v0.5.1 code-point re-align (#519/#555/#558) — DeepSeek's
parallel track.

## OSM / licensing (the international lever — deferred, ODbL-gated)

The interpolation engine is source-agnostic, so OSM `addr:interpolation` ways are a drop-in for
international coverage (no TIGER/NAD equivalent exists outside the US) — needs only an OSM→`street_segment`
adapter, not an engine change. The constraint is **ODbL**, which forks on one distinction:

- A **geocoding RESULT** returned to a user is a **Produced Work** → attribution only, NO share-alike.
- A **shard built from OSM** is a **Derivative Database** → public use/distribution triggers **share-alike**
  (the shard must be offered under ODbL; its derivatives stay open). Private/server-side use does NOT trigger it.

So OSM interpolation forks: **(a) distribute ODbL open-data shards** (fine with our AGPL/copyleft ethos, but
ODbL obligations flow to consumers + infect derivatives), or **(b) server-side-only service** (private shard,
attributed results — the Pelias/Nominatim model). A product-model decision, not a blocker.

**Why this keeps OSM international-only for us:** TIGER (public domain) + NAD (open) make the US fully
distributable with zero ODbL — OSM only earns its keep where no TIGER/NAD equivalent exists.

**✅ MEASURED 2026-06-14 — the US Overture addresses carry ZERO OSM.** A full-parquet probe of the
2026-05-20.0 `addresses-us.parquet` (124.9M geocodable points) found the source mosaic is **NAD 85.5M
(68%, US public domain) + OpenAddresses 39.4M (32%, government open data), and `0` OpenStreetMap rows**
(explicit `LIKE '%osm%'` check). So the earlier "Overture is a license mosaic with OSM-sourced features
→ filter to NAD" framing was wrong for the US: there is nothing ODbL to drop, and `--license-filter NAD`
would discard a third of coverage (the dense urban OpenAddresses counties) for **no** licensing benefit.
The national situs build therefore runs **unfiltered**; the only obligation is **attribution** (NAD +
the named OpenAddresses sources), satisfied by the per-row `overture:<dataset>` provenance the builder
stamps, summarized into `<out-dir>/ATTRIBUTION.json` by `scripts/build-national-situs.mjs`. The
`--license-filter` flag stays for deliberately-narrowed or non-US/OSM shards. (IANAL — confirm against
current OSMF geocoding guidelines + counsel before shipping OSM-derived data internationally.)

## Tonight's parallel structure (the shift)

1. **Now (compute-light, concurrent):** Stream 0 parser audit (Opus) + Stream 2 one-state timing probe
   (Opus) + Stream 1 OOD-truth acquisition (Sonnet) + begin Stream 3/4 Sonnet contracts.
2. **On Stream-0 green:** launch the staged national TIGER build (detached) while streams 3/4 ship.
3. **As tiers land:** validate #478 arbitration; re-measure the DoD metric on the non-circular truth.

**The one fatal mistake to avoid:** national shards before the parser gate. Probe + audit first.

## Delegation principle

Opus holds the gates, the sequencing decisions, the metric, and the arbitration spec. Sonnet takes the
self-contained contracts: data acquisition, per-state shard runs, the callable-surface code, the
confidence builds — each a single-concern PR-ready contract, verified by the orchestrator before merge.
