# @mailwoman/ancestrie

A **materialized trie over an ancestry graph**: a completion trie whose entries carry their containment lineage, sealed into one static binary artifact. One prefix walk yields lexical continuations, ranks, and ancestry together — no joins, no side lookups, no server.

The package is domain-agnostic on purpose. Entries are `{ tokens, id, parentIDs, rank, payload? }` — no placetypes, no gazetteer vocabulary. Tokenization and normalization belong to the consumer: you pass the same `normalizeToken` function to the builder and the query side, and the package never normalizes on its own.

> **Status: published** as `@mailwoman/ancestrie` (operator-blessed 2026-08-18; in the `.release-it.json` workspaces list, versioned in lockstep with its siblings).

## Lineage

Every ingredient here has prior art; the composition does not. Completion over a weighted trie with per-entry payloads is "top-k completion" (Hsu & Ottaviano, WWW 2013) and ships in Lucene's suggest module — but those systems treat the payload as opaque cargo. Foursquare's **twofishes** (2012) got closest in practice: a `parentIDs: list<i64>` on every serving feature, used at autocomplete time to render "Rego Park, Queens, NY" — a materialized parent chain inside an autocomplete index, never written up or named. The closest _named_ academic structure is Roy & Chakrabarti's **materialized trie** (SIGMOD 2011), which embeds spatial summaries in trie nodes — geometry for pruning, not an ancestry graph for enumeration. Elasticsearch's completion-suggester geo context is the near-miss on the index side: a containment hierarchy (geohash prefixes) living inside the completion automaton's key bytes, but as a filter key, never an enumerated output. What none of them do is treat the completion structure as the enumeration surface for the containment graph itself — which is what this package is. The full survey, with sources, is in-repo: [`docs/records/research/2026-08-17-hierarchy-autocomplete.md`](../../docs/records/research/2026-08-17-hierarchy-autocomplete.md).

The machinery generalizes mailwoman's FST gazetteer (`packages/resolver-wof-sqlite/fst-*.ts`): the prefix walk, the partial-last-token completion and BFS expansion (#587), and the dedupe option all port from there. Since phase 2 the resolver's `fst-autocomplete` DELEGATES here through the `AncestrieReaderLike` storage seam — the algorithm has one home, pinned by the resolver's `fst-ancestrie-parity.test.ts`. The resolver's `FST\0` binary format does not migrate: its place rows are per-(surface, place) — the same id under different aliases carries per-surface data — which the id-keyed `ANCT` entry model deliberately cannot express.

## API

Build side (anywhere — no Node imports):

```ts
import { AncestrieBuilder } from "@mailwoman/ancestrie"

const builder = new AncestrieBuilder({ normalizeToken: (t) => t.toLowerCase() })

builder.add({ tokens: ["united", "states"], id: 100, parentIDs: [], rank: 0.99 })
builder.add({ tokens: ["new", "york"], id: 10, parentIDs: [100], rank: 0.95 })
builder.add({ tokens: ["new", "york"], id: 11, parentIDs: [10], rank: 0.9, payload: { kind: "city" } })
builder.add({ tokens: ["nyc"], id: 11, parentIDs: [10], rank: 0.9, payload: { kind: "city" } }) // alias

const bytes = builder.seal({ metadata: { builtAt: new Date().toISOString() } })
```

`parentIDs[0]` is the **primary parent**: interval containment answers over the primary-parent forest only (the DAG-canonicalization rule); the full parent list is preserved and surfaced verbatim. At seal time each entry receives **pre/post interval labels** over that forest — O(1) containment in both directions, and descendant enumeration as a contiguous range scan. Sealing is canonical: the same entries produce identical bytes in any add order.

Read side (browser-safe — `fetch(...).arrayBuffer()` works as-is):

```ts
import { Ancestrie, autocomplete } from "@mailwoman/ancestrie"

const trie = Ancestrie.from(bytes)

trie.walk(["new", "york"]) // { stateID, accepted: true, depth: 2 }
trie.ancestorsOf(11) // [10, 100] — nearest parent first
trie.contains(100, 11) // true, O(1)
trie.descendantsOf(10) // [11], pre-order range scan

const { suggestions } = autocomplete(trie, ["new", "yor"], {
	dedupe: true,
	normalizeToken: (t) => t.toLowerCase(),
})
// each suggestion: { id, rank, tokens, completionTokens, matchDepth, chain, parentIDs, payload? }
```

`autocomplete` handles both query shapes at once — complete tokens and a partial last token — and BFS-expands past the match with a per-branch cap so a dense branch cannot starve a higher-ranked sibling. Every suggestion returns its chain.

## Binary format

The versioned layout (magic `"ANCT"`, format version 1) is documented exhaustively in the header of [`format.ts`](./format.ts): header, string table, state/edge tables, rank-sorted entry refs, the pre-order entry table with interval labels, parent table, id index, payload blob, and the optional JSON metadata trailer. All little-endian, all read through `DataView`.

## License

AGPL-3.0-only OR LicenseRef-Commercial, as the rest of the monorepo.
