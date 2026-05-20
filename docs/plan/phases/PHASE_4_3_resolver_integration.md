# Phase 4.3 — Resolver Integration

**Parent:** [`PHASE_4_resolver.md`](./PHASE_4_resolver.md).
**Predecessor:** [`PHASE_4_2_wof_sqlite.md`](./PHASE_4_2_wof_sqlite.md).

**Goal:** wire `@mailwoman/resolver-wof-sqlite` into the parser pipeline. After Phase 4.3 a user can run `mailwoman parse --resolve --format xml "75004 Paris"` and get back an `<address>` tree whose `<locality>` carries `src="wof-admin:101751119"`, `lat="48.85"`, `lon="2.34"` — the resolver overlays its attribution on top of the classifier-derived provenance from Phase 4.1.

**Branch:** TBD when this phase begins. Probably broken into 4.3.a (output-shape changes) and 4.3.b (pipeline wiring) for reviewability.

**Depends on:** Phase 4.2 (`@mailwoman/resolver-wof-sqlite` published) + Phase 4.1 (`src` attribute on `AddressNode`).

## Status

**Not started.** This document is the design intent so the operator can review the shape before implementation begins.

## What "integration" means here

Phase 4.2 ships a self-contained `PlaceLookup` that takes a text query and returns ranked candidates. Phase 4.3 turns that into something the parser pipeline knows how to use:

1. **A `Resolver` interface** that takes a parsed `AddressTree` and decorates it in-place with resolved place IDs + coordinates.
2. **A wiring point** in the parser where the resolver runs after the decoder produces the tree.
3. **A CLI flag** (`--resolve`) that toggles the pipeline on.

The decorated `AddressTree` flows through the existing XML/JSON/tuple projections — Phase 4.1's `src` attribute already carries the right shape; the resolver simply overlays its own `source` + `sourceId` on the nodes it resolved, displacing the classifier-derived attribution into `metadata` for debugging.

## Public API sketch

```ts
// mailwoman/resolver.ts (new file in the user-facing workspace)

import type { AddressTree } from "@mailwoman/core/decoder"
import type { PlaceLookup } from "@mailwoman/resolver-wof-sqlite"

export interface ResolveOpts {
	/** Hard limit on how many resolver lookups one tree is allowed to issue. Default 10. */
	maxLookups?: number
	/**
	 * Minimum candidate score for resolver attribution to win over classifier attribution. Default
	 * 0.5.
	 */
	minWinningScore?: number
}

export interface Resolver {
	/** Walk the tree top-down, resolve each node where possible, return a new tree with decorations. */
	resolveTree(tree: AddressTree, opts?: ResolveOpts): Promise<AddressTree>
}

export function createWofResolver(lookup: PlaceLookup): Resolver
```

## Decoration shape

When the resolver successfully matches a node:

| Field                                             | Before resolve                                             | After resolve                       |
| ------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `AddressNode.source`                              | `"rule"` or `"neural"` (classifier)                        | `"resolver"`                        |
| `AddressNode.sourceId`                            | classifier id (`"whos_on_first"`, `"neural-v0.3.1-en-us"`) | `"wof-admin:<wof_id>"`              |
| `AddressNode.lat` (new)                           | undefined                                                  | resolver-supplied                   |
| `AddressNode.lon` (new)                           | undefined                                                  | resolver-supplied                   |
| `AddressNode.placeId` (new)                       | undefined                                                  | normalized URI (`"wof:101751119"`)  |
| `AddressNode.metadata.classifier_source` (new)    | undefined                                                  | the displaced classifier `source`   |
| `AddressNode.metadata.classifier_source_id` (new) | undefined                                                  | the displaced classifier `sourceId` |

When the resolver does NOT match a node (no candidate above `minWinningScore`, or no resolver for the placetype), the node's existing classifier attribution is preserved unchanged.

## XML output (post-resolve)

```xml
<address raw="75004 Paris">
	<locality start="6" end="11" conf="0.94" src="wof-admin:101751119" lat="48.8534" lon="2.3488">
		Paris
		<postcode start="0" end="5" conf="0.99" src="rule:postcode">75004</postcode>
	</locality>
</address>
```

`postcode` keeps its classifier-derived `src` because the resolver doesn't ship a postcode lookup yet (would need the postalcode WOF shard — Phase 4.3.x follow-up).

## Walk strategy

The resolver walks top-down with parent-constraint inheritance:

1. Resolve the root (typically `country` or `locality` if no country was extracted).
2. For each child, query with `parentId = parent.placeId.wof_id` if the parent resolved. This narrows the search space dramatically — `Springfield` under Illinois resolves correctly without country/region disambiguation.
3. If the parent didn't resolve, fall back to unconstrained query.

Bounded by `maxLookups` — a tree with 20 candidate nodes won't trigger 20 queries; the resolver gives up at the limit and leaves the remaining nodes with classifier attribution.

## CLI

```sh
mailwoman parse --resolve --format xml "75004 Paris, FR"
mailwoman parse --resolve --resolve-db /path/to/wof.db --format xml "..."
```

- `--resolve` enables the resolver. Off by default — the rest of the pipeline is unchanged.
- `--resolve-db <path>` overrides the default WOF DB path. The default reads from `$MAILWOMAN_WOF_DB` env, else errors with a clear message about where to get the WOF distribution + how to set the env.
- Adds ~50–100ms per parse for the resolver step (a handful of FTS5 queries). Acceptable for the CLI use case; library users can disable per-call.

## What's NOT in Phase 4.3

- Postcode resolution — separate `wof-postalcode` shard, opt-in via `--resolve-postcodes` (Phase 4.3.x).
- Street-level / address-level resolution — WOF doesn't go that deep; would need OSM / OpenAddresses gazetteers, license-checked. Phase 4.4 candidate.
- Resolver feedback into parsing (the loop where resolver disagreement triggers re-classification) — Phase 4.4+.
- Multiple resolver implementations composed in priority order — for v1, one `Resolver` per parse. Composition lands when there's a second resolver to compose with.

## Tests

- Unit: `resolveTree` against a tree + a fake `PlaceLookup` that returns canned candidates. Cover: full match, partial match, no match, parent-constrained child lookup, `maxLookups` budget.
- Integration: `mailwoman parse --resolve --format xml` against a known-good WOF DB. Pinned outputs for ~6 well-known addresses (Paris,FR; Paris,TX; Springfield,IL; etc.).
- The CLI integration tests gate on the WOF DB being present (skip-if-missing pattern, matching how the locale-flag tests handle their fixture deps).

## Open questions

- **Where does the resolver live in the workspace tree?** Two candidates:
  - `mailwoman/resolver.ts` (in the user-facing workspace) — keeps the wiring close to the CLI and parser callsite.
  - `@mailwoman/core/resolver` (new subpath) — better if a third-party adapter (e.g. BAN-API) wants the same interface.
  - **Lean toward `core/resolver`** — interface separation pays off as soon as Phase 4.4's `RemoteResolver` lands.
- **Lat/lon precision.** WOF stores ~4–6 decimal places; some downstream consumers want bounding boxes instead of centroids. Defer: emit centroids, document that `geom:bbox` is available via `AddressNode.metadata.wof_bbox` if needed.
- **Resolver caching.** A common parse stream (`Paris, FR` typed by 1000 users) shouldn't issue 1000 FTS queries. Defer: in-process LRU at the resolver level, sized by `maxCacheSize` opt (default 1000). Test once Phase 4.3 is exercised in a real workload.

## Open dependencies

- WOF data download still needs operator authorization (carried over from the Phase 4.2 handover). Without the actual DB on disk, the CLI integration tests can't run end-to-end.

## Changelog

- **2026-05-20** — written as design intent during the autonomous night shift. Not yet started; awaits operator review.
