# Phase 4 — Resolver

**Goal:** add a resolver layer that takes parsed components and resolves them to canonical place identifiers + coordinates, with source provenance threaded through the output. The parser and geocoder share one representation — the same `AddressTree` the decoder already produces, decorated in-place.

**Status:** opened 2026-05-20, supersedes the [original sketch](#changelog). Phases 0–3 have shipped (`@mailwoman/neural@2.1.0` on npm; CLI + per-component policy live). Real-world deployment has not yet generated feedback, but the team has accepted the architectural risk of beginning Phase 4 work now so that the output shape (`src` attr already reserved on the XML serializer) can land before downstream consumers depend on its absence.

**Branch:** sub-phase branches off `main` (`feature/phase-4-<slice>`). Each sub-phase ships independently.

**Depends on:** `@mailwoman/core@2.x` decoder pipeline (PR #58 lineage), `@mailwoman/neural@2.x`.

## Why now, why this shape

Three forcing functions:

1. **The XML serializer already reserves the `src` attribute** ([serialize-xml.ts:18](../../core/decoder/serialize-xml.ts)). The TODO comment is a public commitment; shipping a release that adds the attr is non-breaking only because consumers don't depend on its absence _yet_. Every release that goes out without `src` makes the eventual flip costlier.
2. **The neural classifier emits proposals with `source` + `source_id` fields that the decoder discards.** That's free debugging signal we're throwing away.
3. **Resolver feedback into parsing was the project creator's original vision** (per `reference/ARCHITECTURE.md`'s opening). The resolver is not bolted on — it shares the `AddressTree` representation.

## Architecture decision: Option B (SQLite FTS5 + WOF SQLite)

The original sketch listed three options. This plan picks **Option B**.

- **Option A** (tantivy / Airmail) — rejected for v1. Introduces Rust into the runtime, which contradicts the project's "TypeScript-first" hard constraint (`docs/plan/README.md`). Revisit only if Option B's recall floor is unacceptable at planet scale.
- **Option C** (external geocoder API) — rejected as the _default_. Network dependency + rate limits + privacy implications all hostile to a library that's meant to be embedded. We _will_ expose a `RemoteResolver` adapter for users who prefer Pelias / BAN / Nominatim, but the in-package default is local.
- **Option B** (SQLite FTS5 + WOF SQLite) — picked. WOF mirrors at [data.geocode.earth/wof/dist/sqlite/](https://data.geocode.earth/wof/dist/sqlite/) (per `project-geocode-earth-voltron` notes) ship as a known-good packaging. Pure Node via `node:sqlite` (built-in since Node 22) or `better-sqlite3` (lighter dependency surface). Pros: zero new runtime languages, deterministic, offline-capable, fits the existing `weights-*` package shape (data packages downloaded on demand). Cons: slower at planet scale than tantivy, simpler ranking — acceptable for v1 because the parser narrows the search space (locality + region + country are already extracted).

## Sub-phase breakdown

Phase 4 ships in three slices, each independently mergeable:

| Slice                                 | Goal                                                                                                                                                                                                                                                              | Independently useful?                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **4.1 — Source provenance (this PR)** | Thread `source` + `source_id` from `ClassificationProposal` through the decoder; `AddressNode` gains optional `source` + `sourceId`; XML serializer emits `src` attribute; JSON / tuple projections unchanged.                                                    | Yes — surfaces classifier provenance to debug + downstream filtering. No resolver yet.                |
| **4.2 — WOF SQLite loader package**   | New package `@mailwoman/resolver-wof-sqlite` (or fold into `@mailwoman/neural`? decide in 4.2). Loads a WOF SQLite distribution, exposes an FTS5-backed lookup `findPlace({ locality, region, country, locale })` returning candidate WOF places with confidence. | Yes — usable standalone for "what's the WOF id for Paris, FR?" without going through the full parser. |
| **4.3 — Resolver integration**        | `Resolver` interface + `WofSqliteResolver` impl + `resolveTree(tree, resolver)` that walks the `AddressTree`, queries the resolver per node, decorates with `src="wof-admin:<id>"`, `lat`, `lon`, `wof_id`. CLI `--resolve` flag.                                 | Closes the loop — outputs gain real-world identifiers.                                                |

Sub-phases 4.2 and 4.3 will each get their own plan doc (`PHASE_4_2_*.md`, `PHASE_4_3_*.md`) written when they begin. This doc is the spine.

## Phase 4.1 — Source provenance (current)

### Pre-flight

- [x] PR #58 (decoder + 3 projections) merged.
- [x] `ClassificationProposal.source` + `source_id` defined in `core/types/`.

### Tasks

1. **Decoder types**
   - `core/decoder/types.ts`: extend `AddressNode` with `source?: string` and `sourceId?: string`. Both optional; the existing decoder paths that emit `AddressNode` without these continue to work.
   - Update the file header to describe the provenance fields.

2. **proposalsToTree**
   - `core/decoder/proposals-to-tree.ts`: carry `p.source` and `p.source_id` through into each emitted root. Drop the fields when the proposal lacks them (defensive — the type allows it).

3. **buildAddressTree**
   - `core/decoder/build-tree.ts`: optional `BuildTreeOpts { source?: string; sourceId?: string }` param. The neural pipeline's caller stamps `source: "neural"` + `sourceId: <model-card-version>` on every emitted span. No per-span variation here — one model, one source.

4. **XML serializer**
   - `core/decoder/serialize-xml.ts`: emit `src="<value>"` when `node.source` or `node.sourceId` is set. Format: `src="<source>:<sourceId>"` if both present, `src="<source>"` if only source. Add `includeSrc?: boolean` opt (default true) for callers who want to suppress.
   - Update the file header: drop "reserved for Phase 4" wording; replace with the actual semantics.

5. **JSON + tuple projections — explicitly unchanged**
   - `decodeAsJson` stays libpostal-compat (shape: `{ tag: value }`). No provenance.
   - `decodeAsTuples` stays `[tag, value][]`. No provenance.
   - Rationale documented in the file headers.

6. **Tests**
   - `core/decoder/provenance.test.ts` (new): verify the `src` attr through both `proposalsToTree` and `buildAddressTree` paths; verify `includeSrc: false` suppresses it; verify JSON/tuple projections are unchanged when provenance is set.
   - Update existing `serialize.test.ts` only if necessary (existing fixtures don't set provenance, so `src` should be absent — that's a feature).

### Success criteria

- All existing decoder tests pass unchanged.
- New provenance test passes for both decoder entry points.
- A `decodeAsXml` call on a proposal-derived tree emits `<locality src="rule:whos_on_first" ...>Paris</locality>`-style output.

### Out of scope for 4.1

- Resolver lookup (4.3).
- Lat/lon attrs (4.3).
- WOF SQLite loader (4.2).
- `decodeAsJson` shape change (deferred indefinitely; libpostal compat is load-bearing).

## Phase 4.2 — WOF SQLite loader (sketch)

Standalone package. Loads a WOF SQLite distribution from a path or URL. Exposes:

```ts
interface WofPlace {
	wof_id: number
	name: string
	placetype: "country" | "region" | "locality" | "neighbourhood" | "microhood" | ...
	lat: number
	lon: number
	parent_id?: number
	country: string // ISO-3166 alpha-2
}

interface PlaceLookup {
	findPlace(query: {
		text: string
		placetype?: WofPlace["placetype"]
		country?: string
		parentId?: number
	}): Promise<Array<{ place: WofPlace; score: number }>>
}
```

FTS5 over `wof.name` + `wof.name_alts`. Score = FTS5 BM25 + boosts for placetype + country match. Distribution-versioning piggy-backs on the existing `neural-weights-*` pattern: `@mailwoman/wof-sqlite-<region>` packages, one per geographic shard, pulled on demand.

Decisions deferred to 4.2:

- Sync (`better-sqlite3`) vs async (`node:sqlite` + `Worker`) — depends on what `onnxruntime-node` already does and whether resolver lookups end up in a hot loop.
- Whether to fold into `@mailwoman/neural` or split — split is cleaner but means another package to publish.
- Region sharding strategy (US-only first vs full planet vs admin-2 shards).

## Phase 4.3 — Resolver integration (sketch)

`Resolver` interface composes a `PlaceLookup` (4.2) with the `AddressTree`:

```ts
interface Resolver {
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>
}
```

Walk the tree top-down (country → region → locality → ...), use each resolved parent's `wof_id` to constrain the child lookup. Decorate matched nodes with `source: "resolver"`, `sourceId: "wof-admin:<wof_id>"`, and new fields on `AddressNode`: `lat?: number; lon?: number; placeId?: string`. The XML serializer gains those as additional attributes when present.

When the resolver "wins" attribution, the classifier's original `source` moves into `metadata` so debugging tools can still see it. The XML attr shows the _winning_ source.

CLI: `mailwoman parse --resolve --format xml` toggles the pipeline on. Default off until 4.3 ships.

## Decisions deferred until 4.2 / 4.3 begin

- Feedback loop (resolver-corrects-parser) — not in v1. The output is decorated, not rewritten. A future sub-phase 4.4 can add the loop.
- Whether to expose the joint `{tree, resolution}` type publicly — deferred to 4.3.
- BAN-specific resolver for FR — likely a separate `WofSqliteResolver` peer using the BAN data, gated on whether WOF's France coverage is acceptable in the eval set. Defer until 4.3 hits the eval bench.

## Reading material to revisit at each sub-phase

- `ellenhp/airmail` — even though Option A is rejected, the indexer's ranking heuristics are worth borrowing.
- `pelias/placeholder` — closest prior art for Option B; cribbing welcome.
- WOF's `placetype` taxonomy — the canonical hierarchy walking strategy.
- `project-geocode-earth-voltron` operator note — sanity-check the SQLite schema against the source before trusting it.
- `project-mailwoman-licensing` — WOF is CC-BY 4.0; attribution required in any redistribution. The resolver package's README must carry it.

## Changelog

- **2026-05-20** — sketch (the original three-option overview) replaced with this detailed plan. Picked Option B. Defined sub-phases 4.1 / 4.2 / 4.3 and started 4.1.
