# @mailwoman/resolver

Walk a parsed `AddressTree` and decide, for each span, which real place it names — then hand back the tree with coordinates, attribution and ancestry stamped on it.

This is the half of [mailwoman](https://www.npmjs.com/package/mailwoman) that turns _"the model thinks this run of characters is a locality"_ into _"this is Springfield, Illinois, at 39.7973/-89.6455, and here is why."_ It owns the ranking, the coherence passes and the ordering rules; it owns no data. The gazetteer lives behind a `ResolverBackend` you supply.

## Installation

```bash
npm install @mailwoman/resolver
```

## Quick start

```ts
import { createWOFResolver } from "@mailwoman/resolver"
import { WOFSQLitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"

const backend = new WOFSQLitePlaceLookup({ databasePath: "/path/to/admin.db" })
const resolver = createWOFResolver(backend)

const decorated = await resolver.resolveTree(tree)
```

`resolveTree` returns a new tree. Nodes that resolved carry `lat`/`lon`, a `placeID`, and `resolver_*` metadata; nodes that did not are returned untouched.

## Backend-agnostic on purpose

`createWOFResolver` takes a `ResolverBackend` — a structural interface, not a class. `@mailwoman/resolver-wof-sqlite` implements it over `node:sqlite`, `@mailwoman/resolver-wof-wasm` over `@sqlite.org/sqlite-wasm` in a browser, and `RemoteResolver` over HTTP. Nothing here imports any of them.

Backends differ in what they can answer, and that is visible rather than silent: `describeCapabilityGaps(backend)` reports which optional methods are missing, so a default-on feature that quietly no-ops on your backend says so instead of looking like a bad result.

## Absence is a value

Two rules run through this package, and both exist because their opposites shipped bugs.

**A coordinate the gazetteer cannot supply is absent, never `0,0`.** `0,0` is the unlocated sentinel in every WOF-lineage database, and those databases carry a great deal of it — 48,216 of 142,604 Japanese postcodes, 86,377 GB, 414 US. `decorateNode` leaves `lat`/`lon` unset for such a row, so the place still resolves and identifies itself while stating that it cannot say where it is. A consumer's `lat != null` check then means what it looks like it means.

**A missing answer is not a wrong answer.** An unresolvable span is returned as parsed. Nothing here invents a centroid to fill a hole.

## Which resolved place answers the query

`admin-winner.ts` owns one ordering, and it is the only one whose rungs are not fixed.

`PLACETYPE_SPECIFICITY` ranks placetypes by how much ground they cover, which is the right question for most of them and the wrong one for `postalcode`. A GB unit postcode covers ~15 addresses and is tighter than any locality centroid; a French _code postal_ often spans several communes and is coarser than the one you want. One number cannot be both.

So the rank of a resolved postcode is computed, from two independent routes:

```ts
import { adminLadderForNodes, resolvedSpecificity } from "@mailwoman/resolver"

// Result assembly walks a tag ladder…
const ladder = adminLadderForNodes(nodes)

// …and a harness sorting resolved nodes by placetype asks the same question this way.
const rank = resolvedSpecificity({ placetype: "postalcode", value: "N7 0BT", resolverName: "n70bt" })
```

Either an **exact hit on a unit-grade code** (`@mailwoman/codex`'s `UNIT_GRADE_POSTCODE` — NL PC6, GB unit, CA urban LDU) or an **address system whose area-grade codes are finer than its localities** (`AREA_POSTCODE_FINER_THAN_LOCALITY` — Germany, where a Gemeinde can be the size of Berlin) puts the postcode ahead of the locality. Everything else follows the locality.

The two shapes live in one module deliberately. They express one claim and are consumed by different callers, and when they were separate the eval harnesses each froze one arm of the conditional as a constant — every grader correct on half the data and wrong on the other half, unconditionally, for as long as nobody compared them. `test/unit/admin-winner.test.ts` asserts they agree on every arm; mutating either side fails it.

Membership in those tiers is earned by measurement, never by shape alone. Canada is the worked example: its urban LDU measures 78 m against rooftop truth and joined the tier, while its rural codes measure 2.08 km and did not — and Canada Post already marks the difference with a `0` in the second character, so the code says which before any lookup runs.

## Coherence passes

Ranking a span in isolation gets Portland, Maine to Messina, Italy. These run over the whole tree:

| Pass                         | Question                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `admin-coherence-passes`     | Do the resolved places actually contain one another?                           |
| `postcode-country-coherence` | Does the postcode's shape agree with the country the rest of the tree implies? |
| `postcode-shape-coherence`   | Is this span a postcode at all, in any system the query could be in?           |
| `admin-containment`          | Split candidates by whether they sit inside an established parent.             |
| `span-rescore`               | A resolved neighbour is evidence about an unresolved span.                     |
| `street-evidence`            | A commune-scoped street hit is evidence of that street's locality.             |
| `plausibility`               | Is this answer outside the country it claims?                                  |

## Subpath exports

Import the barrel for the whole surface, or a subpath to take one piece without the rest:

`./resolve` · `./admin-winner` · `./decorate-node` · `./plausibility` · `./postcode-prefix` · `./postcode-country-coherence` · `./postcode-shape-coherence` · `./admin-containment` · `./span-rescore` · `./street-evidence` · `./toponym-prior` · `./rerank` · `./remote-resolver` · `./backend-capabilities`

The type contract (`ResolverBackend`, `ResolveOpts`, `ResolvedPlace`) lives in `@mailwoman/core/resolver` so that `core` stays a leaf, and is re-exported here — `@mailwoman/resolver` is the complete surface.

## License

AGPL-3.0 — see the [repository](https://github.com/sister-software/mailwoman).
