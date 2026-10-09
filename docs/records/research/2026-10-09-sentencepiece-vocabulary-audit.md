# SentencePiece vocabulary audit — mailwoman, 2026-10-09

Scope: the vocabulary the Latin graph (`@mailwoman/neural-weights-en-us` and its eight data-only overlays) reads, measured against the current training corpus `v0.7.2-address-systems`. The audit left the repository and the data root's published artifacts as they were. Every script, candidate model and output lives under `/mnt/mw/audits/sp-vocab-audit-2026-10-09/`. Each claim is marked **observed** (measured here), **inferred** (derived from code or records), or **unknown**.

Provenance: a subagent measured and wrote this report during the #2511 session on 2026-10-09. The session re-ran `measure.py` on the current vocabulary and on candidate C5 and reproduced the US pieces-per-word, 3+-piece-word and ES byte-fallback figures in finding 4. The other figures are the subagent's measurements as recorded, reproducible from the scripts in that directory.

Vocabulary measured throughout: `packages/neural-weights-*/tokenizer.model`, md5 `5c01cdcd4ae25849c5cb26b69fd3dde9` ("current"). Candidate md5s are in §5.

## Summary of the five decision-relevant findings

1. **The current vocabulary was never trained on addresses.** Its 48,000-piece base (`v0.6.0-a0`, 2026-05-28) was trained on 2.19M Who's On First place-name variants, and 25,143 pieces were spliced on afterwards (CZ/PL, Nordic, FR diacritics). Observed consequence on a 293,748-row holdout: 3.9 pieces per Latin-script word; ALL-CAPS words cost 5.23 pieces each (42,933 words), digits-only words 3.72 (one piece per digit: a 5-digit postcode is 5.84 pieces); `STREET` → `S T R E E T`, `BOX` → `B O X`, `Suite` → `Su ite`, `Cedex` → `Ce de x`, `museum` → `Mus eum`. 55.3% of the 73,143 ids never fire on the holdout; the 28.1 MB embedding table (71% of `model.onnx`) is 55% rows the parser never reads.
2. **The 64 user-defined symbols are broken.** They were registered without the `▁` word marker (`AL`, `CA`, `IN`, `DE`, `OR`, …), so they match _inside_ words: over 293,083 eval rows, 242,262 of 265,411 user-defined-symbol pieces (91.3%) fired inside a word (`CALLE` → `C AL LE`, `VALENCE` → `V AL E NC E`, `JAPAN` → `JA PA N`, `INDIA` → `I ND IA`). Observed. The whole-word form `▁CA` does not exist, so a state code costs two pieces (`▁` + `CA`). This is the single mechanism behind most of the ALL-CAPS fragmentation.
3. **Label alignment is clean on whitespace scripts, and the one failure is a corpus defect.** Strict straddles (one piece covering two tagged spans) are 0 of 1,015,400 pieces for US, and 0 for FR, GB, CA, AU, NZ, IN, ES, IT, JP under the current vocabulary. CN reads 2,304 straddling pieces of 178,580 (1.29%; 4,488 of 46,825 spans), and every example is a `wof-admin` row whose country and region were concatenated without a separator (`chinasinxay`, `CHINASZYANSU`): 114,382 of 139,817 CN sample rows (81.8%) and 9,893 of 12,905 TW rows (76.7%) carry glued adjacent spans. A corpus-trained vocabulary learns those glued boundaries as pieces (`▁chinajiangxi`), so straddles rise to 7.5% of CN pieces under every candidate. Fix the glued rows before training any vocabulary.
4. **A vocabulary trained on the corpus halves the piece count and fixes the term lists.** Candidate C5 (unigram, 48,000, coverage 0.9999, byte fallback, trained on 1,348,655 corpus lines with CJK-script rows routed out, seeded with 2,552 `▁`-prefixed codex/WOF/intent terms): pieces per word US 3.71 → 1.88, FR 3.47 → 2.20, DE 4.56 → 2.92, GB 3.35 → 2.61; 3+-piece words US 57.9% → 17.6%; byte fallback ES 9.85% → 0.09%, IN 6.40% → 0.11%, JP 9.93% → 0.54%; dead ids 55.3% → 3.9%; every codex street-type, unit-designator, directional, state, PO-box, WOF-placetype and venue-structure term becomes one piece (0% split, from 57–100%). The same size with only the corpus change (C1) reaches a similar pieces-per-word count but leaves 64–94% of codex terms split and memorizes glued punctuation (`▁12,`).
5. **A vocabulary change costs one from-scratch 60k-step run for the Latin family, and ledger comparability.** `load_state_dict(strict=False)` in `train/setup.py:90` raises on an embedding of a different row count, so every `init_from` fine-tune is discarded by a vocabulary change; the CJK family is a character graph and is untouched. The FST, pair-index, postcode and lexicon artifacts key on whitespace words (observed in `fst-prior.ts:385 groupPiecesIntoWords`), so they are unchanged. `CONTRIBUTING_MODEL_WORK.mdx:22` forbids comparing F1 across tokenizer versions; `evals/scores-by-version.json` has no tokenizer field on any of its 28 runs, so the ledger cannot express the break. The board and promotion battery grade parse outputs and remain valid as instruments. The D-rule comparison must be run model-vs-model on the same board rather than read from the ledger.

**Recommendation:** train a new vocabulary, once, as part of the next from-scratch Latin base, with the C5 recipe (one shared Latin vocabulary, 48,000 pieces, `▁`-prefixed user-defined symbols drawn from codex/WOF/intent, CJK rows excluded because they route to the character graph), after the glued CN/TW rows are repaired. Do not splice again. The tradeoff: one 60k A100 run plus a one-time board discontinuity, against a parser that reads every address in half the pieces, with 40 of the 48 term lists whole and 9.7 MB less embedding table. Details in §7.

---

## 1. Inventory

| field                                      | value                                                                                                                                                                                                                                                                                                                                    | status                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| file                                       | `packages/neural-weights-{de-de,en-au,en-gb,en-in,en-nz,en-us,es-es,fr-fr,it-it}/tokenizer.model`; data-root copy `models/tokenizer/v0.9.0-multisplice/tokenizer.model`; `release.config.json#weights.tokenizer`                                                                                                                         | observed                                                                                      |
| md5                                        | `5c01cdcd4ae25849c5cb26b69fd3dde9` (identical bytes in all nine packages and the data root; 1,632,289 B)                                                                                                                                                                                                                                 | observed                                                                                      |
| pieces                                     | 73,143 = 3 control + 1 unknown + 64 user-defined + 256 byte + 72,819 normal                                                                                                                                                                                                                                                              | observed (ModelProto)                                                                         |
| trainer `vocab_size` recorded in the proto | 48,000 (the base run); the other 25,143 pieces were appended by splices                                                                                                                                                                                                                                                                  | observed / inferred                                                                           |
| model type                                 | unigram; `hard_vocab_limit`, `max_sentencepiece_length` 16, `split_by_number` and `split_by_unicode_script` on, `split_digits` off                                                                                                                                                                                                       | observed                                                                                      |
| character coverage                         | 0.9999                                                                                                                                                                                                                                                                                                                                   | observed                                                                                      |
| byte fallback                              | on (256 `<0x..>` pieces)                                                                                                                                                                                                                                                                                                                 | observed                                                                                      |
| normalization                              | `nmt_nfkc`, `add_dummy_prefix`, `remove_extra_whitespaces`, `escape_whitespaces`                                                                                                                                                                                                                                                         | observed                                                                                      |
| user-defined symbols                       | 64: the 56 US state/territory codes, `USA US U.S. U.S.A. FR FRA France JP`, registered **without** `▁`                                                                                                                                                                                                                                   | observed                                                                                      |
| base training corpus                       | 2.19M WOF name variants (500K Latin, 500K Chinese, 468K Cyrillic, 285K Arabic, 183K Japanese, 94K Korean, 160K other), trained 2026-05-28 as `v0.6.0-a0`; trainer input path recorded in the proto: `/mnt/playpen/mailwoman-data/models/tokenizer-training/combined-shuffled.txt`                                                        | inferred from `docs/research/2026-05-28-global-wof-tokenizer.mdx` and the proto               |
| splice chain                               | `v0.6.0-bsplice` (CZ/PL, 58,582 pieces, npm 5.1.0, 2026-07-02) → `v0.7.1-nsplice` (Nordic, 5.2.0) → `v0.8.0-fr-nsplice` (+2,406 FR non-ASCII pieces from a 24k unigram on OA `fr/countrywide.csv`, 5.9.0) → `v0.9.0-multisplice` (73,143, shipped from 6.1.0 on)                                                                         | inferred from `docs/engineering/releases.mdx` and `model-card.json#training.tokenizer_splice` |
| script composition of the pieces           | latin 36,764; han 9,569; cyrillic 9,377; arabic 5,884; kana 2,857; indic 2,682; hangul 2,243; greek 1,334; hebrew 1,303; thai 772; digit-initial 21                                                                                                                                                                                      | observed                                                                                      |
| users                                      | the nine Latin packages above; `en-us` ships the graph (`inner.token_embeddings.weight_quantized` UINT8 [73143, 384] = 28,086,912 of 39,372,670 weight bytes), the other eight are data-only overlays on it. `neural-weights-base-latn` is private and parked.                                                                           | observed                                                                                      |
| not users                                  | `neural-weights-cjk` (+ `ja-jp`, `zh-cn` overlays): character encoder, `char-vocab.json` 4,451 entries, `tokenizer: null` in its card                                                                                                                                                                                                    | observed                                                                                      |
| other copies                               | `packages/neural/test/fixtures/tokenizer-v0.1.0.model` (16,000 pieces, md5 `06b28ecb…`) is a test fixture only. `REPRODUCIBILITY.md:15` still names `v0.6.0-a0` (md5 `b6137e8c…`) as the tokenizer input and `release-tools/publish/hf.ts` carries a `tokenizerVocab: 48_000` literal: both stale against the shipped 73,143-piece file. | observed                                                                                      |

One vocabulary, then: every Latin locale shares it; CJK does not use SentencePiece at all.

## 2. Fit to the current corpus

**Sample.** Pass 1 counted `country` over all 760 train slices (702,648,847 rows, 0.7 s): US 487,663,679; FR 147,832,375; IN 18,243,859; GB 13,881,423; CN 7,676,008; NL 3,434,416; DE 3,433,605; IT 3,118,812; … (full list in `country_counts.json`). Pass 2 scanned all slices once (50.7 s) accepting each row with probability 140,000/count for the twelve tier-1 countries and 400,000/15,487,067 for all others, seeded by `hash(source_id, raw)` so the draw is reproducible: 1,953,378 rows in `sample.parquet` (NZ has only 13,174 rows in the whole train split, so all of them were taken). A per-row uniform `u` splits it: `u < 0.7` trains candidates (1,366,547 lines), `0.7 ≤ u < 0.85` is eval A (293,083 rows), `u ≥ 0.85` is the holdout every table below uses (293,748 rows: 20,784–21,145 per tier-1 country, 2,021 NZ, 60,278 other).

**Offsets.** The Python binding's `immutable_proto` offsets were wrong on plain ASCII rows (`VALENCE` → `▁V` at (0,0)), so `measure.py` re-aligns pieces to the raw string through the per-code-point NFKC image; 0–44 rows per bucket failed alignment and are counted in the json as `offset_mismatch`.

**Worst-served.** Within the tier-1 buckets the fragmentation is concentrated in three word classes rather than in countries (holdout, `case_ppw_all.json`, up to 4,000 rows per bucket):

| word class       |   words | current |   C1 |   C2 |   C3 |   C4 |   C5 |
| ---------------- | ------: | ------: | ---: | ---: | ---: | ---: | ---: |
| ALL-CAPS letters |  42,933 |    5.23 | 2.91 | 2.20 | 2.27 | 2.19 | 2.22 |
| cased letters    | 103,809 |    2.86 | 2.20 | 2.45 | 2.55 | 2.44 | 2.48 |
| digits only      |  27,577 |    3.72 | 1.54 | 1.94 | 1.96 | 2.94 | 1.54 |
| letters+digits   |   9,496 |    4.40 | 3.85 | 3.95 | 3.95 | 4.11 | 3.95 |

Examples (current): `1600 PENNSYLVANIA AVE NW WASHINGTON DC 20500` → 33 pieces (`▁P E N N S Y L VA N IA`, `▁A V E`, `▁W AS HI N G T O N`); `4420 Bedford RD, KELOWNA V1W3C5` → `▁4 4 2 0 … ▁R D , ▁K E L O W N A`; `138 GREAT KING ST DUNEDIN` → `▁G R E A T ▁K IN G ▁S T ▁D U NE D IN`; `COOLBELLUP` → 10 pieces. AU/NZ/CA register rows are upper-case, which is why AU reads 51.6% and CA 65.9% of words at 3+ pieces.

By script the losers are the scripts the WOF base never saw enough of: Armenian 10.7 pieces/word with 79.0% byte fallback (1,478 rows), Georgian 19.7 and 87.5% (293), Indic 9.2 and 64.8% (692), "other" (Sinhala, Tibetan, Gothic …) 21.2 and 87.4% (188). These rows are `wof-admin` exonym variants filed under tier-1 countries (`ಕ್ಯಾಂಥಬ್ರಿಯಾ, Spain` → 36 byte pieces; `ЧАНДИГАР` under IN → 9 pieces), which is why ES reads 9.85% byte fallback and IN 6.40% although both are Latin-dominant. Han (0.5%), kana (0.0%) and hangul (0.6%) are well covered by the base, but at serve time those scripts route to the character graph, so 14,669 of the 73,143 pieces (han+kana+hangul) are spent on text this vocabulary no longer sees.

Full per-bucket tables (pieces per word, per character, 3+-piece share, byte and unknown rates, dead pieces, per-script) are in the appendix.

## 3. Label alignment

Method: per row, a per-character span index from `span_starts/span_ends/span_tags`; a piece is a **strict straddle** when its non-space characters belong to two or more distinct tagged spans, and **loose** when it mixes a tagged character with an untagged non-space character (a comma glued to a number). The training projection (`tokenizer/spans.py:project_char_labels_to_pieces`) gives each piece the label of its first non-space character, so a strict straddle is a forced labeling error on the second span's boundary.

Holdout, current vocabulary (md5 `5c01cdcd…`):

| bucket                                 |          pieces | strict straddles |   spans | spans with a straddled boundary (per tag)                                    | tag pairs                                                         |
| -------------------------------------- | --------------: | ---------------: | ------: | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| US                                     |       1,015,400 |                0 | 141,000 | 0                                                                            | —                                                                 |
| FR, GB, CA, AU, NZ, IN, DE, ES, IT, JP | 0 each (0.000%) |                0 |       — | 0                                                                            | —                                                                 |
| CN                                     |         178,580 |    2,304 (1.29%) |  46,825 | 4,488 (9.59%): region 2,110/16,532, country 1,644/8,930, locality 734/20,932 | country\|region 1,570; locality\|region 660; country\|locality 74 |
| OTHER                                  |       1,161,736 |     154 (0.013%) | 196,131 | 296 (0.151%): region 138/8,210, country 90/6,735, locality 68/51,903         | country\|region 86 (all TW)                                       |

(The exact-zero buckets are observed zeros.) Loose straddles are 0.000–0.001% under the current vocabulary (it holds almost no pieces that contain punctuation). Han-script rows read 0 straddles of 12,057 pieces (3,095 spans), so every CJK piece sits inside one tagged span.

Examples (CN/TW, all `wof-admin`): `chinasinxay` → piece `as` covers the end of `country`=china and the start of `region`=sinxay; `CHINASHANDONGझिबो` → `AS`; `TAIWANCHANGHUADINGXING VILLAGE` → `NC`; `ANHUILU-AN` → `IL` (locality|region). The corpus writes these rows with span offsets that touch (`span_ends[i] == span_starts[i+1]`): 114,382 of 139,817 CN rows in the sample (81.8%; 113,466 from `wof-admin`, 916 from `osm-cn`), 9,893 of 12,905 TW rows (76.7%), and the next country is US at 205 of 140,391 (0.15%, NPPES rows such as `… PITTSBURGH PA 152221029`). Pair counts over the full sample: CN region|locality 109,292, CN country|region 54,617, TW region|locality 8,717 (`glued_spans.json`).

Why this matters for a retrain: a vocabulary trained on this corpus learns the glued boundaries. C5 produces `▁CHINAGUANGDONG`, `inajiangxi`, `▁taiwantainan` as single pieces, and CN straddles rise to 7,626 of 102,120 pieces (7.47%; 15,323 of 46,825 spans: country 7,424/8,930, region 7,595/16,532), OTHER to 680 of 645,627 (0.105%, TW). Every candidate shows the same (C1 7.35%, C2 7.66%, C3 7.19%, C4 7.71%). A corpus-trained vocabulary therefore needs the CN/TW glued rows repaired (or excluded from the tokenizer sample) first; the current vocabulary is only "better" here because it fragments those words into letters. C1 also shows loose straddles of 0.20% (US) to 1.62% (OTHER) from glued punctuation pieces (`▁5,`, `▁12,`); C5 reads 0.07% / 0.76%.

Per-tag fragmentation, the other alignment cost (each extra piece in a span is one more chance for a B/I error), is in the appendix per-tag table: under the current vocabulary a US postcode is 5.84 pieces (0.5% single-piece), a US street 5.09, a venue 11.5–17.2 pieces, a GB postcode 6.07.

## 4. Domain fit

Share of terms whose every word is one piece (`▁term`), current vocabulary (`terms_current.json`); "split" means at least one word needed 2+ content pieces:

| list                                                                         | terms |                             split | content pieces/word | examples of splits                                                                                                                  |
| ---------------------------------------------------------------------------- | ----: | --------------------------------: | ------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| EN street types (`Street St Avenue Ave … BLVD street`)                       |    47 |                          18 (38%) |                1.85 | `STREET`→S T R E E T, `AVENUE`→A V E N U E, `Blvd`→B l v d, `ROAD`→R O A D, `Rd`, `Ln`, `Ct`, `Hwy`, `Close`, `Mews`                |
| FR street types                                                              |    36 |                          22 (61%) |                2.31 | `boulevard`→bou le v ard, `avenue`→a ven ue, `impasse`→i mp asse, `Rue`→▁ Rue (detached), `RUE`, `CHEMIN`, `ALLÉE`                  |
| DE street types                                                              |    20 |                          12 (60%) |                1.80 | `platz`→p la tz, `gasse`→ga sse, `strasse`→str asse, `Str.`                                                                         |
| ES street types                                                              |    23 |                          19 (83%) |                2.43 | `Calle`→Cal le, `Avenida`→Av en ida, `CALLE`→C AL L E                                                                               |
| IT street types                                                              |    21 |                          20 (95%) |                2.76 | `Via`→Vi a, `Piazza`, `Corso`, `VIA`                                                                                                |
| JA/ZH address units (`丁目 番地 号 市 区 町 …`)                              |    22 |                           3 (14%) |                1.14 | `番地`→番 地, `号楼`, `单元` (whole units carry a detached `▁`)                                                                     |
| unit designators (`Apt Suite Ste Unit Floor Bldg Étage Piso …`)              |    59 |                          43 (73%) |                1.90 | `Suite`→Su ite, `Bldg`→B l d g, `Floor`, `Room`, `Unit`, `Étage`, `Piso`, `Wohnung`                                                 |
| venue head words (gallery, palace, museum, musée, museo, galerie, 店, 館, …) |   117 |                          80 (68%) |                2.27 | `museum`→Mus eum, `musée`→Mus ée, `museo`, `gallery`, `palace`, `galerie`, `Palais`, `美術館`→美術 館; `店`, `館` are whole         |
| postcode shapes                                                              |    23 |                         23 (100%) |                4.48 | `10118`→▁10 1 1 8, `SW1A 1AA`→S W 1 A ▁1 A A, `K1A 0B1`→7 pieces, `〒100-0005`→12 pieces (〒 is three byte pieces), `12345-6789`→10 |
| house-number patterns                                                        |    29 |                          27 (93%) |                2.68 | `1234`→▁1 2 3 4, `12-14`→5 pieces, `12 bis`→▁1 2 ▁ bi s, `Blk 12`→B l k ▁1 2                                                        |
| `DEFAULT_USER_DEFINED_SYMBOLS` (112 in `uds.py`)                             |   112 | 48 split; 64 present but detached |                   — | `JPN`→JP N, `GB`→G B, `UK`→U K, `Suite`→Su ite, `Cedex`→Ce de x, `CEDEX`→C E DE X, `P.O. Box`→5 pieces, `BP`→B P                    |

Observed. Only 21 pieces in the vocabulary begin with a digit, so every number is spelled digit by digit; that alone is 5–6 pieces per postcode and 2–4 per house number on every row, and the known-format shapes (`\d{5}-\d{4}`, `[A-Z]\d[A-Z] \d[A-Z]\d`, `〒\d{3}-\d{4}`) never coincide with a piece boundary. `〒` itself is not in the vocabulary (three byte-fallback pieces), although the JP serving path keeps it (`postalMark: "keep"`).

## 4a. Who's On First placetypes and venue structure

Sources: the `PlacetypeName` union in `packages/core/lib/resources/whosonfirst/placetypes/definition.ts` (35 names), `placetype_codes` in `/mnt/mw/db/wof/candidate.db` (12 rows: `country`, `region`, `neighbourhood`, `locality`, `county`, `microhood`, `macrohood`, `macroregion`, `macrocounty`, `localadmin`, `borough`, `postalcode`), and the designator lists exported by `packages/neural/lib/venue-structure.ts` (21 terms: `arcade`, `building`, `campus`, `concourse`, `enclosure`, `installation`, `wing`, `terminal`, `gate`, `north`/`south`/`east`/`west`, `upper`/`lower`, `main`, `central`, `inner`, `outer`, `front`, `rear`). Current vocabulary, md5 `5c01cdcd…`:

| list                         | terms | whole |    split | pieces/word | C5 split |
| ---------------------------- | ----: | ----: | -------: | ----------: | -------: |
| placetype names              |    35 |     1 | 34 (97%) |        3.49 |        0 |
| candidate.db placetype_codes |    12 |     1 | 11 (92%) |        3.83 |        0 |
| venue-structure designators  |    21 |     4 | 17 (81%) |        2.19 |        0 |

Splits: `neighbourhood`→n eigh b our ho od (7), `postalcode`→po s tal co de, `concourse`→con c ours e, `enclosure`→en c los ure, `terminal`→ter mina l, `arcade`→ar ca de, `building`→bu il ding, `wing`→w ing, `campus`→camp us; `locality`, `region`, `county`, `borough` all 2–4 pieces. Observed. These words reach the model only when they appear in an address or query (`Terminal 2`, `West Wing`, `Concourse B`); under C5 all 35 + 12 + 21 are single pieces.

## 4b. `@mailwoman/codex` locale terms

Terms were collected by importing each module and walking its exported string values, keys, Sets and Maps (`extract_terms.mjs`; counts per module in `terms_exports.json`). The current vocabulary splits:

| module                                                     |                                                                                                                                                         terms |                          split |        pieces/word | C5 split |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------: | -----------------------------: | -----------------: | -------: |
| `us/street/suffix` (USPS suffixes + variants)              |                                                                                                                                                         1,098 |                    1,028 (94%) |               3.13 |       0% |
| `us/unit-designator`                                       |                                                                                                                                                            90 |                       84 (93%) |               3.17 |       0% |
| `us/floor-designator`                                      |                                                                                                                                                            22 |                       20 (91%) |               3.36 |       0% |
| `us/po-box`                                                |                                                                                                                                                             8 |                       8 (100%) |               3.79 |       0% |
| `us/military-address`                                      |                                                                                                                                                            26 |                       25 (96%) |               2.37 |       0% |
| `us/street/directional`                                    |                                                                                                                                                            40 |                       23 (57%) |               2.48 |       0% |
| `us/state` (codes + names)                                 |                                                                                                                                                           112 |                       17 (15%) |               1.22 |       0% |
| `fr/voie`                                                  |                                                                                                                                                            62 |                       49 (79%) |               2.15 |       0% |
| `fr/region` / `fr/departement`                             |                                                                                                                                                      74 / 223 |           66 (89%) / 184 (83%) |        2.31 / 2.44 |  5% / 8% |
| `de/street-type` / `de/bundesland`                         |                                                                                                                                                       34 / 93 |            22 (65%) / 82 (88%) |        1.88 / 3.10 | 0% / 14% |
| `gb/street-type` / `gb/country` / `gb/place-name`          |                                                                                                                                                  45 / 10 / 20 |   28 (62%) / 7 (70%) / 3 (15%) | 1.89 / 2.09 / 1.15 |       0% |
| `ca/street-type` / `ca/province`                           |                                                                                                                                                       61 / 68 |            38 (62%) / 58 (85%) |        1.87 / 2.55 |  0% / 6% |
| `au/level-designator` / `au/delivery-service` / `au/state` |                                                                                                                                                  68 / 30 / 16 | 56 (82%) / 29 (97%) / 13 (81%) | 3.14 / 4.09 / 2.13 |       0% |
| `nz/delivery-service`                                      |                                                                                                                                                            16 |                      16 (100%) |               2.93 |      12% |
| `jp/address-unit` / `jp/prefecture`                        |                                                                                                                                                      13 / 242 |             1 (8%) / 214 (88%) |        1.08 / 2.22 |  0% / 3% |
| `address/layouts` / `address/system-conventions`           |                                                                                                                                                        33 / 5 |            24 (73%) / 5 (100%) |        2.52 / 4.60 |  3% / 0% |
| `abbreviations.ts` (EN/FR/ES dictionaries)                 | module-private; its 40 short forms are covered by the street-type lists above (`Blvd`, `Rd`, `Ln`, `Ct`, `Hwy`, `Pkwy`, `Bd`, `Bvd`, `Imp`, `Avda` all split) |                                |                    |          |

Observed. The suffix table is upper-case, which is why it is the worst list (`BOULEVARD`→B O U L E VA R D, `CROSSROADS`→10 pieces). The 64 state codes exist as pieces but only in the detached form (`▁`+`CA`), and that same piece fires inside 242,262 words (finding 2). A candidate seeded with the codex terms as `▁`-prefixed user-defined symbols makes 2,552 words atomic at the cost of 2,552 of the 48,000 slots (5.3%); the remaining splits under C5 are multi-word or hyphenated names (`Nouvelle-Aquitaine`, `Mecklenburg-Vorpommern`) whose hyphen is its own piece. Caveat from this run: the first seeded candidates (C2–C4) also took 102 numeric codes from `fr/departement` and `jp/prefecture` (`▁01`…`▁99`) as symbols, which forced `▁10`+`118` splits on every number; C5 drops the symbols that contain digits and is the candidate to read.

## 4c. Query shapes and intents

- **Known formats** (`packages/query-shape/lib/known-formats.ts`): regexes over whitespace tokens, so the rules themselves do not depend on pieces; what matters is whether the model sees the same unit. Under the current vocabulary all 18 shape examples are split (100%; 4.04 pieces/word): `12345-6789`→10 pieces, `SW1A 1AA`→7, `K1A 0B1`→7, `1012 LG`→6, `〒100-0005`→12. `PO_BOX_LEADERS` (`po p.o. p.o box bp b.p. b.p casilla apartado`): 8 of 9 split (`box`→bo x, `p.o.`→p . o .). C5: PO-box leaders 0% split; postcode shapes still 67–78% split but at 2.3 pieces per token (`▁62`+`701`, `▁SW`+`1A`+…), because a postcode is a shape rather than a word, and a word-piece vocabulary makes it one piece only by memorizing specific codes (C1, unseeded, learned `▁10115`, `▁6270`+`1`: 13% of US postcodes became single pieces, which is memorization of frequent codes rather than shape coverage).
- **Region abbreviations** (`region-abbreviations.ts`): shape-only, 2 uppercase letters after a comma. The 56 state codes are the 64 user-defined symbols: present, but detached (`▁`+`NY`) and misfiring inside words (finding 2). C5 makes `▁NY` one piece and the bare `NY` piece no longer exists.
- **Segmentation / character class**: operate on code points and commas; no piece coupling (observed by reading `segmentation.ts`, `character-class.ts`).
- **Intent markers** (`packages/kind-classifier/lib/intent/rules.ts`): `TOPONYM_HEAD_PARTICLES` 70 words, 42 split (60%: `new`, `north`, `south`, `east`, `santa`, `puerto`, `nueva`, `sankt`, `neu`, `kuala`, `cape`); `TOPONYM_TAIL_NOUNS` 22, 10 split (45%: `heights`, `island(s)`, `harbour`, `village`, `springs`, `falls`, `valley`); the near-me locators (`near me`, `nearby`, `around here`, `in my area`) 14 of 15 split. C5: head particles and tail nouns 0% split; near-me phrases stay split (93%) because `me`, `my`, `here` are outside the address lexicon and were left unseeded. These rules run on the normalized string, so the vocabulary affects only what the neural model could learn from such queries and leaves the rules unchanged.
- **POI / activity lexicons**: `activity-lexicon.json` 11 phrases (100% multi-piece under both), `poi-taxonomy` 55 synonym phrases (96% / 93%), 2,113 category labels (97% / 96%), 2,249 venue-word hints (99% / 98%). These are matched by `packages/mailwoman/lib/poi/intent.ts` through phrase lookup (exact, locale-normalized, typo), not through the tokenizer; a vocabulary change does not alter their behavior.
- `packages/mailwoman/lib/query-intent.ts` keys on resolver output (dominance margins, placetypes), not on surface words. No piece coupling.

Observed throughout; md5 `5c01cdcd…` for "current", `9279019e…` for C5.

## 5. What a new vocabulary would change

Five candidates were trained in `sp-audit/cand_*/` with `sentencepiece` 0.2.1 (unigram, `character_coverage` 0.9999, byte fallback, `max_sentencepiece_length` 16, ids pad/unk/bos/eos = 0/1/2/3, 14 threads, every training line used):

| id                                | md5                                | training text                                                                                                                                |  vocab |                                              user-defined symbols | split_digits | seconds |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------------------------------------------------------: | ------------ | ------: |
| C1 "same settings on the corpus"  | `d12e6bf5105d997e5ed66f20d360028b` | `train_all.txt` 1,366,547 corpus rows (`u < 0.7`, all scripts)                                                                               | 48,000 |                                              the current 64, bare | off          |    42.9 |
| C2 seeded                         | `74e70808b137424f095bfdcf92d9ac54` | `train_latin.txt` 1,348,655 rows (17,892 Han/Kana/Hangul-dominant rows dropped: CN 4,909, JP 4,735, IT 3,095, ES 2,411, DE 1,502, KR 521, …) | 48,000 | 2,654 `▁`-prefixed codex/WOF/intent/q4 words (incl. the 64 codes) | off          |    91.6 |
| C3 seeded, 32k                    | `507a680358d7d301a9a0f4fceb2bfbb0` | same                                                                                                                                         | 32,000 |                                                             2,654 | off          |    90.5 |
| C4 seeded, split digits           | `ae9a6f2dab82afd70ed298e678da5a16` | same                                                                                                                                         | 48,000 |                                                             2,654 | on           |    63.5 |
| C5 seeded without numeric symbols | `9279019e074e1fa30c28f3f8183d6d22` | same                                                                                                                                         | 48,000 |                          2,552 (C2's set minus 102 numeric codes) | off          |    94.4 |

Held-out set: the 293,748 `u ≥ 0.85` rows, disjoint from the training lines. All appendix tables are observed on that set; the current column is md5 `5c01cdcd…`. C1 shows what the corpus alone changes; C2/C3/C4 are distorted on numbers by the `▁01…▁99` symbols and are kept for the size (C3) and digit (C4) contrasts; C5 is the recipe recommended.

Vocabulary composition (observed from the protos): C1 spends 7,457 pieces on digit strings (it memorizes `▁10115`, `▁2050`, `▁12,`), 3,118 on Han, 3,664 on Cyrillic; C2/C5 spend 2,171 on digits, 3,286 Han, 3,991 Cyrillic, 31,632 Latin. Model files: 1,000–1,016 KB versus 1,632 KB today.

The side-by-side shows that C5 halves pieces per word on every Latin bucket (US 3.71→1.88, AU 3.03→1.78, FR 3.47→2.20, DE 4.56→2.92, IT 4.57→2.74, OTHER 4.09→2.27), lowers 3+-piece words from 46–70% to 17–46%, removes byte fallback from the Latin-filed exonym rows (ES 9.85%→0.09%, JP 9.93%→0.54%, armenian 79%→0%, georgian 87.5%→0%, indic 64.8%→0.1%), and leaves 3.9% dead ids instead of 55.3%. Han rows read 3.3% byte fallback under C5 (0.5% today) because those rows route to the character graph and were excluded on purpose; C1, which kept them, reads the same 3.1% at coverage 0.9999, so a 48k corpus-trained vocabulary will not reproduce the WOF base's 9,569 Han pieces either way. C3 (32k) costs +0.05–0.1 pieces per word over C5 and raises 3+-piece words by 1–3 points; it saves 6.1 MB of int8 embedding (16,000 × 384). C4 (split digits) is the digit-uniform option: every digit its own piece as today (`▁16 0 0`), 2.94 pieces per digit word versus 1.54, and the only candidate whose postcode piece counts match the current file; the cost is +0.3–0.5 pieces per word on US/FR.

Memorization caveat on numbers: C1 and C5 learn frequent house numbers and postcodes as pieces (US house_number 70% single-piece, FR postcode 40%). Whether a 60k-step model generalizes digit shape better from per-digit pieces (today, C4) or from mixed pieces (C5) is **unknown** from a tokenization measurement and is the one question only a training run answers. The 2026-07-16 record "digit incoherence is cross-lingual" was measured on the per-digit vocabulary, so the current model shows that incoherence with per-digit pieces.

Memory note for a rerun: training C2–C5 beside another 24 GB job restarted the session twice; cap the trainer (`input_sentence_size`) or run it alone.

## 6. Cost of switching

What a vocabulary change forces, from the code:

| item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | mechanical or risky                                                                                                                                                 | evidence                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **Retrain the Latin family from scratch.** `train/setup.py:89-91` loads `init_from` with `load_state_dict(sd, strict=False)`; PyTorch raises on a size mismatch of `token_embeddings.weight` ([73143,384] vs the new count), so no fine-tune lineage crosses the change. There is one Latin graph (`en-us`; `de-de`, `en-au`, `en-gb`, `en-in`, `en-nz`, `es-es`, `fr-fr`, `it-it` are data-only overlays), so this is **one** 60k-step from-scratch run (the shipped 10.1.0 is itself from scratch, `v7.2.0-address-systems-60k.yaml`, `--resume none`). A splice-and-mean-init path (`tokenizer/splice.py`) exists but is limited to pieces containing codepoints absent from the base languages, and the 2026-07-04 record found mean-init inherits the wrong signal for FR (mangle 23.5%→26.4%); it does not apply to a replacement vocabulary. | risk: the normal training risk; the D-rule needs a Pareto read on FR, US, DE, GB against 10.1.0 on the board, and every fine-tune after it starts from the new base | inferred from code + records |
| **The embedding table.** `[vocab, 384]` UINT8: 73,143 rows = 28.1 MB today; 48,000 = 18.4 MB; 32,000 = 12.3 MB. The quantizer (`export/quantize.py`) and the split-embedding writer (`export/split_embeddings.py`, MWE1 header carries vocab size) read the size from the graph.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | mechanical                                                                                                                                                          | observed                     |
| **ONNX export.** `export/graph.py` exports whatever `vocab_size` the model has; `model-card.json#architecture.vocab_size` and `format.tokenizer` must be rewritten, and `release-tools/publish/hf.ts` reads `tokenizerVocab` from the card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | mechanical                                                                                                                                                          | observed                     |
| **FST, pair-index, postcode binaries, lexicons.** Keyed on whitespace words rebuilt from pieces (`fst-prior.ts:385 groupPiecesIntoWords` splits at `▁`); the anchor/gazetteer/country/street-type/locality-surface channels paint by the piece's first non-space character (`anchor-inference.ts:227`, `gazetteer-inference.ts:275`, mirrored in Python `realign_*_to_pieces`). None stores piece ids. A `▁`-prefixed symbol vocabulary keeps the `▁` word-start convention these rely on; pieces with an interior `▁` (multi-word symbols) would break word grouping, which is why the candidates seed single words only.                                                                                                                                                                                                                          | mechanical, one invariant to keep                                                                                                                                   | observed                     |
| **Browser bundle.** `tokenizer.model` 1.63 MB → ~1.0 MB; `model.onnx` 39.45 MB → ~29.8 MB (48k) or ~23.6 MB (32k); the v10.1.0 split release already ships `encoder.onnx` 11.4 MB + embedding rows read by range, so the on-wire saving there lands in the rows file and the hot subset. `neural/web/loader.ts` takes the tokenizer by URL; no new runtime capability is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | mechanical                                                                                                                                                          | observed / inferred          |
| **Board, promotion battery, pins.** They grade parse outputs (`mailwoman eval pins`, gauntlet rows), not pieces, so they run unchanged against the new model. What breaks is comparability: `CONTRIBUTING_MODEL_WORK.mdx:22` "Never compare F1 across tokenizer versions", `per-locale-f1.ts --tokenizer` enforces it, and `evals/scores-by-version.json` has no tokenizer field on any of its 28 runs, so the ledger cannot mark the discontinuity. The D-rule read must be model-vs-model on the same board rows at promotion time (as 10.1.0 vs 9.1.0 was: 274 improved, 57 regressed of 1,226), and the ledger needs a `tokenizer_md5` field from that release on. Calibration (`calibration.json`, isotonic over span confidence) must be refit as for any from-scratch model.                                                                 | risk: historical score rows stop being comparable; mitigated by a one-time dual read and a ledger field                                                             | observed                     |
| **Tests, docs, literals.** `packages/neural/test/fixtures/tokenizer-parity-*.json` pin the v0.1.0 fixture model rather than the shipped file; `char-encoder-cjk.json` is the CJK path. Literals naming the shipped md5 or 73,143 (release docs, card, `REPRODUCIBILITY.md:15`, `publish/hf.ts`) need the sweep.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | mechanical                                                                                                                                                          | observed                     |
| **CJK family.** Untouched: character encoder, own card and vocabulary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | none                                                                                                                                                                | observed                     |

## 7. Recommendation

**Change the vocabulary, once, at the next from-scratch Latin base; keep one shared Latin vocabulary; do not splice again.**

Recipe (the C5 arm, measured above): unigram, 48,000 pieces, coverage 0.9999, byte fallback on, trained on a country-stratified corpus sample in place of WOF names, with Han/Kana/Hangul-dominant rows excluded because they route to the character graph, seeded with the codex, WOF-placetype, venue-structure and intent single-word terms as `▁`-prefixed user-defined symbols, without numeric codes. Before training it: repair or drop the glued CN/TW `wof-admin` rows (81.8% of CN sample rows), or the vocabulary will learn `▁CHINAGUANGDONG`. A training probe decides `split_digits`: C5 (mixed digit pieces) is 1.54 pieces per number and C4 (one piece per digit, as today) 2.94; a 2k-step probe of each read on the postcode/house-number board rows is the smallest test that distinguishes them.

Size: 48,000 rather than 32,000. C3 shows 32k costs about 2 points more 3+-piece words and 0.1 pieces per word for 6 MB; the 55% dead rows today come from the WOF base and the splices rather than from size, and C5 leaves 3.9% of 48k idle. Keep the size at or under 48k: the current file's extra 25,143 spliced rows fire on 0 holdout pieces.

Per-script split: no. The CJK family already is the per-script split (character graph), and the Latin vocabulary's remaining non-Latin pieces (Cyrillic 3,991, Arabic 1,292, Indic 1,338 under C5) are what the Latin graph needs for the exonym rows it is trained on. A second Latin vocabulary per locale would multiply the from-scratch cost by the number of graphs, and there is one graph.

The tradeoff, plainly: one from-scratch 60k run with the usual D-rule risk, a ledger discontinuity bridged by a same-board dual read and a new `tokenizer_md5` field, and a card/docs/literal sweep, against halving the piece count on every Latin address (US 3.71→1.88 pieces per word, 57.9%→17.6% of words in 3+ pieces), ending the ALL-CAPS and state-code fragmentation (5.23→2.22 pieces per upper-case word; the 91.3% symbol misfire rate goes to 0 by construction), making 40 of the 48 term lists whole, removing byte fallback from the Latin-filed exonym rows, and a 9.7 MB smaller model. If the vocabulary stays, every future model reads those pieces; the scores-across-releases argument holds exactly once and then the new vocabulary is the baseline.

## Related work: GLiClass

GLiClass (knowledgator) is a GLiNER-style zero-shot sequence classifier: a uni-encoder (DeBERTa-v2 or T5/mT5 backbone) reads the label names and the text in one pass and scores pooled label representations against the text. Its README documents no tokenizer choice beyond the backbone's `AutoTokenizer` and one special token (`<<EXAMPLE>>`). It bears on this decision in one respect only: a label-conditioned encoder puts label names into the input, so the vocabulary must carry the label words as learnable units, which is the same argument §4a–4b make for placetype, designator and street-type terms without label conditioning. It does not change the size, script or symbol recommendation; mailwoman's sequence labeler emits per-piece logits over a fixed 49-tag head and never reads label text.

## Artifacts

All under `/tmp/claude-1000/-home-lab-Projects-mailwoman/7e14f240-13f5-44e1-8e93-d655724f4fba/scratchpad/sp-audit/`: `draw_sample.py` → `sample.parquet` (1,953,378 rows) + `country_counts.json`; `measure.py` → `current_evalA.json`, `holdout_*.json`; `terms_fit.py` + `extract_terms.mjs` + `extract_terms_extra.py` → `terms_*.json`; `uds_misfire.py`; `case_ppw.py` → `case_ppw_all.json`; `glued_spans.py` → `glued_spans.json`; `train_candidates.py` → `cand_*/tokenizer.model`, `candidate_cards.json`, `uds_seeded*.txt`; `summarize.py` → `summary.md` (appended below).

---

# Appendix: side-by-side tables (holdout, 293,748 rows; current = md5 5c01cdcd…, C1–C5 as in §5)

### Holdout set

current 5c01cdcd4ae25849c5cb26b69fd3dde9 vocab 73143 rows 293748
C1-corpus-same-48k d12e6bf5105d997e5ed66f20d360028b vocab 48000 rows 293748
C2-latin-seeded-48k 74e70808b137424f095bfdcf92d9ac54 vocab 48000 rows 293748
C3-latin-seeded-32k 507a680358d7d301a9a0f4fceb2bfbb0 vocab 32000 rows 293748
C4-latin-seeded-48k-splitdigits ae9a6f2dab82afd70ed298e678da5a16 vocab 48000 rows 293748
C5-latin-seeded-nodigit-48k 9279019e074e1fa30c28f3f8183d6d22 vocab 48000 rows 293748

### Pieces per word

| bucket |  rows | current |    C1 |    C2 |    C3 |    C4 |    C5 |
| ------ | ----: | ------: | ----: | ----: | ----: | ----: | ----: |
| US     | 20784 |   3.713 | 2.120 | 1.972 | 2.026 | 2.400 | 1.880 |
| GB     | 21135 |   3.345 | 2.430 | 2.598 | 2.652 | 2.751 | 2.610 |
| CA     | 20993 |   3.888 | 2.687 | 2.737 | 2.776 | 2.820 | 2.571 |
| AU     | 21047 |   3.033 | 1.729 | 1.929 | 1.997 | 2.192 | 1.779 |
| NZ     |  2021 |   3.106 | 1.907 | 1.843 | 1.911 | 2.016 | 1.768 |
| IN     | 20945 |   4.307 | 2.644 | 2.625 | 2.708 | 2.611 | 2.634 |
| DE     | 21120 |   4.556 | 2.929 | 2.926 | 3.038 | 3.010 | 2.920 |
| FR     | 21134 |   3.470 | 2.175 | 2.253 | 2.324 | 2.550 | 2.197 |
| ES     | 21122 |   4.320 | 2.653 | 2.632 | 2.723 | 2.707 | 2.611 |
| IT     | 21076 |   4.568 | 2.847 | 2.749 | 2.856 | 2.768 | 2.741 |
| JP     | 20948 |   4.397 | 2.788 | 2.469 | 2.612 | 2.835 | 2.551 |
| CN     | 21145 |   7.228 | 4.385 | 4.097 | 4.216 | 4.086 | 4.133 |
| OTHER  | 60278 |   4.085 | 2.327 | 2.407 | 2.526 | 2.727 | 2.270 |

### Pieces per non-space character

| bucket |  rows | current |    C1 |    C2 |    C3 |    C4 |    C5 |
| ------ | ----: | ------: | ----: | ----: | ----: | ----: | ----: |
| US     | 20784 |   0.725 | 0.414 | 0.385 | 0.396 | 0.469 | 0.367 |
| GB     | 21135 |   0.706 | 0.513 | 0.548 | 0.560 | 0.580 | 0.551 |
| CA     | 20993 |   0.734 | 0.507 | 0.517 | 0.524 | 0.532 | 0.485 |
| AU     | 21047 |   0.573 | 0.326 | 0.364 | 0.377 | 0.414 | 0.336 |
| NZ     |  2021 |   0.624 | 0.383 | 0.370 | 0.384 | 0.405 | 0.355 |
| IN     | 20945 |   0.624 | 0.383 | 0.380 | 0.392 | 0.378 | 0.381 |
| DE     | 21120 |   0.545 | 0.350 | 0.350 | 0.363 | 0.360 | 0.349 |
| FR     | 21134 |   0.634 | 0.397 | 0.412 | 0.425 | 0.466 | 0.401 |
| ES     | 21122 |   0.701 | 0.430 | 0.427 | 0.442 | 0.439 | 0.424 |
| IT     | 21076 |   0.704 | 0.439 | 0.423 | 0.440 | 0.427 | 0.422 |
| JP     | 20948 |   0.676 | 0.429 | 0.380 | 0.402 | 0.436 | 0.392 |
| CN     | 21145 |   0.586 | 0.356 | 0.332 | 0.342 | 0.331 | 0.335 |
| OTHER  | 60278 |   0.682 | 0.388 | 0.402 | 0.422 | 0.455 | 0.379 |

### Share of words split into 3+ pieces

| bucket |  rows | current |     C1 |     C2 |     C3 |     C4 |     C5 |
| ------ | ----: | ------: | -----: | -----: | -----: | -----: | -----: |
| US     | 20784 |  57.90% | 19.47% | 17.82% | 19.97% | 35.65% | 17.60% |
| GB     | 21135 |  70.34% | 14.69% | 23.88% | 26.33% | 34.00% | 25.11% |
| CA     | 20993 |  65.86% | 33.57% | 31.75% | 33.21% | 38.37% | 28.75% |
| AU     | 21047 |  51.64% | 12.26% | 20.16% | 23.01% | 33.83% | 16.98% |
| NZ     |  2021 |  50.21% | 22.18% | 18.54% | 21.41% | 27.34% | 17.78% |
| IN     | 20945 |  69.81% | 39.77% | 41.58% | 43.13% | 41.39% | 41.90% |
| DE     | 21120 |  68.27% | 46.64% | 44.88% | 47.13% | 49.61% | 46.12% |
| FR     | 21134 |  46.58% | 22.32% | 23.79% | 25.44% | 39.31% | 24.70% |
| ES     | 21122 |  65.35% | 35.90% | 35.63% | 37.55% | 38.97% | 35.51% |
| IT     | 21076 |  68.65% | 43.05% | 41.17% | 43.35% | 42.70% | 41.65% |
| JP     | 20948 |  57.30% | 42.58% | 35.08% | 37.65% | 34.82% | 36.01% |
| CN     | 21145 |  88.97% | 83.98% | 86.16% | 87.37% | 86.09% | 86.61% |
| OTHER  | 60278 |  69.98% | 30.72% | 36.29% | 39.64% | 42.48% | 31.41% |

### Byte-fallback piece rate

| bucket |  rows | current |    C1 |    C2 |    C3 |    C4 |    C5 |
| ------ | ----: | ------: | ----: | ----: | ----: | ----: | ----: |
| US     | 20784 |   0.08% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| GB     | 21135 |   1.53% | 0.05% | 0.05% | 0.05% | 0.04% | 0.05% |
| CA     | 20993 |   0.01% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| AU     | 21047 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| NZ     |  2021 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| IN     | 20945 |   6.40% | 0.11% | 0.11% | 0.11% | 0.11% | 0.11% |
| DE     | 21120 |   4.33% | 0.09% | 0.09% | 0.08% | 0.08% | 0.09% |
| FR     | 21134 |   0.12% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ES     | 21122 |   9.85% | 0.07% | 0.08% | 0.08% | 0.08% | 0.09% |
| IT     | 21076 |   7.94% | 0.09% | 0.09% | 0.09% | 0.09% | 0.10% |
| JP     | 20948 |   9.93% | 0.50% | 0.54% | 0.51% | 0.47% | 0.54% |
| CN     | 21145 |   2.22% | 1.55% | 1.56% | 1.52% | 1.57% | 1.64% |
| OTHER  | 60278 |   0.82% | 0.07% | 0.07% | 0.07% | 0.06% | 0.07% |

### Unknown-piece rate

| bucket |  rows | current |    C1 |    C2 |    C3 |    C4 |    C5 |
| ------ | ----: | ------: | ----: | ----: | ----: | ----: | ----: |
| US     | 20784 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| GB     | 21135 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| CA     | 20993 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| AU     | 21047 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| NZ     |  2021 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| IN     | 20945 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| DE     | 21120 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| FR     | 21134 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| ES     | 21122 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| IT     | 21076 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| JP     | 20948 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| CN     | 21145 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |
| OTHER  | 60278 |   0.00% | 0.00% | 0.00% | 0.00% | 0.00% | 0.00% |

### Strict straddle rate (pieces covering two tagged spans)

| bucket |  rows | current |     C1 |     C2 |     C3 |     C4 |     C5 |
| ------ | ----: | ------: | -----: | -----: | -----: | -----: | -----: |
| US     | 20784 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| GB     | 21135 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| CA     | 20993 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| AU     | 21047 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| NZ     |  2021 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| IN     | 20945 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| DE     | 21120 |  0.000% | 0.000% | 0.001% | 0.001% | 0.001% | 0.001% |
| FR     | 21134 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| ES     | 21122 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| IT     | 21076 |  0.000% | 0.000% | 0.000% | 0.000% | 0.000% | 0.000% |
| JP     | 20948 |  0.000% | 0.004% | 0.000% | 0.000% | 0.000% | 0.000% |
| CN     | 21145 |  1.290% | 7.354% | 7.664% | 7.186% | 7.713% | 7.468% |
| OTHER  | 60278 |  0.013% | 0.100% | 0.104% | 0.092% | 0.092% | 0.105% |

### Share of spans with a straddled boundary

| bucket |  rows | current |      C1 |      C2 |      C3 |      C4 |      C5 |
| ------ | ----: | ------: | ------: | ------: | ------: | ------: | ------: |
| US     | 20784 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| GB     | 21135 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| CA     | 20993 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| AU     | 21047 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| NZ     |  2021 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| IN     | 20945 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| DE     | 21120 |  0.000% |  0.000% |  0.004% |  0.004% |  0.004% |  0.004% |
| FR     | 21134 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| ES     | 21122 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| IT     | 21076 |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |  0.000% |
| JP     | 20948 |  0.000% |  0.023% |  0.000% |  0.000% |  0.000% |  0.000% |
| CN     | 21145 |  9.585% | 33.719% | 33.399% | 32.030% | 33.565% | 32.724% |
| OTHER  | 60278 |  0.151% |  0.659% |  0.704% |  0.664% |  0.709% |  0.679% |

### Dead pieces (ids never fired on the holdout set)

| model   | vocab | ids fired | dead share |
| ------- | ----: | --------: | ---------: |
| current | 73143 |     32712 |      55.3% |
| C1      | 48000 |     46860 |       2.4% |
| C2      | 48000 |     45788 |       4.6% |
| C3      | 32000 |     30269 |       5.4% |
| C4      | 48000 |     45689 |       4.8% |
| C5      | 48000 |     46111 |       3.9% |

### Per-script (dominant script of the row), pieces per word / byte rate

| script   |   rows |       current |           C1 |           C2 |           C3 |           C4 |           C5 |
| -------- | -----: | ------------: | -----------: | -----------: | -----------: | -----------: | -----------: |
| arabic   |   3086 |   3.22 / 0.7% |  2.65 / 0.0% |  2.81 / 0.0% |  2.98 / 0.0% |  2.75 / 0.0% |  2.80 / 0.0% |
| armenian |   1478 | 10.69 / 79.0% |  3.19 / 0.0% |  3.23 / 0.0% |  3.52 / 0.0% |  3.19 / 0.0% |  3.29 / 0.0% |
| cyrillic |  14644 |   4.21 / 0.8% |  2.65 / 0.0% |  2.80 / 0.0% |  3.00 / 0.0% |  2.86 / 0.0% |  2.69 / 0.0% |
| georgian |    293 | 19.72 / 87.5% |  4.61 / 0.0% |  4.78 / 0.0% |  5.12 / 0.0% |  4.76 / 0.0% |  4.92 / 0.0% |
| greek    |    625 |   4.92 / 0.2% |  3.94 / 0.1% |  4.02 / 0.1% |  4.45 / 0.1% |  3.98 / 0.1% |  4.07 / 0.1% |
| han      |   2375 |   4.23 / 0.5% |  4.34 / 3.1% |  4.51 / 3.1% |  4.64 / 3.1% |  4.55 / 3.1% |  4.57 / 3.3% |
| hangul   |    303 |   3.84 / 0.6% |  3.92 / 3.5% |  4.10 / 3.7% |  4.26 / 3.6% |  4.07 / 3.7% |  4.16 / 3.7% |
| hebrew   |    239 |   3.64 / 0.0% |  3.65 / 0.0% |  3.65 / 0.0% |  3.87 / 0.0% |  3.62 / 0.0% |  3.68 / 0.0% |
| indic    |    692 |  9.22 / 64.8% |  4.44 / 0.1% |  4.42 / 0.1% |  4.97 / 0.1% |  4.39 / 0.1% |  4.63 / 0.1% |
| kana     |   1185 |   4.42 / 0.0% |  4.06 / 0.0% |  4.24 / 0.0% |  4.52 / 0.0% |  4.19 / 0.0% |  4.32 / 0.0% |
| latin    | 266472 |   3.89 / 1.4% |  2.38 / 0.1% |  2.39 / 0.1% |  2.47 / 0.1% |  2.62 / 0.1% |  2.31 / 0.1% |
| none     |   2036 | 10.29 / 22.3% |  4.22 / 0.0% |  3.81 / 0.0% |  4.12 / 0.0% |  7.76 / 0.0% |  4.34 / 0.0% |
| other    |    188 | 21.15 / 87.4% | 6.75 / 11.2% | 6.49 / 11.6% | 6.92 / 10.9% | 6.37 / 11.9% | 6.80 / 11.1% |
| thai     |    132 |   4.67 / 0.0% |  5.03 / 0.3% |  4.93 / 0.3% |  5.74 / 0.2% |  4.89 / 0.3% |  5.21 / 0.3% |

### Per-tag: single-piece span share and pieces per span (US, FR, GB, DE, OTHER)

**US** (spans in holdout)

| tag           | spans |    current |         C1 |         C2 |         C3 |         C4 |         C5 |
| ------------- | ----: | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| region        | 20679 | 88% / 1.16 | 97% / 1.03 | 91% / 1.09 | 91% / 1.09 | 91% / 1.09 | 91% / 1.09 |
| street        | 20235 | 11% / 5.09 | 18% / 2.93 | 12% / 2.74 | 10% / 2.86 | 12% / 2.76 | 14% / 2.70 |
| postcode      | 20234 |  0% / 5.84 | 13% / 2.29 |  2% / 2.43 |  1% / 2.49 |  0% / 4.90 | 14% / 2.33 |
| locality      | 19038 |  9% / 4.83 | 20% / 2.67 | 16% / 2.59 | 13% / 2.72 | 16% / 2.58 | 15% / 2.62 |
| house_number  | 18562 |  2% / 3.57 | 70% / 1.31 |  9% / 1.93 |  9% / 1.94 |  9% / 2.67 | 70% / 1.31 |
| street_suffix | 16691 | 66% / 1.84 | 87% / 1.20 | 92% / 1.09 | 92% / 1.09 | 92% / 1.09 | 92% / 1.09 |
| street_prefix |  5220 | 70% / 1.73 | 84% / 1.32 | 93% / 1.13 | 93% / 1.13 | 93% / 1.13 | 93% / 1.13 |
| unit          |  2702 | 27% / 3.27 | 55% / 1.73 | 34% / 1.91 | 34% / 1.91 | 34% / 2.08 | 55% / 1.57 |
| venue         |  2612 | 0% / 11.52 |  0% / 6.53 |  0% / 5.51 |  0% / 5.84 |  0% / 5.48 |  0% / 5.59 |

**FR** (spans in holdout)

| tag                | spans |    current |         C1 |         C2 |         C3 |         C4 |         C5 |
| ------------------ | ----: | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| locality           | 21007 |  6% / 5.07 |  8% / 4.25 |  4% / 4.40 |  3% / 4.64 |  4% / 4.37 |  4% / 4.48 |
| postcode           | 20508 |  0% / 4.99 | 39% / 1.64 |  0% / 2.00 |  0% / 2.01 |  0% / 3.97 | 40% / 1.63 |
| street             | 20503 |  1% / 5.14 |  2% / 3.86 |  1% / 4.31 |  1% / 4.48 |  1% / 4.28 |  1% / 4.35 |
| house_number       | 20492 | 34% / 1.94 | 91% / 1.09 | 75% / 1.30 | 75% / 1.30 | 75% / 1.33 | 91% / 1.13 |
| street_prefix      | 18732 | 50% / 1.86 | 93% / 1.12 | 99% / 1.01 | 99% / 1.01 | 99% / 1.01 | 99% / 1.01 |
| region             |   430 | 21% / 3.93 | 37% / 2.92 | 63% / 2.09 | 60% / 2.26 | 63% / 2.07 | 62% / 2.14 |
| country            |   221 | 66% / 1.51 | 83% / 1.33 | 83% / 1.18 | 83% / 1.18 | 83% / 1.18 | 83% / 1.18 |
| subregion          |    62 |  3% / 5.00 |  2% / 4.47 |  0% / 4.48 |  0% / 4.69 |  0% / 4.44 |  0% / 4.60 |
| dependent_locality |    32 |  0% / 4.69 |  0% / 4.94 |  0% / 5.16 |  0% / 5.44 |  0% / 5.12 |  0% / 5.16 |

**GB** (spans in holdout)

| tag                | spans |    current |         C1 |         C2 |         C3 |         C4 |         C5 |
| ------------------ | ----: | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| postcode           | 18938 |  0% / 6.07 |  0% / 4.09 |  0% / 4.39 |  0% / 4.41 |  0% / 4.94 |  0% / 4.42 |
| locality           | 12229 | 19% / 3.81 | 37% / 2.63 |  9% / 2.83 |  7% / 3.00 | 10% / 2.82 |  9% / 2.88 |
| region             |  1574 | 23% / 3.85 | 58% / 2.42 | 23% / 2.52 | 22% / 2.68 | 23% / 2.52 | 23% / 2.57 |
| street             |  1384 |  0% / 3.40 |  1% / 2.86 |  0% / 3.25 |  0% / 3.38 |  0% / 3.24 |  0% / 3.28 |
| house_number       |  1119 | 26% / 1.89 | 96% / 1.04 | 85% / 1.17 | 85% / 1.17 | 84% / 1.18 | 97% / 1.04 |
| dependent_locality |  1045 |  6% / 3.56 |  7% / 3.29 |  3% / 3.53 |  2% / 3.72 |  3% / 3.51 |  3% / 3.60 |
| country            |   989 |  5% / 5.54 | 13% / 2.72 | 11% / 3.01 | 11% / 3.01 | 11% / 3.01 | 11% / 3.01 |
| subregion          |   121 |  2% / 5.58 |  0% / 4.37 |  1% / 4.36 |  0% / 4.55 |  1% / 4.34 |  0% / 4.40 |
| venue              |   106 | 1% / 17.22 |  2% / 9.52 |  0% / 7.67 |  0% / 8.20 |  0% / 7.71 |  0% / 7.74 |

**DE** (spans in holdout)

| tag                | spans |    current |         C1 |         C2 |         C3 |         C4 |         C5 |
| ------------------ | ----: | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| region             | 13559 |  4% / 5.54 | 41% / 2.79 | 43% / 2.18 | 43% / 2.19 | 43% / 2.18 | 43% / 2.18 |
| locality           | 10861 |  8% / 4.00 | 19% / 3.36 | 11% / 3.52 | 10% / 3.79 | 12% / 3.50 | 11% / 3.60 |
| dependent_locality |  9427 |  6% / 4.19 |  4% / 3.33 |  2% / 3.41 |  2% / 3.60 |  3% / 3.38 |  2% / 3.46 |
| country            |  6535 |  0% / 2.82 | 58% / 1.62 |  0% / 2.00 |  0% / 2.00 |  0% / 2.00 |  0% / 2.00 |
| street             |  3418 |  6% / 4.20 |  9% / 3.61 |  5% / 3.96 |  4% / 4.18 |  5% / 3.94 |  5% / 4.01 |
| postcode           |  3192 |  0% / 4.97 | 19% / 1.95 |  0% / 2.03 |  0% / 2.10 |  0% / 4.01 | 18% / 2.08 |
| house_number       |  3176 | 34% / 1.79 | 92% / 1.09 | 87% / 1.15 | 86% / 1.16 | 86% / 1.19 | 92% / 1.09 |
| venue              |  1234 | 0% / 13.31 |  0% / 8.18 |  0% / 9.38 |  0% / 9.87 |  0% / 9.35 |  0% / 9.50 |
| subregion          |   551 |  1% / 6.03 |  0% / 4.79 |  0% / 4.78 |  0% / 5.09 |  0% / 4.72 |  0% / 4.85 |

**Other countries** (spans in holdout)

| tag                | spans |    current |         C1 |         C2 |         C3 |         C4 |         C5 |
| ------------------ | ----: | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| locality           | 51903 |  4% / 4.33 | 31% / 2.68 | 21% / 2.90 | 17% / 3.16 | 21% / 2.88 | 20% / 2.98 |
| postcode           | 41746 |  0% / 5.85 | 20% / 2.14 |  0% / 2.67 |  0% / 2.76 |  0% / 4.74 | 21% / 2.18 |
| street             | 40775 |  3% / 7.67 |  2% / 4.74 |  1% / 4.45 |  1% / 4.73 |  1% / 4.42 |  1% / 4.54 |
| house_number       | 36124 | 20% / 2.39 | 83% / 1.23 | 61% / 1.48 | 61% / 1.49 | 60% / 1.67 | 83% / 1.23 |
| region             |  8210 |  2% / 5.07 | 30% / 2.42 | 18% / 2.55 | 17% / 2.57 | 18% / 2.55 | 17% / 2.56 |
| country            |  6735 |  2% / 3.66 | 55% / 2.01 | 18% / 1.82 | 18% / 1.82 | 18% / 1.82 | 18% / 1.82 |
| dependent_locality |  3436 |  1% / 6.11 |  5% / 4.00 |  2% / 4.20 |  1% / 4.51 |  2% / 4.18 |  2% / 4.27 |
| venue              |  3233 | 0% / 12.04 |  1% / 8.14 |  1% / 8.05 |  1% / 8.43 |  0% / 8.03 |  0% / 8.16 |
| street_prefix      |  2769 | 76% / 1.28 | 99% / 1.01 | 97% / 1.03 | 97% / 1.04 | 97% / 1.03 | 97% / 1.04 |

### Term lists: share of terms split (lower is better)

| term list                         | terms |     current |          C1 |          C2 |          C3 |          C4 |          C5 |
| --------------------------------- | ----: | ----------: | ----------: | ----------: | ----------: | ----------: | ----------: |
| codex/us/unit-designator          |    90 |  93% (3.17) |  64% (1.94) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/floor-designator         |    22 |  91% (3.36) |  82% (2.55) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/po-box                   |     8 | 100% (3.79) |  50% (1.50) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/military-address         |    26 |  96% (2.37) |  81% (1.90) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/street/directional       |    40 |  57% (2.48) |  28% (1.58) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/street/suffix            |  1098 |  94% (3.13) |  77% (2.05) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/us/state                    |   112 |  15% (1.22) |   4% (1.07) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/fr/voie                     |    62 |  79% (2.15) |  27% (1.31) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/fr/region                   |    74 |  89% (2.31) |  72% (1.89) |   5% (1.18) |   5% (1.21) |   5% (1.18) |   5% (1.18) |
| codex/fr/departement              |   223 |  83% (2.44) |  37% (1.81) |   3% (1.12) |   3% (1.14) |   3% (1.12) |   8% (1.19) |
| codex/de/street-type              |    34 |  65% (1.88) |  35% (1.47) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/de/bundesland               |    93 |  88% (3.10) |  45% (1.99) |  14% (1.47) |  14% (1.47) |  14% (1.47) |  14% (1.47) |
| codex/gb/street-type              |    45 |  62% (1.89) |  29% (1.33) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/gb/country                  |    10 |  70% (2.09) |  70% (1.73) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/gb/place-name               |    20 |  15% (1.15) |   5% (1.05) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/ca/street-type              |    61 |  62% (1.87) |  11% (1.11) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/ca/province                 |    68 |  85% (2.55) |  50% (1.89) |   6% (1.29) |   6% (1.29) |   6% (1.28) |   6% (1.28) |
| codex/au/level-designator         |    68 |  82% (3.14) |  66% (1.97) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/au/delivery-service         |    30 |  97% (4.09) |  80% (1.97) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/au/state                    |    16 |  81% (2.13) |  44% (1.48) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/nz/delivery-service         |    16 | 100% (2.93) |  75% (2.52) |  12% (1.55) |  12% (1.55) |  12% (1.55) |  12% (1.55) |
| codex/jp/address-unit             |    13 |   8% (1.08) |   8% (1.08) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/jp/prefecture               |   242 |  88% (2.22) |  42% (1.67) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   3% (1.03) |
| codex/es/co-official-languages    |    20 |  95% (2.68) |  45% (1.73) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/address/system-conventions  |     5 | 100% (4.60) |  60% (4.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| codex/address/layouts             |    33 |  73% (2.52) |  48% (2.00) |   3% (1.21) |   3% (1.21) |   3% (1.21) |   3% (1.21) |
| neural/venue-structure            |    21 |  81% (2.19) |  29% (1.38) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| wof/placetype-names               |    35 |  97% (3.49) |  80% (2.63) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| wof/candidate.db placetype_codes  |    12 |  92% (3.83) |  75% (2.92) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| intent/TOPONYM_HEAD_PARTICLES     |    70 |  60% (1.66) |  16% (1.18) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| intent/TOPONYM_TAIL_NOUNS         |    22 |  45% (1.59) |   9% (1.09) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| intent/near-me locators           |    15 |  93% (1.75) |  80% (1.58) |  93% (1.81) |  93% (1.81) |  93% (1.78) |  93% (1.81) |
| query-shape/PO_BOX_LEADERS        |     9 |  89% (2.67) |  67% (2.44) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| query-shape/known-format examples |    18 | 100% (4.04) |  72% (2.41) | 100% (2.44) | 100% (2.52) | 100% (3.33) |  67% (2.30) |
| activity-lexicon/phrases          |    11 | 100% (3.00) | 100% (2.61) | 100% (3.00) | 100% (3.00) | 100% (3.00) | 100% (3.07) |
| poi-taxonomy/synonym phrases      |    55 |  96% (2.63) |  87% (1.96) |  93% (2.05) |  93% (2.15) |  93% (2.05) |  93% (2.12) |
| poi-taxonomy/category labels      |  2113 |  97% (2.70) |  93% (2.24) |  96% (2.31) |  96% (2.49) |  95% (2.30) |  96% (2.34) |
| poi-taxonomy/venue-word-hints     |  2249 |  99% (3.14) |  98% (2.63) |  98% (2.86) |  98% (2.95) |  98% (2.84) |  98% (2.89) |
| q4/street types en                |    47 |  38% (1.85) |   4% (1.06) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/street types fr                |    36 |  61% (2.31) |  25% (1.33) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/street types de                |    20 |  60% (1.80) |  15% (1.15) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/street types es                |    23 |  83% (2.43) |  61% (1.74) |   4% (1.04) |   4% (1.04) |   4% (1.04) |   4% (1.04) |
| q4/street types it                |    21 |  95% (2.76) |  67% (1.86) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/street types ja/zh             |    22 |  14% (1.14) |  14% (1.14) |   9% (1.09) |   9% (1.09) |   9% (1.09) |   9% (1.09) |
| q4/unit designators               |    59 |  73% (1.90) |  58% (1.69) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/venue head words               |   117 |  68% (2.27) |  47% (1.74) |   0% (1.00) |   0% (1.00) |   0% (1.00) |   0% (1.00) |
| q4/postcode shapes                |    23 | 100% (4.48) |  78% (2.38) | 100% (2.41) | 100% (2.45) | 100% (3.86) |  78% (2.28) |
| q4/house-number patterns          |    29 |  93% (2.68) |  45% (1.49) |  72% (1.78) |  72% (1.78) |  79% (2.14) |  52% (1.57) |

### Pieces per word by word class (holdout, up to 4000 rows per bucket, all six vocabularies)

| word class |  words | current |   C1 |   C2 |   C3 |   C4 |   C5 |
| ---------- | -----: | ------: | ---: | ---: | ---: | ---: | ---: |
| ALLCAPS    |  42933 |    5.23 | 2.91 | 2.19 | 2.27 | 2.19 | 2.22 |
| cased      | 103809 |    2.86 | 2.20 | 2.45 | 2.55 | 2.44 | 2.48 |
| digits     |  27577 |    3.72 | 1.54 | 1.94 | 1.96 | 2.94 | 1.54 |
| alnum      |   9496 |    4.40 | 3.85 | 3.95 | 3.95 | 4.11 | 3.95 |
| punct      |    113 |    1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 |
