# Prior art: an autocomplete engine whose bones enumerate an ancestry graph

Research date: 2026-08-17. Question, verbatim in spirit: _"I'm not aware of prior art for the inner
bones of an autocomplete engine as a means to enumerate an ancestry graph"_ — is a completion
structure whose states/entries encode the containment hierarchy (so one prefix walk enumerates
lexical continuations AND admin ancestors/descendants) novel, or does it have a name?

Tags: **[S]** = search-verified this session (source in the register at the end). **[M]** = from
memory / training knowledge, not re-verified. Anything published after 2025 is flagged inline.

---

## The plain answer

Every **ingredient** has prior art and a name; the **composition** does not. Completion over a
weighted automaton with per-entry payloads is "top-k completion" (Hsu & Ottaviano, WWW 2013) and
ships in Lucene's suggest module — but every one of those systems treats the payload as an opaque
byte string handed back to the caller [S]. Materializing a place's parent chain into the index entry
so a hit returns its ancestry with zero joins is _standard shipped practice_ in geocoders —
Foursquare's twofishes (2012) is nearly an exact match for our `chain [u32;8]` (a `parentIDs:
list<i64>` on every serving feature, used at autocomplete time to render "Rego Park, Queens, NY")
[S], and Pelias, Photon, WOF, Overture, and GeoNames all denormalize the chain at index/build time
[S]. The encoding itself has textbook names: materialized path / Dewey labels [S]. Embedding
non-lexical structure _in the trie nodes_ so the walk prunes on it also has an academic name — Roy &
Chakrabarti's **"materialized trie"** (SIGMOD 2011) puts spatial summaries in trie nodes [S] — but
that is geometry, not an admin graph. What I could not find anywhere, under any name: a completion
automaton treated as the _enumeration surface for the containment graph itself_ — where the same
artifact family (FST + typed child→parent edge table + per-parent child-type distribution) answers
"what strings continue this prefix", "what contains this completion", and "what kinds of children
does this parent have" as one index discipline. The nearest practitioner art is CMS-grade
query-time joins ("show the term's parents next to the suggestion", Drupal modules) [S]; the nearest
academic art embeds geometry, not ancestry. So: not novel as parts — twofishes got 80% of the way in
2012 and nobody named it — but the unification, the PCN1 child-distribution direction, and using the
walk itself for descendant enumeration have no established name. If you need a name to cite against,
the honest construction is **"top-k completion with materialized-path payloads"**, with Roy &
Chakrabarti's "materialized trie" as the closest academically named ancestor.

---

## Area 1 — FST-with-payload completion

### Findings

- **Lucene suggest module / Elasticsearch completion suggester.** `NRTSuggester` runs top-N search
  over a weighted FST: traverse the typed prefix, then walk the n shortest (best-weighted) paths to
  collect top suggestions. The FST output format is literally
  `surface_form + PAYLOAD_SEP + payload + PAYLOAD_SEP + docID` — the payload is an uninterpreted
  byte string concatenated into the arc output [S]. `ContextSuggestField` adds contexts by joining
  the context value to the suggest value with a `CONTEXT_SEPARATOR` — i.e., contexts are encoded
  into the _key space_ (prefix position) so `ContextQuery` can filter/boost at query time [S].
- **Elasticsearch geo context**: a completion entry's geo context is encoded as a **geohash prefix**
  (precision 1–12, default 6) baked into the index; matching is tile membership, not distance [S].
  This is the one mainstream case of a _containment hierarchy living inside the completion
  automaton's key bytes_ — geohash prefixes nest, so a coarser cell is literally a prefix of a finer
  one. But it is (a) spatial cells, not admin ancestry, and (b) a filter key, never an enumerated
  output — the suggester never _returns_ the cell chain.
- **BurntSushi `fst` crate**: keys map to `u64` values; "outputs are stored along the path such that
  the correct value is returned when all outputs are summed" [S]. Output composition is algebraic
  (sums over paths), which is what makes prefix-sharing of values possible — and also why the value
  type is a number, not a structure. Payload semantics are entirely the caller's problem. Tantivy
  uses it exactly that way: FST maps term → TermOrdinal, a side table maps ordinal → posting-list
  offset [S]. Opaque again.
- **marisa-trie / LOUDS lineage**: MARISA is a Patricia trie whose edge labels are themselves stored
  in another Patricia trie, recursively, in LOUDS bit-vector form [S]. Mozc (Google Japanese IME)
  uses a LOUDS trie for its dictionary [S]. The recursion here is _lexical self-compression_ — a
  trie of tries over strings — not semantic hierarchy. Nobody in this lineage stores a domain graph
  in the structure.
- **Top-k completion structures** (Hsu & Ottaviano, WWW 2013): RMQ trie, completion trie,
  score-decomposed trie — the canonical names for "trie + static score + top-k walk" [S]. Scores
  only; no structured payloads.

### Verdict

**Covers:** the entire completion mechanic — weighted prefix walk, top-k expansion, even
per-entry payload transport (Lucene) and hierarchy-shaped _key prefixes_ (ES geo context).
**Does not cover:** any system that _interprets_ the payload as graph edges and walks it. Payloads
are cargo, contexts are filters, outputs are sums. The `chain [u32;8]`-as-traversable-ancestry has
no counterpart in this family.

---

## Area 2 — Geocoding autocomplete architectures

### Carmen (Mapbox)

- Primary source: carmen-cache README (repo still up; **mapbox/carmen itself has been deleted from
  GitHub** — README recovered via the npm registry) [S].
- Index: keys (normalized phrases) → "grids", 64-bit packed tuples of (score, relevance, x, y,
  feature id). Autocomplete = `getMatching` with prefix mode; RocksDB layout precomputes merged grid
  lists for all prefixes of length 3 and 6 (`=1`/`=2` bins) to make short-prefix autocomplete cheap
  [S]. Older carmen generated "degens" (degenerate prefixes) at index time — the changelog entry
  "do not generate degens for feature synonyms" confirms the mechanism and its name [S]; later
  replaced by the fuzzy-phrase Rust crate [M].
- Ancestry: **computed at query time, spatially.** `coalesce` stacks phrase matches across separate
  per-placetype indexes (country, region, place, …) by testing whether their tile covers overlap —
  "Paris" grids align with "France" grids [S]. The returned context chain is the byproduct of
  spatial stacking plus a reverse-context lookup, not a stored chain. Language handling: per-key
  128-bit language annotation bitmask, penalty for cross-language matches [S] — a coarse word-role
  lens, per key not per role.

### Pelias

- The ES document schema materializes the full parent chain at index time as flat fields:
  `parent.continent/_a/_id/_source`, `country`, `dependency`, `macroregion`, `region`,
  `macrocounty`, `county`, `localadmin`, `locality`, `borough`, `neighbourhood`, `postalcode`,
  `ocean`, `marinearea`, `empire` — each with abbreviation, WOF id, and source variants [S].
  Populated by the `wof-admin-lookup` point-in-polygon service during import [S]. Autocomplete is ES
  analyzer implementation over these fields; admin boosting is query-time scoring over the materialized
  names [M].

### Photon (Komoot)

- Now OpenSearch-based; planet DB ~95 GB as of 2026 [S — post-2025 datum]. `PhotonDoc` carries
  `addressParts: Map<AddressType, Map<String,String>>` plus a `ContextMap context` — parent names
  copied out of Nominatim's address hierarchy into every document at import [S]. Same family as
  Pelias: materialize at index time, flat bag, no ids-as-graph.

### Nominatim

- `place_addressline` cross-references _for each place all the places that make up its address_ —
  a materialized ancestor table (closure-table shape, one row per (place, ancestor), with
  `fromarea`/`isaddress` flags), built in rank order at index time [S]. Query-time address output
  walks this table. `nominatim-suggest` (GSoC) exports placex+addresslines into Elasticsearch;
  each suggestion carries its full pre-built address string [S]. So Nominatim is _also_
  materialize-at-index-time — the join is precomputed, just stored relationally rather than inline.

### Google Places Autocomplete

- The public contract returns `terms[]` (the description split into components with offsets — for a
  place prediction this reads as name-then-ancestry), `types[]`, `structured_formatting`
  (main_text/secondary_text) [S]. **Nothing public documents how it is indexed or whether the
  ancestry is stored or joined**; no engineering paper found. Verdict: its `terms` array is a
  returned ancestry as display strings; internals unknowable from open sources.

### Algolia Places (retired May 2022)

- OSM-based; records carried an `administrative` field (admin names denormalized into the record),
  ranking admittedly not tuned for admin search; Algolia sunset it citing quality [S]. Same
  materialize-into-record family.

### Foursquare twofishes — the closest shipped prior art

- Coarse splitting geocoder over GeoNames: _"In one pass, we can build a database where each entry
  is a feature with a list of names for indexing, names for display, and a list of parents"_ [S].
  The thrift schema has `ScoringFeatures.parentIDs: list<i64>` on every serving feature, response
  options `PARENTS` / `PARENT_ALL_NAMES`, and a comment: _"controls if we should fetch parents to
  construct a string like 'New York, NY'"_ [S]. Autocomplete mode returns highlighted names and
  uses the parent lists for display and containment during scoring [S]. This is a per-entry
  materialized parent-id chain inside a geocoder's autocomplete index — 2012, GeoNames-shaped,
  never named as a technique. Differences from ours: ids point into a feature store (one indirection
  per ancestor, not zero); chain is variable-length list, not fixed-slot; no typed edge/label
  sidecars; project dormant.

### Verdict

**Covers:** materializing parent chains at index time is the dominant shipped pattern (Pelias,
Photon, Nominatim, Algolia, twofishes; WOF/Overture upstream). Query-time derivation exists too
(Carmen — spatial stacking). Twofishes specifically covers "every autocomplete hit carries its
ancestry." **Does not cover:** putting the chain _in the automaton's own value bytes_ (everyone
else joins against a feature store or flattens names into fields); typed placetype edges (PIX1) and
per-parent child-type distributions (PCN1) as first-class index siblings; ranking the enumeration by
a population-anchored referential score (twofishes has `population`+`boost`, coarser).

---

## Area 3 — Academic location-aware type-ahead & KG entity suggest

- **Roy & Chakrabarti, SIGMOD 2011** ("Location-aware type ahead search on spatial databases:
  semantics and efficiency"): the foundational instant-spatial-query paper. Their index is literally
  called the **materialized trie (MT)**: "MT uses trie as the main index structure, and incorporates
  spatial information into the node of trie" for spatial pruning during the prefix walk [S]. This is
  the closest _named_ academic idea to "hierarchy in the completion structure's bones" — but the
  material embedded is geometric summaries, and the purpose is pruning, not enumeration of an admin
  graph. **Does not cover** admin ancestry at all.
- **IR-tree family** (and R*-IF, KR*-tree, WIR-tree, LBAK-tree, S2I, IL-Quadtree): R-trees whose
  nodes carry pseudo-document/inverted-file summaries for top-k spatial-keyword queries [S]. Spatial
  containment (MBR nesting) is in the structure; admin containment never is.
- **TASK, VLDB 2023** (Gao et al.): instant error-tolerant spatial keyword on road networks —
  the current state of that line; still trie × geometry [S].
- **QAC literature**: Cai & de Rijke's 2016 QAC survey and successors treat completion ranking,
  personalization, spatial bias — no hierarchy-graph enumeration [M].
- **KG entity type-ahead**: Wikidata's `wbsearchentities` returns id, label, description, matched
  alias, score — description is prose disambiguation, not a chain; no P131 (admin ancestry)
  materialization [S]. DBpedia Lookup returns ranked resources with ontology **classes** attached
  and supports `QueryClass` filtering [S] — completions carrying _type_ ancestry (rdf:type up the
  ontology), the closest KG analog, but type hierarchy ≠ containment hierarchy and it's a filter/
  decoration, not an enumerable graph. Freebase-era suggest widgets returned "notable type" one-line
  disambiguation [M]. The old Wikidata Entity Suggester recommends _properties_ (statistical
  co-occurrence), unrelated [S].
- Post-2025 flag: **C², cache-conscious succinct tries with adaptive unary path compression, arXiv
  2606.16104 (June 2026)** — succinct-trie engineering continues, still purely lexical [S].

### Verdict

**Covers:** trie-walk pruning by non-lexical per-node material (materialized trie — the name to
cite); completions decorated with class/type info (DBpedia). **Does not cover:** any fusion of a
completion trie with a _containment/ancestry graph_ (as opposed to geometry), in either direction.
I found no paper on that specific fusion — this is the strongest support for the operator's novelty
instinct.

---

## Area 4 — Ancestry-lookup encodings, and containment inside ranking

### The encodings and their names

- **Materialized path / fixed-slot chain** (what `chain [u32;8]` is): the Dewey / DeweyID / ORDPATH
  family from XML databases — "prefix-based numbering is also called containment encoding"; ancestry
  decided by prefix/byte comparison; ORDPATH adds insert-friendliness via careting [S]. Fixed-slot
  (one column per level) is the degenerate flat version: GeoNames' admin1–admin4 code columns [S],
  Pelias `parent.*` [S], WOF's `wof:hierarchy` (an array of ancestor-id maps materialized in every
  record; note WOF allows _multiple_ hierarchies per place — it's a DAG, not a tree) [M], Overture
  divisions: `parent_division_id` plus a materialized `hierarchies` field; division_area "repeats
  the subtype, names, country, and region properties of the division it belongs to" [S]. Overture
  added division admin-level surfacing to its API in July 2026 [S — post-2025].
- **Interval / nested-set labeling**: pre/post-order intervals (Dietz 1982 [M]; nested set model
  [S]): O(1) containment test both directions (`x inside y` ⟺ interval containment), descendant
  enumeration = contiguous range scan; the classic cost is relabeling on update [S].
- **GRAIL** (Yildirim, Chaoji, Zaki, VLDB 2010): randomized _multiple_ interval labels per node for
  reachability on large **DAGs** — constant-time negative answers, fallback search on positives;
  linear index size [S]. The right tool the moment the hierarchy is honestly a DAG (WOF multiple
  hierarchies, disputed territories).
- **Closure table**: one row per (ancestor, descendant [, depth]) [S]. Nominatim's
  `place_addressline` _is_ a closure table with per-edge flags (`fromarea`, `isaddress`) [S].

### What shipped geo systems actually use

Uniformly the materialized-path/fixed-slot family (GeoNames columns, WOF/Overture arrays, Pelias
flat fields, twofishes id lists, Nominatim closure rows). I found **no shipped geocoder using
nested-set/interval labels or GRAIL-style labels** — the update-fragility reputation plus
tree-vs-DAG mismatch presumably killed it, even though read-only sealed artifacts (our situation)
neutralize the update cost entirely.

### Containment inside candidate ranking

- Carmen's `coalesce` _is_ a containment check at rank time — approximate spatial containment via
  tile-cover overlap, threaded through candidate stacking [S].
- Twofishes uses parent lists during autocomplete/geocode interpretation scoring and response
  assembly [S].
- Toponym-resolution literature does containment-in-ranking explicitly: Leidner's thesis (2007)
  heuristics; **spatial minimality**; GeoTxt's hierarchy heuristics ("if a containment relationship
  toward the same geographic space is shared by two toponyms") and Spatial-Hierarchy Sets built on
  containment + sibling relations [S]. So "check ancestry congruence while scoring candidates" is
  established in geoparsing — as heuristics over gazetteer lookups, never as an O(1) label
  comparison inside a completion walk.

### Verdict

**Covers:** every encoding option is named and characterized; containment-during-ranking is
established in both shipped geocoders (spatial form) and geoparsing research (hierarchy form).
**Does not cover:** doing the congruence check with O(1) interval labels _inside_ an autocomplete /
candidate ranker — the literature does joins or geometry. The encoding trade-off for candidate.db is
a genuine open design choice; see "What to borrow."

---

## Area 5 — Word-role lensing across languages

- **GeoNames alternateNames**: per-name ISO-639 code **plus role flags** — `isPreferredName`,
  `isShortName`, `isColloquial`, `isHistoric`, and pseudo-language codes `post` (postal), `iata`/
  `icao`/`faac`, `abbr`, `link`, `fr_1793` [S]. This is the most role-articulate open gazetteer
  name model — yet it still has **no "translation-gloss, not a name" flag**; a Hungarian `Tó` row
  on Lake County is representable and indistinguishable from a genuine Hungarian exonym.
- **WOF names**: BCP-47/RFC 5646 with privateuse tags inherited from Yahoo GeoPlanet's single-letter
  types — `x_preferred`, `x_variant` ("well-known unofficial variant"), `x_colloquial` ("Big
  Apple", also accent-stripped forms), plus abbreviation type A ("NYC") [S]. The docs do not address
  distinguishing translations of common nouns from actual names [S] — and the MCP romp measured the
  consequence: 364 `names` rows on Lake County MN, all dictionary translations of "lake", all
  shaped exactly like legitimate alias rows (that's WOF/GeoPlanet inheritance, not our bug).
- **OSM's editorial answer**: the Names / Multilingual-names policy _bans the data_ rather than
  modeling it — `name:*` must be names in actual use; bulk imports of transliterations from
  Wikipedia and "manufactured" names not in regular use are explicitly listed as things to avoid
  [S]. So the one ecosystem that "handles" glosses handles them by exclusion, upstream of any
  index — the same doctrine as our FST curation, applied at the data layer.
- **libpostal**: per-language dictionary _files as role tables_ — `street_types.txt`,
  `stopwords.txt`, `directionals`, `honorifics`, `venue types`, `ambiguous_expansions.txt` ("E" →
  East or E Street) — with per-entry canonical expansions [S]. This is surface→role-per-language,
  the exact shape a word-role table needs, but it covers address _vocabulary_, not toponym alias
  roles.
- **Japanese**: Geolonia's normalize-japanese-addresses parses 都道府県/市区町村/町丁目 levels via
  regex + its own canonical address data, handling prefecture-suffix variants and completing
  omitted prefectures when a city name is ambiguous across prefectures [S]. Mozc-lineage IMEs put
  the whole reading→surface dictionary in LOUDS tries [S]. Role-conditioning on script/position
  (都 as suffix of 東京都) is done by rule inside these parsers, never modeled in a gazetteer index.
- **Folding hazards**: ICU folding (UTR#30) is deliberately locale-blind; Turkic I/ı needs
  Turkish-specific case mapping (`foldTurkic` exists separately in ICU) — ES/OpenSearch docs and
  CirrusSearch carve Turkish out by hand [S]. Carmen's per-key 128-bit language bitmask with
  cross-language penalties [S] is the only autocomplete-index-level language lens found — key-level,
  not role-level.

### Verdict

**Covers:** per-name language+role _flags_ (GeoNames, WOF) and per-language surface→role
_dictionaries_ (libpostal); editorial exclusion of glosses (OSM); rule-based suffix-role handling
(Japanese parsers). **Does not cover:** any system that explicitly models "this surface is a
translation-gloss of a common noun, not a referring name" as a machine-readable role, or that
conditions index membership on it. The role-lens table (surface × language/script → role) has
assembled precedents but no existing instance. The `to` defect class is unmodeled everywhere; the
anomaly signal we measured (221 keys on a 63-person neighbourhood) appears to be novel as a
discriminator.

---

## Area 6 — The bidirectional question (what can PRECEDE a token)

- **Suffix automata / DAWGs**: the minimal automaton of all suffixes of a string (or string set —
  generalized/suffix automaton of a trie) answers "is this a factor" and, walked on the _reverse_
  automaton, "what can precede this factor"; Blumer et al. / Crochemore lineage, linear size [S].
- **Factor automata of automata** (Mohri, Moreno, Weinstein): factor automaton built over an
  entire _automaton's_ language — the full substring index of a weighted set of strings, with size
  bounds; deployed for music identification over 15k+ songs [S]. This is the industrial-strength
  named structure for "enter anywhere in the phrase" — and it is exactly what ASR contextual
  biasing compiles bias phrases into (shallow-fusion biasing FSTs, scores interpolated during beam
  search; Google patents + 2024–2025 papers; still active — Nature Sci Rep 2025 on adaptive context
  biasing, arXiv 2505.23077 (2025) on dynamic vocabulary prediction [S — post-2024 items flagged]).
  Our FST-curation doctrine already cites this lineage; the _bidirectional_ half of it (suffix side)
  is sitting unused.
- **Reversed-token indexing**: Lucene `ReverseStringFilter` / Solr `ReversedWildcardFilterFactory` —
  index `country` as `yrtnuoc` (with marker) so leading-wildcard becomes trailing [S]. The dumb,
  proven trick for "match from the right." A reversed _word-token_ FST (tokens reversed, not
  characters) is the same trick one level up; no named instance found at word level over a
  gazetteer.
- **AnalyzingInfixSuggester** (Lucene, McCandless 2013): abandons the FST entirely — indexes each
  token position so the query prefix can match _any token_, i.e., solves "user typed a middle word"
  by inverted index rather than automaton [S].
- **Carmen**: forward-only. Degens/prefix bins expand _rightward_; a query token matches a phrase
  only from its start (subquery permutation bitmasks handle word order at the multi-index level,
  not within a phrase) [S/M]. No before-direction structure.
- **Published gazetteer word-adjacency indexes** (the PIX1 shape — (child-word, parent-word) →
  typed edge): **none found** under any framing tried (gazetteer bigram index, place-name
  collocation index, word adjacency gazetteer). The nearest things are n-gram language models over
  query logs in QAC [M] and the factor-automaton family above, neither of which types the edge.

### Verdict

**Covers:** the _mechanics_ of leftward/anywhere entry are thoroughly named — suffix automaton,
factor automaton, reversed-token index, infix suggester. Pick one and cite it. **Does not cover:**
adjacency with _typed placetype semantics_ on the edge (PIX1's (surface, surface) → edge-type is a
gazetteer-semantic object, not a stringological one). The before-direction enumeration ("what can
precede 'york'") is prior art; "what can precede it _and what containment relation does that
predecessor stand in_" is not.

---

## What to borrow — mapped onto the three open gaps

### Gap 1: the word-role table (the `to` defect)

- **Borrow GeoNames' flag vocabulary as the schema floor** [S]: per (surface, language) —
  preferred / short / colloquial / historic / abbr / postal / code — then add the one role nobody
  has: `gloss` (translation of a common noun, non-referring). GeoNames proves per-name role flags
  scale to a world gazetteer; WOF privateuse tags map onto the same set losslessly.
- **Borrow libpostal's file shape** [S]: per-language role dictionaries are already in
  `core/data/libpostal/dictionaries/` and already drive FST curation; the role table is the same
  artifact generalized from address vocabulary to alias roles. One table, keyed
  (folded-surface, lang/script) → role set; the FST/candidate builders consume it exactly as the
  curation pass consumes stopwords today.
- **Borrow OSM's posture for the build** [S]: glosses are excluded _from bias/candidate keys_ at
  build time (not guarded at decode time) — which is our existing curation doctrine; the role table
  is its data backbone. Populate `gloss` from the measured anomaly signal (key-count vs prominence
  mismatch — 221 keys / pop 63) plus the WOF tell we already observed: a names-row set that spans
  100+ languages with per-language _different_ surfaces on a low-prominence place is a dictionary,
  not an alias set. No prior art models this; it is ours to name.
- Carmen's per-key language bitmask [S] is the cheap runtime half worth copying: keep a language
  mask per FST place entry so a locale-hinted query can penalize out-of-locale role hits without a
  table lookup.

### Gap 2: before-direction adjacency (what precedes a token)

- The named structure to cite (and the cheapest to build honestly): a **reversed word-token FST**
  over the same normalized token streams — the `ReverseStringFilter` trick at word granularity [S],
  which for multi-token names is equivalent to a suffix-trie restricted to token boundaries. Build
  it with the existing fst-builder by feeding reversed token sequences; `walk(["york"])` on it
  enumerates predecessors ("new", "west", …) with the same BFS implementation.
- If "enter at any token" is wanted (not just last-token-known), the named upgrade is the **factor
  automaton of the name set** (Mohri et al.) [S] — the ASR-biasing lineage the FST curation header
  already cites; but note AnalyzingInfixSuggester [S] as the precedent that an inverted index on
  token positions can beat an automaton here on implementation cost.
- PIX1 already _is_ the typed-adjacency answer at the (child-name, parent-name) level; the research
  found no published counterpart, so there is no external design to converge toward — document it
  as its own thing. The before-direction FST and PIX1 answer different questions (string
  adjacency vs containment edge) — keep them separate artifacts; the Weimar-class confusion comes
  from letting one impersonate the other.

### Gap 3: candidate.db ancestors encoding — fixed-slot chain vs interval labeling

- **Keep the fixed-slot chain for the read path.** Every shipped geocoder that works this way
  (twofishes, Pelias, Photon, WOF, Overture, GeoNames) validates it [S]; it gives O(1) "who is my
  level-k ancestor" which interval labels cannot, and it round-trips through the FST place entry
  unchanged.
- **Add a pre/post interval pair (two u32s) per place at seal time** over the primary hierarchy.
  This buys the two things the chain is bad at: O(1) `is X inside Y` in the ranker _without
  scanning 8 slots or knowing Y's level_ (nested-set containment test [S]), and descendant
  enumeration as a contiguous range scan (`WHERE pre BETWEEN y.pre AND y.post`) — which is the
  candidate-table analog of the FST's BFS-descendants and what a "constrain to region" candidate
  probe wants. The textbook objection — relabeling on update [S] — is void here: our databases are
  sealed read-only artifacts rebuilt whole (house doctrine), which is precisely the regime interval
  labeling was always safe in. Nobody in shipped geo appears to have done this; the toponym
  literature's containment heuristics [S] say the check earns its place in ranking.
- **The DAG caveat decides the fallback.** WOF places can carry multiple hierarchies [M] and
  Overture keeps `hierarchies` plural [S]. A single interval pair encodes one tree. Policy:
  intervals over the _primary_ hierarchy (what the chain already commits to); if cross-hierarchy
  reachability ever becomes required (disputed territories), GRAIL's multiple randomized
  interval labels [S] is the named, linear-size upgrade — do not invent one.
- Nominatim's `place_addressline` [S] is the argument _against_ a closure table for us: it is the
  biggest table in their schema for a capability the chain+interval combination gives in 40 bytes
  per row.

---

## Claims register

Search-verified [S]:

1. Lucene NRTSuggester = top-N over weighted FST; payload format `surface|payload|docID`, opaque — Lucene suggest docs/PR trail.
2. ContextSuggestField joins context to suggestion via CONTEXT_SEPARATOR; ContextQuery filters/boosts — Lucene 10 javadoc.
3. ES completion geo context = geohash-encoded, precision tiles, prepended into index — Elastic docs.
4. fst crate: u64 outputs summed along paths; Tantivy: FST → TermOrdinal → TermInfo indirection — BurntSushi blog/README, tantivy docs.
5. MARISA = recursive Patricia-in-Patricia via LOUDS; Mozc dictionary uses LOUDS trie — marisa docs, ACL W11-3503.
6. Carmen: keys→packed grids; prefix `getMatching` + precomputed length-3/6 prefix bins; coalesce = query-time spatial stacking; per-key 128-bit language mask; "degens" existed at index time — carmen-cache README (primary), carmen changelog. mapbox/carmen repo itself now deleted (gh api 404); README recovered via npm registry.
7. Pelias: full `parent.*` fixed-slot fields (name/_a/_id/_source per placetype) in the ES mapping; populated via wof-admin-lookup PIP at import — pelias/schema mappings/document.js (primary).
8. Photon: PhotonDoc carries addressParts map + ContextMap, filled from Nominatim at import; OpenSearch; ~95 GB planet (2026) — komoot/photon source + README (primary).
9. Nominatim: place_addressline = per-place materialized ancestor rows with fromarea/isaddress; built in rank order — Nominatim dev docs. nominatim-suggest exports prebuilt addresses to ES — its README.
10. Google Places Autocomplete: terms[]/types[]/structured_formatting public contract; internals not public — Google docs.
11. Algolia Places: OSM-based, administrative field in records, retired May 2022, quality-cited — Algolia sunset post, docs.
12. Twofishes: per-feature `parentIDs: list<i64>`, PARENTS/PARENT_ALL_NAMES response options, "construct a string like 'New York, NY'", one-pass build "feature with … a list of parents" — geocoder.thrift + README (primary).
13. Roy & Chakrabarti SIGMOD 2011: index named "materialized trie", spatial info in trie nodes for pruning — ACM DL/MSR page + TASK (VLDB 2023) related-work characterization.
14. IR-tree family = R-tree nodes + textual summaries; TASK VLDB 2023 current — EDBT/VLDB papers.
15. Hsu & Ottaviano WWW 2013: RMQ trie / completion trie / score-decomposed trie — the "top-k completion" name — paper.
16. wbsearchentities returns id/label/description/matched alias/score, no ancestry — MediaWiki API docs. DBpedia Lookup returns classes + QueryClass filter — dbpedia/lookup.
17. GRAIL = randomized multi-interval reachability labels for large DAGs, VLDB 2010 — paper. ORDPATH/Dewey = "containment encoding", byte-comparable ancestry — ORDPATH paper. Nested set / closure table trade-offs — standard DB sources.
18. Leidner spatial minimality; GeoTxt containment heuristics; Spatial-Hierarchy Sets — geoparsing literature.
19. GeoNames alternateNames: isPreferredName/isShortName/isColloquial/isHistoric + abbr/link/post/iata pseudo-langs; admin1–4 code columns — geonames readme.txt.
20. WOF names: RFC 5646 with x_preferred/x_variant/x_colloquial privateuse (GeoPlanet lineage); docs silent on gloss-vs-name — whosonfirst.org/docs/names.
21. OSM Names policy: avoid manufactured transliterations/translations not in actual use; name:* = names actually used — OSM wiki.
22. libpostal: per-language dictionaries with typed files (street_types, stopwords, ambiguous_expansions…) — repo + Mapzen "Inside Libpostal".
23. normalize-japanese-addresses: pref/city/town levels, prefecture completion on ambiguity — Geolonia repo.
24. ICU folding locale-blind; Turkic I/ı needs dedicated handling (foldTurkic separate) — Elastic/OpenSearch/ICU docs.
25. Suffix automaton = minimal automaton of suffixes, appliable to tries; factor automata of automata (Mohri et al.), music-ID scale — TCS/Springer/NYU.
26. ASR contextual biasing = bias-phrase FSTs, shallow fusion; active through 2025 (Nature Sci Rep 2025; arXiv 2505.23077) — patents + papers.
27. ReverseStringFilter/ReversedWildcardFilterFactory = reversed-token leading-wildcard trick — Lucene javadoc, Solr posts.
28. AnalyzingInfixSuggester: no FST, token-position index, any-token prefix — McCandless blog, javadoc.
29. Overture divisions: parent_division_id + materialized `hierarchies`; division_area repeats parent names; admin-levels in API July 2026 — Overture docs/blog. (Post-2025 items: this, C² arXiv 2606.16104, photon 2026 sizing, 2025 ASR papers.)
30. CMS-land "hierarchical autocomplete" = query-time joins showing term parents (Drupal modules, ES forum thread) — no completion-structure encoding anywhere.

From memory [M], not re-verified this session:
a. Carmen degens superseded by fuzzy-phrase crate (repo deleted; changelog fragments only).
b. WOF `wof:hierarchy` = array of ancestor-maps per record, multiple hierarchies allowed (DAG) — well-established WOF schema knowledge; docs page not re-fetched.
c. Pelias autocomplete admin boosting details; QAC survey (Cai & de Rijke 2016); Freebase suggest "notable type"; Dietz 1982 pre/post-order labeling; twofishes prefix index storage (Mongo/HFile).
d. Google Places internals genuinely undocumented (absence-claim: no public source found — consistent with search, but absence is unprovable).

## Primary sources (the ones worth re-opening)

- carmen-cache README — https://github.com/mapbox/carmen-cache (grid/coalesce/prefix-bin design)
- twofishes — https://github.com/foursquare/twofishes (README + interface/src/main/thrift/geocoder.thrift)
- Pelias mapping — https://raw.githubusercontent.com/pelias/schema/master/mappings/document.js
- Photon — https://github.com/komoot/photon (PhotonDoc.java)
- Nominatim DB layout — https://nominatim.org/release-docs/latest/develop/Database-Layout/
- Roy & Chakrabarti — https://dl.acm.org/doi/10.1145/1989323.1989362 ; characterized via TASK, https://www.vldb.org/pvldb/vol16/p2418-gao.pdf
- Hsu & Ottaviano — http://groups.di.unipi.it/~ottavian/files/topk_completion_www13.pdf
- GRAIL — http://www.cs.rpi.edu/~zaki/PaperDir/VLDB10.pdf ; ORDPATH — http://www.cse.iitb.ac.in/infolab/Data/Courses/CS632/2007/Papers/ordpath.pdf
- BurntSushi — https://burntsushi.net/transducers/
- Lucene suggest — https://lucene.apache.org/core/10_3_1/suggest/org/apache/lucene/search/suggest/document/package-summary.html ; infix — https://blog.mikemccandless.com/2013/06/a-new-lucene-suggester-based-on-infix.html
- Factor automata — https://cs.nyu.edu/~mohri/pub/fac.pdf
- GeoNames readme — http://download.geonames.org/export/dump/readme.txt ; WOF names — https://whosonfirst.org/docs/names/ ; OSM Names — https://wiki.openstreetmap.org/wiki/Names
- libpostal — https://github.com/openvenues/libpostal (resources/dictionaries) ; https://www.mapzen.com/blog/inside-libpostal/
- Geolonia — https://github.com/geolonia/normalize-japanese-addresses
- Overture divisions — https://docs.overturemaps.org/schema/reference/divisions/division/ ; https://docs.overturemaps.org/guides/divisions/
- Leidner thesis — https://era.ed.ac.uk/handle/1842/1849
- ES suggesters — https://www.elastic.co/guide/en/elasticsearch/reference/current/search-suggesters.html
- Algolia sunset — https://www.algolia.com/blog/product/sunsetting-our-places-feature ; Geocode Earth on it — https://geocode.earth/blog/2022/algolia-places-sunset/
