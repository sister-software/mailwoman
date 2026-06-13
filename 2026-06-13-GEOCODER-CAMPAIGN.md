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

## Standing constraints (this sprint)

- **No current users — we are our own customer.** Back-compat is a non-constraint; breaking changes
  (schema, pipeline rewire) are FREE. Take them now.
- **Non-Latin / multi-locale may degrade.** Deferred, not abandoned. US street-level is the DoD.
- **Avoid hours-long wheel-spinning compute.** Only ONE task carries it (national shard build); it runs
  detached + staged in the background while compute-light streams complete. **No corpus rebuild this
  sprint** (the corpus exists; these are resolver shards, a separate pipeline).

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

### Stream 2 — Coverage (HOURS, detached + staged) — **Opus (decision) + Sonnet (per-state runs)**

The wall. National street-level coverage:

- **TIGER interpolation FIRST** (DeepSeek's unlock): TIGER has complete US road+range coverage →
  interpolation shards give street-level for ~80% of addresses at ±50–150m. Build per-county/state,
  **staged by population (top-N counties first)**, detached. Builder: `scripts/build-interpolation-shard.ts`.
- **Situs as a precision cache** (not the base): snap to an Overture/NAD point when one falls in a
  segment. Overture ingestion (#470/#477/#474) runs in parallel, deferrable.
- **GATED by Stream 0.** **De-risk: one-state timing probe FIRST** to convert "HOURS, unknown" into a
  measured per-county number before committing national. Issues: #483 (done-engine), #476, #470, #297.

### Stream 3 — Confidence (~minutes compute) — **Sonnet (build) + Opus (gate)**

The "reasonable confidence" half. Conformal prediction over resolved coordinates (#374) on the existing
2-region resolver — produces calibrated coverage radii. Abstention/coarse-placer router (#244) — know
when NOT to answer. Builds on shipped isotonic calibration (#59/#368). Independent of Coverage.

### Stream 4 — Callable surface (~seconds compute; pure code) — **Sonnet (each a contract)**

Make it a callable geocoder. Reverse geocoding API (#484, engine built+green). Production service layer
(#485 — batch, RemoteResolver, observability). Autocomplete (#190, FST built). Demo UX (#377). All
independent of Coverage; engines exist, this is API surface + wiring.

### Cross-cutting — Arbitration (#478) — **Opus**

Spec the policy-registry + reconcile + abstention layer now (so the pipeline is ≥v0 by construction),
but VALIDATE after Coverage exists — it needs real tiers to calibrate. False-independence flag.

## Deferred this sprint (accuracy-broadening, not DoD-blocking)

Parser multi-locale / FR-EU polish (#330/#435/#444/#241/#293/#294/#473/#296), typo-tolerance
(#530/#531), exotic source adapters (#29/#31/#35–41), Geographic Rule Engine breadth (#288), Studio
(#13). Hygiene (#379/#442/#397/#552/#480), corpus-v0.5.1 code-point re-align (#519/#555/#558) — DeepSeek's
parallel track.

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
