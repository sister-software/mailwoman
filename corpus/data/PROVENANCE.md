# `corpus/data/` provenance

## `sub-venue-lexicon.json` — the sub-venue designator lexicon (#35, wave 1)

The vocabulary a corpus shard (and eventually the span proposer) reads to recognize `Terminal 5`,
`North Terminal`, `Concourse B`, `ターミナル1` as venue-interior structure. Generated, **not
hand-edited**. See `docs/engineering/sub-venue-corpus-task.mdx` for why this exists — the short
version is that the `unit` tag was never taught the modifier+designator shape, so closing the class by
decode weight would take a bias scale near 11 nats where the stronger designator+identifier evidence
needed 6.

### Regenerate

```sh
mailwoman corpus fetch wikidata-subvenue --out-root $MAILWOMAN_DATA_ROOT/sub-venue/sources
mailwoman corpus sub-venue-lexicon \
  --wikidata-dir $MAILWOMAN_DATA_ROOT/sub-venue/sources/wikidata-subvenue \
  --osm-jsonl    $MAILWOMAN_DATA_ROOT/sub-venue/extracts/great-britain.jsonl \
  --out          corpus/data/sub-venue-lexicon.json
npx oxfmt corpus/data/sub-venue-lexicon.json
```

The oxfmt pass is required — committed JSON is oxfmt-clean, which raw `JSON.stringify` cannot
reproduce. The generator is byte-deterministic and oxfmt is too, so the artifact is reproducible from
the same fetch outputs. `sub-venue-lexicon.test.ts` pins determinism directly.

The OSM JSONL is produced by `@mailwoman/osm/sdk`'s `extractOSMSubVenues` over a Geofabrik extract; it
is a build output, not a committed input.

### Sources, as of the committed build (2026-08-04)

| source          | origin                                             | license | rows    |
| --------------- | -------------------------------------------------- | ------- | ------- |
| Wikidata (WDQS) | `https://query.wikidata.org/sparql`, 8 concept ids | CC0     | 877     |
| OpenStreetMap   | Geofabrik `great-britain-latest.osm.pbf`           | ODbL    | 254,356 |

**The ODbL question.** The committed artifact contains no OSM geometry and no OSM row. What survives
the OSM leg is 133 surface COUNTS — that the token `terminal` appears in 87 GB feature names — plus
the `identifierShapes` distribution, whose `examples` are gate reference strings (`B32`, `1A`,
`16-18`). Facts and short factual strings are not a substantial extraction from a database, so this
table is not treated as a Derived Database. That reading matches `osm/README.md`'s posture that the
ODbL obligation rides on the built shard rather than on code — but a corpus shard built from OSM rows
IS a derived work, and wave 2 has to settle that before any OSM-derived shard trains a shipped model.

### The two measurements that shaped the build

Both taken 2026-08-04 against the Berlin and Great Britain extracts, and both contradict the obvious
design:

1. **An OSM feature's `name` is usually the VENUE's name, not a sub-venue phrase.** A
   `railway=platform` in Berlin is named `Stendaler Straße`; a `railway=station` is named `Bellevue`.
   Across 250,116 named GB features, only 6,003 (2.40%) contain a designator token at all. So names are
   not harvested wholesale — a name contributes only when it CONTAINS a known designator surface.
   Harvesting wholesale would have filled the lexicon with British and German street names.

2. **The identifier lives in `ref`, not in `name`.** All 658 GB `aeroway=gate` features but 13 are
   unnamed and carry only a `ref`. `Gate A12` is therefore a RENDERING, not a string anyone wrote
   down, which is why the table carries an identifier DISTRIBUTION (`identifierShapes`) rather than a
   phrase list. The GB gate distribution: 463 bare digits, 122 letter-digit (`B32`), 54 digit-letter
   (`1A`), 10 `other` (semicolon multi-values like `1;2;3`), 6 ranges (`11/12`).

### `curated: false` is the default and nothing auto-promotes

Wikidata gives a CONCEPT NAME per language, not a designator as addressed: Q849706's Spanish label is
`terminal aeroportuaria` where the addressed form is `Terminal`. Every machine-derived surface lands
`curated: false`. **A consumer that gates a parse must filter to `curated: true`.** The curated set is
the 9 shipped designators plus the 12 shipped modifiers — 21 surfaces — and it grows by human review
with a confound board, one term at a time.

The confound measurement that makes this rule concrete, from the GB extract:

| token       | GB named-feature hits | what the top of the distribution actually is                       |
| ----------- | --------------------: | ------------------------------------------------------------------ |
| `hall`      |                 3,274 | Village Hall (418), Town Hall (73), Hall Lane, Hall Road — streets |
| `gate`      |                   890 | Park Gate, Notting Hill Gate, Queens Gate, Lancaster Gate          |
| `platform`  |                   676 | mixed                                                              |
| `campus`    |                   560 | mostly real                                                        |
| `terminal`  |                   304 | mostly real                                                        |
| `pier`      |                   162 | Pier Avenue / Pier Road / real piers, mixed                        |
| `wing`      |                    29 | **clean** — hospital wings (`South Wing`, `Bexley Wing`)           |
| `arcade`    |                    23 | mixed                                                              |
| `concourse` |                     4 | 3 of 4 are a street called CONCOURSE WAY                           |

`hall` is the trap: it is a real designator in German airports (`Halle 2`) and a disaster in en-GB.
Any promotion has to be per-locale. `gate`'s 890 hits are the measurement behind its existing
exclusion from `MODIFIER_ELIGIBLE_STRUCTURE_DESIGNATORS`.

### The seed duplicates `neural/venue-structure.ts`

`@mailwoman/corpus` does not depend on `@mailwoman/neural`, so the shipped designator and modifier
lists are re-declared in `sub-venue-lexicon.ts`. That is a drift surface, and `sub-venue-lexicon.test.ts`
pins both lists literally so a change in either place fails a test rather than passing silently. Wave
2's right move is the reverse direction: have `neural/venue-structure.ts` read a committed lexicon
slice and delete both copies.
