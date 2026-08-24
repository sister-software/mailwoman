# `corpus/data/` provenance

## `reviewed-ve-postcode-tuples.json` — reviewed Venezuelan postcode placement (#1821)

Four geographic facts support the Venezuelan `locality postcode, region` convention. The Barcelona
tuple comes from the Anzoátegui state government's contact address. The Caracas, Sanare, and Santa
Elena de Guairén tuples come from the Universal Postal Union's Venezuela addressing guide. The file
records the publisher, full source address, retrieval date, review status, and source-license note for
each tuple.

Only factual fields are stored. No source prose is copied, and the corpus rows do not claim that either
source published the facts under CC0 or another open-data license. The recipe creates bounded synthetic
case, punctuation, accent, country-tail, and left-context forms while keeping each reviewed
postcode-to-place join unchanged.

## `sub-venue-lexicon.json` — the sub-venue designator lexicon (#35, waves 1–2)

The vocabulary a corpus shard (and eventually the span proposer) reads to recognize `Terminal 5`,
`North Terminal`, `Concourse B`, `第1ターミナル` as venue-interior structure. Generated, **not
hand-edited**. See `docs/engineering/sub-venue-corpus-task.mdx` for why this exists — the short
version is that the `unit` tag was never taught the modifier+designator shape, so closing the class by
decode weight would take a bias scale near 11 nats where the stronger designator+identifier evidence
needed 6.

The one hand-authored input is `corpus/src/tools/sub-venue-promotions.ts`, the curation ledger. The
builder cannot decide that Spanish `terminal` is safe and British `hall` is not, because that is a
judgement about a language's confounds; what it does is APPLY those decisions.

### Regenerate

```sh
mailwoman corpus fetch wikidata-subvenue --out-root $MAILWOMAN_DATA_ROOT/sub-venue/sources

# One extraction per region. ogr2ogr dominates: 44 s for a 340 MB extract, 371 s for Japan's 2.5 GB.
mailwoman corpus sub-venue-extract \
  --pbf $MAILWOMAN_DATA_ROOT/sub-venue/pbf/japan.osm.pbf \
  --out $MAILWOMAN_DATA_ROOT/sub-venue/extracts/japan.jsonl --country JP

mailwoman corpus sub-venue-lexicon \
  --wikidata-dir $MAILWOMAN_DATA_ROOT/sub-venue/sources/wikidata-subvenue \
  --extracts "GB=$E/great-britain.jsonl,DE=$E/germany.jsonl,FR=$E/france.jsonl,ES=$E/spain.jsonl,JP=$E/japan.jsonl" \
  --overture-db $MAILWOMAN_DATA_ROOT/poi/poi.db \
  --out corpus/data/sub-venue-lexicon.json
npx oxfmt corpus/data/sub-venue-lexicon.json
```

`$E` is `$MAILWOMAN_DATA_ROOT/sub-venue/extracts`. `--extracts` takes `REGION=path` pairs because the
region is the axis every curation decision is taken on, and no extract filename carries it reliably —
`ile-de-france` is FR, `great-britain` is GB. A bare path lands region `""`, whose surfaces can never
be promoted.

The oxfmt pass is required — committed JSON is oxfmt-clean, which raw `JSON.stringify` cannot
reproduce. The generator is byte-deterministic and oxfmt is too, so the artifact is reproducible from
the same fetch outputs. `sub-venue-lexicon.test.ts` pins determinism directly.

The extract JSONLs and the `.osm.pbf` files are build inputs under
`$MAILWOMAN_DATA_ROOT/sub-venue/`, not committed.

### Sources, as of the committed build (2026-08-05)

| source          | origin                                             | license             | rows    |
| --------------- | -------------------------------------------------- | ------------------- | ------- |
| Wikidata (WDQS) | `https://query.wikidata.org/sparql`, 8 concept ids | CC0                 | 877     |
| OpenStreetMap   | Geofabrik `great-britain-latest.osm.pbf`           | ODbL                | 254,356 |
| OpenStreetMap   | Geofabrik `germany-latest.osm.pbf`                 | ODbL                | 403,863 |
| OpenStreetMap   | Geofabrik `france-latest.osm.pbf`                  | ODbL                | 251,260 |
| OpenStreetMap   | Geofabrik `spain-latest.osm.pbf`                   | ODbL                | 78,918  |
| OpenStreetMap   | Geofabrik `japan-latest.osm.pbf`                   | ODbL                | 183,999 |
| Overture Places | `poi.db` spatial layer, vintage `2026-05-20.0`     | CDLA-Permissive-2.0 | 9,219   |

**The ODbL question, unchanged from wave 1 and still open for the shard.** The committed artifact
contains no OSM geometry and no OSM row. What survives the OSM leg is surface COUNTS — that the token
`ターミナル` appears in 1,215 Japanese feature names — plus the `identifierShapes` distribution, whose
`examples` are gate reference strings (`B32`, `1A`, `16-18`). Facts and short factual strings are not
a substantial extraction from a database, so this table is not treated as a Derived Database. That
reading matches `osm/README.md`'s posture that the ODbL obligation rides on the built shard rather
than on code. **A corpus shard built from OSM rows IS a derived work, and that question is still not
settled** — it gates step 4, not this table.

### What the sources are FOR, and what each cannot do

Overture and OSM fail differently, which is why both are read.

- **Overture (`poi.db`)** is curated venue-interior naming. `concourse` appears 35 times in its
  `airport_terminal` slice against 4 in the whole Great Britain OSM extract, and 3 of those 4 are a
  street called CONCOURSE WAY. **But poi.db is four countries** — US 11,521,612 / CA 794,418 /
  FR 721,352 / MX 644,316, and nothing else (measured 2026-08-05). It can attest en-US, en-CA, fr-FR
  and es-MX and nothing else, so a zero count in it is evidence of absence in four countries, not in
  the world.
- **OSM** reaches any region with a Geofabrik extract, and carries the `name:<lang>` family, which is
  where every non-Latin surface in this table comes from. What it does not carry is a curated notion
  of "interior": 3,204 of Great Britain's 3,273 `hall` hits sit on a `public_transport=platform`,
  because a British bus stop is named after the village hall it stands outside.

The Overture category set is measured, not guessed. A full scan of all 13,681,698 rows counted, per
category, how many named rows carry a designator token; the ranking is not what a category name
predicts. `gas_station` leads the entire table with 12,996 hits, every one of them `station` inside
"Holiday Station" or "Chevron Station Seward", and `shoe_store` contributes 708 hits of `wing` because
Red Wing sells boots. Four categories survived reading the distribution — `airport_terminal`,
`campus_building`, `pier`, `airport_lounge` — and `overture-subvenue.ts` lists the rejects with the
number that rejected them.

### The wave-1 defect this build fixes

Wave 1 attributed every harvested phrase to `row.designatorID`, the rule that matched the FEATURE.
Because a bus stop tagged `public_transport=platform` is named "Village Hall" or "West Kensington",
**108 of its 133 OSM-derived surfaces named a different record than the one they pointed at**: the
shipped artifact claimed `west → platform`, `hall → platform`, `biggin → platform`, `salon →
platform`. Attribution now runs through a phrase → record index, and the row's own designator is kept
as `context` — which is the axis a confound board needs, since a `hall` on a platform is a bus stop
and a `hall` on a terminal is a hall.

### Head nouns: what the curation pass needed before it could start

Wikidata gives the ENCYCLOPAEDIC name of a concept, not the designator as addressed. Q849706's
Spanish label is `terminal aeroportuaria`; the form on an envelope is `Terminal`. That is why wave 1
shipped 1,014 uncurated surfaces and could promote none of them — there was nothing promotable in the
table. Two derivations run before the harvest:

- **Latin script — the cognate test.** A token whose ASCII fold shares five leading characters with
  the designator's own id. `terminal aeroportuaria` → `terminal`, `letištní terminál` → `terminál`,
  `havalimanı terminali` → `terminali`. An earlier rule matched against any single-token surface of
  the record and, because Dutch `universiteit` is one, derived `universitario`, `universitaire` and
  twenty more as head nouns of `campus`. Those are the modifier half, and they would have taught the
  harvest to read "Ciudad Universitaria" as sub-venue structure.
- **Han / Kana / Hangul — the shared-substring test.** Every substring of length ≥ 2 carried by two or
  more surfaces of the same record and language, maximal-only, capped at six. `ターミナル` is in none
  of the five Japanese labels on its own — every one is a compound — and it is the form Japanese
  addresses carry. Nothing else in the pipeline can produce it, and the Japan harvest is what confirms
  it: 1,215 attestations.

Run over every non-Latin phrase instead, the second derivation produced 90 fragments of Cyrillic,
Greek, Arabic, Thai, Burmese and Tamil words — `сгра`, `κτίρ`, `ิ่งก่อสร้า` — because those languages
have one surface per concept and the only shared substrings are pieces of one word. None could ever
be counted: nothing in reach attests a Thai or Burmese surface. The derivation is scoped to the four
scripts where it works.

The harvest also gained a script-aware match. `第1ターミナル` has no word boundaries, so the
token-boundary rule that protects Latin script from `Briggate` finds nothing at all in Japanese; for
Han and Kana the match is a substring test, and the Germanic-compound objection does not transfer.

### The curation ledger

`curated: false` is still the default and nothing auto-promotes. A surface becomes curated only by
matching a decision in `sub-venue-promotions.ts`, which names a designator, a phrase AND a locale.
Per-locale because the same token is a designator in one language and a disaster in another.

Every decision below is backed by a census in that locale's own data. `real` counts occurrences in
genuine venue-interior naming; `confound` counts the rest, and the note says what the rest IS — a bare
number is not a board, and "3,273 hits" told nobody that 3,204 of them were bus stops.

| designator | phrase       | locale |  real | confound | what the confound is                                       |
| ---------- | ------------ | ------ | ----: | -------: | ---------------------------------------------------------- |
| gate       | `flugsteig`  | de-DE  |    19 |        0 | nothing — pure aviation term, no collision in German       |
| gate       | `porte`      | fr-FR  |    19 |      927 | Paris city gates and their Métro stations                  |
| hall       | `hall`       | en-GB  |     0 |    3,273 | 3,204 bus stops named after a village hall; Hall Lane/Road |
| hall       | `hall`       | en-US  | 2,095 |   27,081 | City Hall, Kingdom Hall, event halls, dormitory halls      |
| hall       | `hall`       | fr-FR  |    35 |        5 | three English `Town Hall` strings on `name:en` tags        |
| hall       | `halle`      | de-DE  |    32 |      168 | the CITY Halle (Saale) / Halle (Westf), plus village halls |
| pier       | `pier`       | en-GB  |   120 |       44 | Pier Road / Street / Avenue / Terrace — street names       |
| pier       | `pier`       | en-US  |   278 |    2,330 | Pier 1 Imports and franchises, seafood restaurants         |
| terminal   | `terminal`   | ca-ES  |    15 |        0 | nothing                                                    |
| terminal   | `terminal`   | es-ES  |   190 |        0 | nothing                                                    |
| terminal   | `terminal`   | fr-FR  |   169 |        0 | nothing                                                    |
| terminal   | `ターミナル` | ja-JP  | 1,213 |        2 | two `ターミナル前` bus stops, arguably real                |
| wing       | `wing`       | en-GB  |    23 |        6 | the Buckinghamshire village of Wing — Wing Close/Road      |
| wing       | `wing`       | en-US  |     4 |    3,354 | Red Wing boots (676), chicken-wing restaurants (759)       |
| wing       | `wing`       | fr-FR  |     0 |       26 | Wing Chun and Wing Tsun martial-arts clubs                 |

Nine promotions, six rejections. Three pairs carry the whole point of doing this per-locale: `hall` is
0-of-3,273 in Great Britain and 35-of-40 in France; `wing` is 23-of-29 in Great Britain and
4-of-3,358 in the United States; `pier` is promotable in Great Britain and not in the United States.

**The test that separates a promote from a reject is whether SHAPE can isolate the confound**, and it
is checked by enumeration rather than asserted. `halle` keeps a 168-hit confound and is promoted
because dumping all 32 `<halle> <identifier>` hits returns numbered factory, trade-fair and airport
halls — VW Halle 42, Audi GVZ Halle G, Messe West Halle 8 — and not one instance of the city of
240,000 people with the same name. `porte` has a smaller confound ratio in that bucket and is
rejected, because 17 of its 36 shape hits are Porte Saint-Martin, Porte Saint-Denis and Porte
Notre-Dame. Same test killed `pier` for en-US: Pier 1 Imports IS the designator+identifier shape.

**A caveat on `wing`, the designator the corpus task's board rests on.** 24 of its 29 Great Britain
hits sit on a `public_transport=platform`, because British bus stops are named after the hospital wing
they serve. The extractor maps no building wings at all: `aile` in France is **0 hits**, `ala` in
Spain **0**, `flügel` in Germany **0**. The en-GB evidence is a property of British stop naming rather
than of a source that has wings in it, and the localized wing surfaces the corpus task asked for are
out of reach until the extractor gains an `indoor=*` rule or the lexicon gains a hand-seeded surface
list.

**A rejection of a SHIPPED designator is advisory.** `neural/venue-structure.ts` carries a flat
English vocabulary with no locale gate, and `wing`, `terminal` and `concourse` are in it. This table
cannot un-ship them: the `wing` / en-US rejection tells a shard author which locale to leave out of a
generated line, and it does nothing to stop the span proposer firing on "Red Wing". Giving the shipped
vocabulary a per-locale gate is step 4's problem, and it is the single largest thing the shard will
want that does not exist yet.

The mechanism does hold for anything the lexicon adds. `pier` is promoted for en-GB and rejected for
en-US, and because it is not in the shipped list, the rejection has teeth: the region-free English
`pier` surface stays `curated: false` and only the 164 Great Britain attestations are marked usable.

### Identifier shapes are per-region now

`Gate A12` is a rendering, not a string anyone wrote down: all 658 Great Britain `aeroway=gate`
features but 13 are unnamed and carry only a `ref`. The table therefore carries a distribution rather
than a phrase list — and the distribution turns out to differ by country far more than the shared
vocabulary suggests, so a shard generating `Gate <ref>` for a French address has to sample France's:

| region | gate refs | most common shape      |           second | third           |
| ------ | --------: | ---------------------- | ---------------: | --------------- |
| GB     |       655 | digit 463 (71%)        | letter-digit 19% | digit-letter 8% |
| JP     |       450 | digit 402 (89%)        |  digit-letter 5% | other 3%        |
| FR     |       628 | letter-digit 385 (61%) |        digit 29% | letter 5%       |
| DE     |       642 | letter-digit 387 (60%) |        digit 18% | range 11%       |
| ES     |       493 | letter-digit 189 (38%) |        range 35% | digit 15%       |

Britain and Japan number their gates; France and Germany letter-then-number them (`A37`, `B05`); Spain
is the outlier that gives a third of its gates a RANGE (`B18-B20`, `D42-D43`), which no other country
does at that rate. A generator that samples Great Britain's 71%-bare-digit shape into a Spanish line
produces a plausible string that is wrong about Spain.

### The seed duplicates `neural/venue-structure.ts`

`@mailwoman/corpus` does not depend on `@mailwoman/neural`, so the shipped designator and modifier
lists are re-declared in `sub-venue-lexicon.ts`. That is a drift surface, and
`sub-venue-lexicon.test.ts` pins both lists literally so a change in either place fails a test rather
than passing silently. The right move is still the reverse direction: have `neural/venue-structure.ts`
read a committed lexicon slice and delete both copies.
