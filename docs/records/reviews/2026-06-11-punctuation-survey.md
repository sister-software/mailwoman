# How other geocoders handle punctuation — a survey (2026-06-11)

Discovery document for the "more punctuation logic" design work. Context: mailwoman currently
handles punctuation via a decode-side span bridge (merges same-tag fragments across short
punctuation gaps) and is moving to char-offset labels (v0.5.0) that make punctuation
supervisable. The 120-row punctuation-stress eval
(`data/eval/external/punctuation-stress.README.md`) shows our weak quadrants: **bracketed
annotations** (v0 rules beat neural by 13.9), **bare-slash unit designators** (v0 +13.0), and
**dotted abbreviations** (neural +3.6 — narrow, and the adjacent apostrophe class is v0 +8.9).

Survey method: source code, official docs, and issue trackers of libpostal, Pelias, Nominatim,
and Photon, plus public docs of commercial geocoders and the OSM address-data conventions.
Claims read directly from source are marked as such; where documentation is thin, that is said
outright rather than papered over.

---

## 1. libpostal

**Pipeline.** The tokenizer is a TR-29 lexer that emits typed tokens — including punctuation
types (`COMMA`, `HYPHEN`, `DASH`, `SEMICOLON`, `PERIOD`, `COLON`, `PUNCT_OPEN`, `PUNCT_CLOSE`)
([github.com/openvenues/libpostal](https://github.com/openvenues/libpostal),
[mapzen.com/research/inside-libpostal](https://www.mapzen.com/research/inside-libpostal/)). Before the
CRF, the input string gets NFC compose + lowercase + simple Latin-ASCII
(`ADDRESS_PARSER_NORMALIZE_STRING_OPTIONS` in `src/address_parser.h`), and each token gets
`NORMALIZE_TOKEN_DELETE_FINAL_PERIOD | NORMALIZE_TOKEN_DELETE_ACRONYM_PERIODS |
NORMALIZE_TOKEN_REPLACE_DIGITS`
([src/address_parser.h](https://github.com/openvenues/libpostal/blob/master/src/address_parser.h)).

**(a) Does punctuation survive?** Partially — and this is the most interesting finding of the
survey. Read directly from `address_parser_parse` in
[src/address_parser.c](https://github.com/openvenues/libpostal/blob/master/src/address_parser.c):
separator-class tokens (`COMMA`, `NEWLINE`, `HYPHEN`, `DASH`, `BREAKING_DASH`, `SEMICOLON`,
`PUNCT_OPEN`, `PUNCT_CLOSE`) are **dropped from the token sequence but recorded in a parallel
`separators` array** (`ADDRESS_SEPARATOR_FIELD_INTERNAL`) that feeds the CRF's feature
function. The training-data format has matching `SEP`/`FSEP` labels (`SEPARATOR_LABEL` /
`FIELD_SEPARATOR_LABEL` in the header). So the folk claim that "libpostal ignores commas"
(repeated in Pelias's own README) is wrong in an instructive way: commas never appear as
_labelable tokens_, but they survive as _boundary features_ the model conditions on.
`PERIOD`, `COLON`, and invalid chars, by contrast, are in `ADDRESS_PARSER_IS_IGNORABLE` and
vanish without a trace.

**(b) Paired delimiters.** No pairing logic. `PUNCT_OPEN` and `PUNCT_CLOSE` each independently
set the same separator bit — a parenthesized annotation is flattened to "a field boundary
happened here, twice," and its content stays inline in the label sequence.

**(c) Hyphens and slashes.** Hyphenated words get per-subword features: a loop over
`string_next_hyphen_index` emits a feature for each constituent word that is in vocabulary
(`address_parser.c` around line 1379; confirmed in Al Barrentine's write-up:
"For hyphenated words … there's a new feature for each distinct word in the hyphenated phrase"
— [Statistical NLP on OpenStreetMap part 2](https://medium.com/@albarrentine/statistical-nlp-on-openstreetmap-part-2-80405b988718)).
Free-standing hyphens between tokens become separator features. Slashes have no dedicated
handling in the parser. The expand/normalize API exposes punctuation policy as explicit flags
the caller multiplies variants over: `LIBPOSTAL_NORMALIZE_TOKEN_REPLACE_HYPHENS`,
`DELETE_HYPHENS`, `DELETE_FINAL_PERIOD`, `DELETE_ACRONYM_PERIODS`, `DROP_ENGLISH_POSSESSIVES`,
`DELETE_OTHER_APOSTROPHE`, `REPLACE_NUMERIC_HYPHENS`
([src/libpostal.h](https://github.com/openvenues/libpostal/blob/master/src/libpostal.h)) —
i.e. for _matching_, libpostal's answer is "emit every variant," not "pick the right one."

**Training data.** Generated from OSM/OpenAddresses via the OpenCage address-formatting
templates, which include each country's native separators; the stated goal was that the parser
should handle input "potentially without the commas"
([Inside Libpostal](https://www.mapzen.com/research/inside-libpostal/)). The parser trains on
multiple surface variants (accents kept, stripped, transliterated) rather than one canonical
form ([part 2](https://medium.com/@albarrentine/statistical-nlp-on-openstreetmap-part-2-80405b988718)).
Exact separator-dropout probabilities are not documented; inferred from the issue record below,
slash-form sub-premises are under-represented.

**(d) Issue-tracker lessons.**

- [#255 "Using field separators to increase parsing accuracy"](https://github.com/openvenues/libpostal/issues/255)
  (open, no maintainer reply): "100 Queens Road Central, Hong Kong" vs "100 Queens Road,
  Central Hong Kong" — users perceive their commas as being thrown away. The separator
  _feature_ exists but is evidently too weak to disambiguate, and there is no API to assert a
  boundary.
- [#405 "Input delimiters are ignored"](https://github.com/openvenues/libpostal/issues/405)
  (open): same complaint class, still unresolved years later.
- [#573 "Improving flat number detection"](https://github.com/openvenues/libpostal/issues/573):
  "FLAT 6-20" parsed into house_number, "Flat 2/19" works only in some positions — the
  hyphen/slash sub-premise quadrant, failing for the same reason ours does (the designator
  vocabulary is in dictionaries, but the punctuated identifier shape was never supervised).
- [#125 "Suite/Apartment parsing is not correct"](https://github.com/openvenues/libpostal/issues/125):
  unit-vs-house-number confusion predates the 1.0 `unit` label.

**Takeaway.** Punctuation-as-feature (not as token) is a real, shipped mechanism — but
feature-only punctuation with no boundary API and no paired-delimiter structure leaves a
persistent residue of open issues exactly in our two v0-win quadrants.

## 2. Pelias

**pelias/parser tokenizer.** Read directly from
[tokenization/split_funcs.js](https://github.com/pelias/parser/blob/master/tokenization/split_funcs.js)
and [tokenization/Tokenizer.js](https://github.com/pelias/parser/blob/master/tokenization/Tokenizer.js):

- **Sections** split on `\n`, `\t`, `,`, and _any_ character from a long quote list
  (`"«»‘’‚‛“”„‟‹›⹂「」『』〝〞〟﹁﹂﹃﹄＂＇｢｣`). The code carries the comment
  "@todo: this should ideally only work for 'matching pairs' of quotes" — i.e. **pair-matching
  was never built**; a single stray quote splits the input.
- **Words** split on whitespace, then a second pass splits on `-` or `/`
  (`fieldsFuncHyphenOrWhiteSpace`), with both granularities living in the token graph
  simultaneously.
- Phrase permutations are generated **per-section only** — phrases can never cross a comma or
  quote ([README](https://github.com/pelias/parser): the "Main St, East Village" example, where
  the comma position prevents "Main St East" + "Village").

**(a) Survival.** Punctuation survives as _position information_. The README states the design
principle: tokenization "maintains token positions, so it's able to 'remember' where each
character was in the original input text." Delimiters aren't tokens to classify (with one
exception below); they're constraints on what spans may exist.

**(b) Paired delimiters.** Quotes: treated as unpaired hard boundaries (the TODO above).
Parentheses/brackets: **no handling at all** — they are not section boundaries and not
stripped. A lone punctuation token does get classified: `AlphaNumericClassifier` assigns
`PunctuationClassification` to tokens matching
`/^[@&/\\#,+()$~%.!^'";:*?[\]<>{}]+$/`
([classifier/AlphaNumericClassifier.js](https://github.com/pelias/parser/blob/master/classifier/AlphaNumericClassifier.js)),
and schemes use it as a _negative constraint_ — e.g. the subdivision scheme refuses to join a
house number to a following subdivision token across punctuation
([classifier/scheme/subdivision.js](https://github.com/pelias/parser/blob/master/classifier/scheme/subdivision.js)).
A "punctuation" label that exists to _block_ compositions is a decode-side constraint, not a
component.

**(c) Hyphens and slashes.** The dual-path mechanism arrived in
[PR #56 "Supports for hyphen as alternative spans"](https://github.com/pelias/parser/pull/56),
motivated by "10 Boulevard Saint-Germain Paris": the graph holds `Saint-Germain` _and_
`Saint` + `Germain`, and solvers (`ExclusiveCartesianSolver` + penalty/filter passes) pick
whichever composition yields a valid solution. The same split function covers `/`, which is
what gives Pelias a shot at slash forms — but note plainly: we found no test or issue
demonstrating it resolves the Australian `1/123` unit/house convention specifically.

**pelias/api sanitizers.** Read from
[sanitizer/\_text.js](https://github.com/pelias/api/blob/master/sanitizer/_text.js): unicode
normalization, whitespace trim, **trim of leading/trailing quotes** (same long quote list),
truncation to 140 chars. That's all — no bracket stripping, no punctuation deletion before the
parser sees the text. The parser is trusted with raw punctuation.

**(d) Lessons.** PR #56's discussion frames hyphens as "glue" whose alternative readings must
both stay alive; [#71 "Street number prefixes"](https://github.com/pelias/parser/issues/71)
covers hyphenated house-number prefixes (the Queens `69-10` class). The architecture lesson is
that every punctuation decision is _deferred_ — recorded, alternatives generated, resolved by
solvers against dictionaries.

## 3. Nominatim

**Normalization (import and query share the rules).** Read from
[settings/icu_tokenizer.yaml](https://github.com/osm-search/Nominatim/blob/master/settings/icu_tokenizer.yaml):
the normalization stage collapses any run of punctuation/symbols (including the modifier
apostrophe U+02BC) into a single `-`, normalizes `№`/`n°`/`nº` to `no`, and folds spacing; the
transliteration stage then turns `-` and `:` into spaces and **deletes every remaining
character outside `a-z`, `0-9`, and space**. Net effect:

**(a) Survival.** No. By the time tokens hit the lookup table, punctuation is gone —
mostly converted to token _breaks_ (a hyphen or slash becomes a space) rather than deleted
in place. The one structural survivor is the **comma at query time**: free-form queries are
split into phrases at commas, and the docs are explicit that "Commas are optional, but improve
performance by reducing the complexity of the search"
([Search API docs](https://nominatim.org/release-docs/latest/api/Search/)) — the same
"comma as section constraint" idea as Pelias, expressed as candidate-set pruning.

**(b) Paired delimiters.** Handled at **import time, as alias generation**: the
`strip-brace-terms` sanitizer "creates additional name variants for names that have addendums
in brackets (e.g. 'Halle (Saale)')" — the bracketed form _and_ the stripped form are both
indexed ([Tokenizers docs](https://nominatim.org/release-docs/latest/customize/Tokenizers/)).
This is the only purpose-built bracketed-annotation mechanism we found in any surveyed system,
and it lives on the index side, not the parser.

**(c) Hyphens, slashes, house numbers.** All become token breaks via the rules above. On the
data side, the `clean-housenumbers` sanitizer splits list values and regex-filters what counts
as a house number; `clean-postcodes` enforces per-country postcode patterns;
`split-name-list` splits multi-value names on `;,`. Query preprocessing is pluggable
(`normalize`, `regex-replace`; a Japanese phrase-splitting preprocessor was added via
[#3629](https://github.com/osm-search/Nominatim/issues/3629) because JP addresses don't carry
the whitespace/punctuation breaks the pipeline expects).

**(d) Lessons.**

- [#2569](https://github.com/osm-search/Nominatim/issues/2569) /
  [#2571](https://github.com/osm-search/Nominatim/issues/2571): the modifier apostrophe U+02BC
  wasn't classed as punctuation, so `Hawaiʻi` tokenized differently from `Hawai'i` — fixed by
  adding U+02BC to the punctuation fold (visible in today's YAML). Lesson: punctuation
  _equivalence classes_ (curly vs straight vs modifier apostrophes) are a real bug source.
- [#3754](https://github.com/osm-search/Nominatim/issues/3754): "Severobaykal'sk" findable
  only _with_ the apostrophe — closed as a data issue. Because the apostrophe becomes a token
  break, the name indexes as two tokens while the apostrophe-less query is one fused token.
  Lesson: **normalize-to-break and normalize-to-nothing diverge exactly on the
  punctuation-omitted query**, and pushing that onto users gets issues filed.

## 4. Photon (Komoot)

**(a/c) Survival.** No parsing at all — Photon is pure retrieval, so punctuation is entirely an
analyzer concern, applied **symmetrically at index and query time**. Read from the 0.3.x
[es/index_settings.json](https://github.com/komoot/photon/blob/0.3.5/es/index_settings.json):

- char_filter `punctuationgreedy`: pattern_replace `[\.,']` → space, in both `index_ngram` and
  `search_ngram`/`search_raw` analyzers. Added in
  [PR #311 "Filter punctuation"](https://github.com/komoot/photon/pull/311) to fix #308
  (French names like "Saint-Didier-au-Mont-d'Or" unfindable without the exact apostrophes).
- filter `preserving_word_delimiter` (`word_delimiter` with `preserve_original: true`):
  hyphenated compounds are indexed **both split and fused** — the Elasticsearch-native version
  of Pelias's dual-path token graph.
- char*filter `remove_ws_hnr_suffix` (`(\d+)\s(?=\p{L}\b)` → `$1`): glues "12 a" into "12a" on
  the house-number field — punctuation/spacing variants of house numbers solved by
  \_canonicalizing toward the fused form* at index time.

(Current master has been restructured around OpenSearch and the settings live elsewhere; the
mechanisms above are from the 0.3.x tree that PR #311 landed in — inferred to carry forward,
not re-verified.)

**(b) Paired delimiters.** None. Brackets aren't even in the `punctuationgreedy` class; they
fall through to the standard tokenizer, which discards them as symbol chars.

**(d) Lessons.** [#314 (0.3 release notes)](https://github.com/komoot/photon/issues/314) lists
punctuation filtering as a headline fix — for a retrieval-only system, the entire punctuation
problem reduces to "make index-time and query-time token streams agree," and a two-line
char_filter buys most of it.

## 5. Commercial geocoders (publicly documented only — brief)

- **Google**: no published normalization pipeline. The docs steer input shape instead:
  format per the national postal service, and "avoid … business names and unit, suite or floor
  numbers" — i.e. the punctuation-heavy sub-premise tail is contractually out of scope
  ([Geocoding best practices](https://developers.google.com/maps/documentation/geocoding/best-practices)).
  Abbreviation interpretation is acknowledged as language-dependent. Everything else is a
  black box; nothing citable about brackets or slashes.
- **Mapbox**: the only punctuation with documented semantics is the **semicolon — banned
  inside a single query because it's the batch-query delimiter**; queries are otherwise "20
  words and numbers … separated by spacing and punctuation," handling undocumented
  ([Geocoding API docs](https://docs.mapbox.com/api/search/geocoding/)).
- **HERE**: free-form `q` plus a qualified-query parameter whose syntax itself uses
  semicolon-separated `field=value` pairs; punctuation normalization inside free-form queries
  is not documented ([HERE Geocoding & Search docs](https://www.here.com/docs/category/geocoding-search-v7)).

The honest summary: commercial systems document punctuation as _input contract_ (what you may
send) rather than _mechanism_ (what they do with it). No design evidence to mine beyond "they
reserve list delimiters and discourage sub-premise content."

## 6. Punctuation in canonical address DATA — OSM / Karlsruhe schema

The query-side systems above mostly delete punctuation. The data side shows why a _parser_
can't: in canonical data, punctuation is frequently **presentation over real structure**
([OSM Addresses wiki](https://wiki.openstreetmap.org/wiki/Addresses),
[Key:addr:housenumber](https://wiki.openstreetmap.org/wiki/Key:addr:housenumber)):

- **List separators**: multiple house numbers on one building use `;` (OSM standard) or `,`
  (legacy of the original 2008 Karlsruhe schema proposal) — the wiki counts roughly 330k
  comma-separated vs 266k semicolon-separated values as of January 2026. Same glyph class,
  two different data dialects.
- **Hyphen ranges are ambiguous by design**: "10-95" is either a literal label (the NYC Queens
  `69-10` class, where the hyphenated form IS the house number) or a range to interpolate —
  OSM disambiguates with a _separate tag_ (`addr:interpolation`), not by syntax. A parser that
  splits every numeric hyphen is wrong in Queens; one that never splits is wrong on ranges.
- **Czech/Slovak slash numbers**: the displayed `123/4` is conscription number + orientation
  number, **tagged as two separate fields** (`addr:conscriptionnumber`, `addr:streetnumber`) —
  the slash exists only at render time. Turkey uses slashes both in house numbers (`13/A`) and
  in street names (`1/1. Sokak` is a distinct street, not a sub-number).
- **Dotted abbreviations**: OSM convention is unabbreviated names in `addr:street`, but
  official national registries disagree with themselves — the Dutch BAG import notes official
  pairs like "Doctorandus F. Bijlweg" vs "Drs.F. Bijlweg". Dots in data are a _variant axis_,
  not noise.

Implication for us: Austria/Czechia's `14/2`, Australia's `1/123`, USPS's `123 1/2` are three
different structures under one glyph, distinguishable only by locale + position. "Parse the
slash as structure, locale-conditionally" is aligned with how the canonical data is actually
modeled; "delete the slash" destroys exactly the bits the data model keeps in separate fields.

---

## Synthesis — mapped to our three weak quadrants

A one-table summary of who does what:

| System             | Punctuation survives?                                                        | Paired delimiters                                                           | Hyphen/slash compounds                                               | Core mechanism                                      |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| libpostal          | as CRF boundary _features_ (commas, dashes, brackets); periods/colons vanish | flattened to separator bits                                                 | subword features per hyphen part; slash unsupervised                 | normalize-at-feature-time + multi-variant expansion |
| Pelias parser      | as _positions/constraints_; punct-only tokens get a blocking label           | quotes = unpaired hard boundaries (pair-matching is a TODO); parens ignored | **dual-path token graph** (fused + split both alive), solvers choose | defer-the-decision via token graph + solvers        |
| Nominatim          | no (folded to breaks); comma survives as query phrase boundary               | **strip-brace-terms index-time alias**                                      | become token breaks; data-side sanitizers split lists                | normalize-away + index-time variants                |
| Photon             | no (symmetric index/query analyzers)                                         | none                                                                        | word_delimiter with preserve_original (fused + split indexed)        | index-time canonicalization                         |
| Google/Mapbox/HERE | undocumented                                                                 | undocumented                                                                | undocumented                                                         | input contract, not mechanism                       |

### Quadrant: bracketed annotations (v0 +13.9 over neural)

Nobody parses paired delimiters as structure at query time. The only deliberate, shipped
solution is **Nominatim's `strip-brace-terms`** — index-time variant generation, which encodes
the key semantic: _bracketed content is an optional addendum; the name is valid with and
without it_. That is exactly our eval's gold convention 2 (annotations are not components;
the row grades whether neighbors survive). Pelias's section mechanism is the nearest
query-side analog — delimiters define spans that phrases must not cross — but Pelias never
built pair-matching (their own TODO) and ignores parentheses entirely. libpostal flattens
bracket structure into two anonymous boundary bits. Conclusion: our weak quadrant is weak
_everywhere_; the survey's transferable mechanisms are (i) boundary-constraint semantics
(Pelias sections) and (ii) with-and-without variant semantics (Nominatim aliases).

### Quadrant: bare-slash unit designators (v0 +13.0)

The strongest pattern is **Pelias's dual-path tokenization** (PR #56 extended to `/`): keep
the fused token and the split alternative alive simultaneously, and let a downstream stage
with more context choose. Photon reaches the same end state in Elasticsearch
(`preserve_original`). libpostal demonstrates the failure mode of the single-path alternative:
slash sub-premise forms have no dedicated handling, and issue #573 ("Flat 2/19", "FLAT 6-20")
is the result. The OSM data section adds the key constraint: the slash reading is
**locale-conditional** (CZ conscription/orientation vs AU unit/house vs USPS half-address),
so the choice must be made where locale knowledge lives — not in the tokenizer.

### Quadrant: dotted abbreviations (neural +3.6; apostrophes v0 +8.9)

Solved twice, both times by **normalization inside the matching layer, never in the surface
string**: libpostal deletes final/acronym periods _per token at featurization time_
(`ADDRESS_PARSER_NORMALIZE_TOKEN_OPTIONS`), so `St.` and `st` hit the same embeddings and
dictionary entries while the raw string is untouched; Photon folds `[\.,']` to spaces
symmetrically at index and query time. Nominatim's apostrophe issues (#2569/#3754) supply the
cautionary tales: punctuation equivalence classes must be deliberate, and any asymmetry
between how the reference data and the query are normalized turns into unfindable names.

---

## Candidate mechanisms for mailwoman

The Stage 2.7 direction doc (`docs/articles/plan/2026-06-11-subpremise-proposer-direction.md`)
already sketches three slots: (1) input-layer clue channel, (2) a Stage 2.7 sub-premise +
paired-delimiter span proposer emitting typed phrase priors, (3) codex matchers as a second
candidate emitter into reconcile. Each mechanism below states its relation to that design.

### M1. Punctuation as a supervised boundary channel (the libpostal SEP/FSEP pattern, done better)

**What:** a per-token punctuation-context channel — bits for "comma before/after",
"open/close paren adjacent", "slash-adjacent", "hyphen-internal" — fed alongside the gazetteer
channel; with v0.5.0 char-offset labels the punctuation chars themselves stay in the
supervision so the model learns boundary semantics rather than having them hidden by
pre-tokenization.
**Quadrant:** all three, weakly but broadly; primarily neighbor-poisoning by annotations and
comma-boundary ambiguity (libpostal #255's complaint class).
**Lives in:** corpus supervision + neural input channel (retrain-coupled; rides a scheduled run).
**Evidence:** libpostal ships exactly this as `separators` features and SEP/FSEP training
labels — and its open issues show feature-only punctuation is _necessary but not sufficient_;
Pelias's position-tracking README states the same design value from the rules side.
**vs Stage 2.7 doc:** confirms slot 1 and extends it from "designator clue bit" to a general
punctuation-context channel.

### M2. Paired-delimiter span proposal + decode-side crossing constraint

**What:** balanced-pair detection (`()`, `""`, `«»`, `[]`) in the Stage 2.7 proposer emitting
typed spans (`ANNOTATION_PHRASE` / `QUOTED_NAME_PHRASE`, confidence from balance + content
shape), consumed two ways: as phrase priors (the existing contract), and as a **decode
constraint that no component span may straddle a delimiter boundary** — the span bridge's
mirror image (bridge merges across weak punctuation; this blocks merging across structural
punctuation).
**Quadrant:** bracketed annotations (our worst, v0 +13.9); also quoted-venue and unbalanced
classes (graceful degradation when pairing fails — fall back to no constraint, which is
today's behavior).
**Lives in:** Stage 2.7 proposer + decode.
**Evidence:** Pelias proves delimiter-bounded sections that phrases cannot cross prevent
exactly this bleed ("Main St, East Village"), while its unbuilt pair-matching TODO marks the
gap we'd close; Nominatim's `strip-brace-terms` proves the "content is an optional addendum"
semantics is the right read of bracketed annotations.
**vs Stage 2.7 doc:** confirms the #518 paired-delimiter cue family and extends it with the
decode-side crossing constraint, which that doc does not yet name.

### M3. Dual-path slash/hyphen proposals, locale-conditioned (the Pelias PR #56 mechanism in our stack)

**What:** for `N/M` and `N-M` tokens, the proposer emits _both_ readings as typed candidates —
fused (`house_number="69-10"`, `house_number="123 1/2"`) and split (`unit=1 / house_number=123`
AU/NZ; conscription/orientation CZ/AT/SK) — with per-locale shape rules from codex deciding
which alternatives exist and their priors. Downstream (classifier conditioning now, reconcile
arbitration at slot 3) picks per evidence; never a tokenizer-level decision.
**Quadrant:** bare-slash designators (v0 +13.0) + the hyphen class (Queens labels vs ranges).
**Lives in:** Stage 2.7 proposer; matures into the Stage 5 candidate emitter (#478).
**Evidence:** Pelias's token graph keeping both granularities alive is the only surveyed
mechanism that handles this class without locale-blind destruction; Photon's
`preserve_original` is the same idea at index time; libpostal #573 documents the single-path
failure; OSM tagging shows the slash is presentation over distinct fields, so the split
readings are the _canonical_ structure, not a heuristic.
**vs Stage 2.7 doc:** confirms slot 2 and slot 3 sequencing; adds numeric-punctuation forms as
a third cue family beside designators and paired delimiters.

### M4. Punctuation-invariant featurization (dots and apostrophes equivalence-classed at match time)

**What:** when tokens are looked up — embedding vocab, gazetteer/FST channel, codex designator
matching — apply per-token folds: final/acronym period deletion (`P.O.` ≡ `PO`, `St.` ≡ `St`),
apostrophe equivalence class (U+0027/U+2019/U+02BC, and present-vs-absent), while labels and
output values stay on the raw chars (gold convention 5 keeps dots as written). One deliberate
equivalence table, not scattered regexes.
**Quadrant:** dotted abbreviations (defend + extend the +3.6) and apostrophes (v0 +8.9, our
fourth-worst class).
**Lives in:** corpus/neural featurization + the gazetteer channel build; cheap parts are
inference-side.
**Evidence:** libpostal's `ADDRESS_PARSER_NORMALIZE_TOKEN_OPTIONS` is precisely this and is
why a CRF from 2016 is solid on dotted forms; Nominatim #2569/#2571 (U+02BC) shows the
equivalence-class bug; Photon PR #311 shows symmetric folding fixing apostrophe names.
**vs Stage 2.7 doc:** orthogonal — neither confirms nor contradicts; it's the featurization
base the proposer's matchers should also use.

### M5. Resolver-side punctuation variant aliases (the Nominatim move, on our gazetteer)

**What:** at WOF/gazetteer build time, generate name variants: bracket-addendum-stripped
("Halle (Saale)" → also "Halle"), apostrophe-folded, period-folded — so the resolver tolerates
both a parse that kept an annotation and a query that dropped punctuation the canonical name
has. Provenance-tracked rows (each variant points at its source name + transform), consistent
with the no-make-or-break-trivia rule.
**Quadrant:** bracketed + apostrophe, at the resolver layer — it converts residual parser
misses into resolver saves, and protects against Nominatim-#3754-style asymmetry between our
data normalization and query reality.
**Lives in:** resolver normalization / wof-build.
**Evidence:** Nominatim `strip-brace-terms` + `split-name-list` are shipped, battle-tested
sanitizers doing exactly this; Photon's analyzers are the same bet; Pelias's API trims quotes
before parsing for the same reason.
**vs Stage 2.7 doc:** outside its scope (that doc is parser-side); complementary, no conflict.

### Sequencing note

M2 + M3 are one build (the Stage 2.7 proposer with three cue families: designators, paired
delimiters, numeric punctuation) and need no retrain. M4's lookup folds are partially
inference-side. M1 rides the next scheduled retrain with char-offset labels. M5 is an
independent wof-build lever. Nothing in the survey contradicts the Stage 2.7 direction; the
survey's strongest external validation is that the two systems closest to our architecture
(Pelias for parse-side, Nominatim for index-side) each independently converged on "record
punctuation, defer the decision, generate variants" — and the one system that reduced
punctuation to features alone (libpostal) is the one whose issue tracker still collects our
exact failure classes.
