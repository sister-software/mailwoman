# @mailwoman/ancestrie

This package is a **materialized trie over an ancestry graph**. It is a completion trie whose entries carry their containment lineage, sealed into one static binary artifact. One prefix walk returns lexical continuations, ranks, and ancestry together, without joins, side lookups, or a server.

The package is domain-agnostic. Entries are `{ tokens, id, parentIDs, rank, payload? }` and carry neither placetypes nor gazetteer vocabulary. The consumer owns tokenization and normalization. You pass the same `normalizeToken` function to the builder and the query side, and the package never normalizes on its own.

> **Status: published** as `@mailwoman/ancestrie`. The operator approved publication on 2026-08-18. The package is in the `.release-it.json` workspaces list and is versioned in lockstep with its siblings.

## Lineage

Each ingredient here has prior art, but the combination does not. Completion over a weighted trie with per-entry payloads is "top-k completion" (Hsu & Ottaviano, WWW 2013) and ships in Lucene's suggest module, but those systems treat the payload as opaque data. Foursquare's **twofishes** (2012) came closest in practice. It stored a `parentIDs: list<i64>` on every serving feature and used it at autocomplete time to render "Rego Park, Queens, NY". That is a materialized parent chain inside an autocomplete index, though twofishes never documented or named it. The closest _named_ academic structure is Roy & Chakrabarti's **materialized trie** (SIGMOD 2011), which embeds spatial summaries in trie nodes. Those summaries are geometry used for pruning rather than an ancestry graph used for enumeration. On the index side, Elasticsearch's completion-suggester geo context comes close. It stores a containment hierarchy (geohash prefixes) inside the completion automaton's key bytes, but uses it only as a filter key and never enumerates it as output. None of these systems uses the completion structure to enumerate the containment graph itself, and this package does. The full survey, with sources, is in the repository: [`docs/records/research/2026-08-17-hierarchy-autocomplete.md`](../../docs/records/research/2026-08-17-hierarchy-autocomplete.md).

The implementation generalizes mailwoman's FST gazetteer (`packages/resolver-wof-sqlite/fst-*.ts`). The prefix walk, the partial-last-token completion, the BFS expansion (#587), and the dedupe option all come from there. Since phase 2, the resolver's `fst-autocomplete` delegates to this package through the `AncestrieReaderLike` storage interface, so the algorithm lives in one place. The resolver's `fst-ancestrie-parity.test.ts` checks that the two agree. The resolver's `FST\0` binary format does not migrate. Its place rows are keyed per (surface, place), so the same id under different aliases carries per-surface data. The id-keyed `ANCT` entry model intentionally cannot express that.

## API

The build side runs anywhere because it has no Node imports:

```ts
import { AncestrieBuilder } from "@mailwoman/ancestrie"

const builder = new AncestrieBuilder({ normalizeToken: (t) => t.toLowerCase() })

builder.add({ tokens: ["united", "states"], id: 100, parentIDs: [], rank: 0.99 })
builder.add({ tokens: ["new", "york"], id: 10, parentIDs: [100], rank: 0.95 })
builder.add({ tokens: ["new", "york"], id: 11, parentIDs: [10], rank: 0.9, payload: { kind: "city" } })
builder.add({ tokens: ["nyc"], id: 11, parentIDs: [10], rank: 0.9, payload: { kind: "city" } }) // alias

const bytes = builder.seal({ metadata: { builtAt: new Date().toISOString() } })
```

`parentIDs[0]` is the **primary parent**. Interval containment answers over the primary-parent forest only, which is the DAG-canonicalization rule. The full parent list is preserved and returned verbatim. At seal time each entry receives **pre/post interval labels** over that forest. The labels give O(1) containment checks in both directions and turn descendant enumeration into a contiguous range scan. Sealing is canonical, so the same entries produce identical bytes in any add order.

The read side is browser-safe, and `fetch(...).arrayBuffer()` works as-is:

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

`autocomplete` handles complete tokens and a partial last token in the same query. It BFS-expands past the match with a per-branch cap so that a dense branch cannot crowd out a higher-ranked sibling. Every suggestion returns its chain.

## Binary format

The versioned layout (magic `"ANCT"`, format version 1) is documented in the header of [`format.ts`](./format.ts). It covers the header, string table, state/edge tables, rank-sorted entry refs, the pre-order entry table with interval labels, parent table, id index, payload blob, and the optional JSON metadata trailer. All fields are little-endian and are read through `DataView`.

## License

AGPL-3.0-only OR LicenseRef-Commercial, the same as the rest of the monorepo.
