# Tokenizer + CJK prior-art survey synthesis (2026-07-30)

Four parallel Opus research threads (operator-commissioned): Latin tokenizer alternatives, CJK
segmentation alternatives, the CJK address-parser prior-art landscape, and the JP character
inventory with dictionary licensing. The full reports existed only in the session, and this doc
records every required finding. Verdicts come first and receipts after.

## Verdicts

1. **Latin: keep SentencePiece unigram.** No better-fitting tokenizer exists under our constraints
   (browser WASM, deterministic char offsets, int8 ONNX, 40M-param scale). The survey found two
   changes that cost nothing in accuracy. The first was **vocabulary pruning**: shipped-eval
   utilization was about 6.7% with a 24% ceiling, and the embedding table is about 72.5% of model
   parameters. **Correction 2026-07-31: the full-feed measurement falsified the 24% ceiling (86.27%
   of pieces fired over all 684M rows), so the pruning change is abandoned. See
   `2026-07-31-sp-vocab-pruning-verdict.md`.** The second was a **WASM rebuild on SentencePiece
   0.2.2** with native offsets, shipped 2026-07-31 as `@mailwoman/sentencepiece-wasm` (PR #1379).
2. **CJK: the survey confirmed character-level tokenization with a composition window.** It is the
   only browser-feasible class. Our sealed vocab is about 24KB, against 40–380MB for every
   dictionary-based segmenter. TinySegmenter, at 20.6KB, is the only peer, and it is also a
   dictionary-free char model.
3. **Char-level NER requires the evidence channels.** Two literatures reach this independently.
   CANINE trails mBERT on NER by 13.8 F1 (its authors write that "NER rewards memorization"), and
   n-gram/lexicon features reduce the gap to 1.1. Zhang & Yang (ACL 2018) show that char models beat
   word models for Chinese NER only with lexicon channels. Mailwoman moved memorization into
   gazetteer, FST and lexicon channels years ago, and that architecture is why our char path
   works. Every future char-model pre-registration must state this as a precondition. The Leg-2
   bare-vs-bare gap of about 0.5pp was measured in the char model's hardest configuration.
4. **The JP ship would be the first of its kind.** No open-source, in-process, neural address
   parser exists for Japanese or Korean. The only CJK neural prior art is Chinese: Alibaba DAMO's
   MGeo (Apache-2.0, 8.3M downloads, F1 92.39 on GeoGLUE). MGeo runs only on Python/ModelScope and
   has neither an ONNX export nor a browser build. Everything else in the JP/KR ecosystems is regex
   plus dictionary, with runtime HTTP fetches or multi-GB local databases.
5. **⚠ KR is legally conditional, and TW is the clean second CJK locale.** The juso bulk DB
   requires a signed pledge of 국외 반출 금지 (no export from Korea), and its ToS forbid commercial
   use and redistribution. The 6.17M juso rows we acquired need counsel review before any training
   uses them (G1 agenda item). OpenAddresses KR has been frozen since 2017, and Overture does not
   cover KR. Taiwan has OGDL-Taiwan-1.0 (CC BY 4.0-compatible), current OpenAddresses data, and
   9.7M rows already on disk. **Recommendation: re-weight Phase 6 from KR-next to TW-next unless
   counsel clears juso.**
6. **CN is out of scope for legal rather than technical reasons.** Private surveying is illegal,
   GCJ-02 obfuscation is mandatory, and API ToS bar storage. The one buildable precedent is
   GeoGLUE, which annotates on OSM to avoid the mapping-data regime.

## The steal list (JP Phases 3–5)

- **Normalization tables** (Geolonia and ABR are canonical):
  - The two-register numeral convention. 町丁目 digits become kanji numerals, and 番地/号 become
    Arabic numerals with 番地/番/号 → `-`, so `1番3号` ≡ `1-3`.
  - Variant folding that NFKC does not do (ヶ/ケ/が/ガ, 之/ノ/の, 新字体↔旧字体).
  - Prefecture and county completion.
  - The non-丁目 tail (Sapporo 条, Iwate 地割, 甲乙丙/いろは, 無番地).
  - Half-width katakana folding, including dakuten composition, which changes string length.
- **Kyoto 通り名: keep it in a dedicated field** (ABR's `kyoto_st`) rather than deleting it.
  Geolonia deletes it and loses information. 大和大路通正面下る大和大路2 is the documented worst
  case.
- **ABR's 7-level match ladder** reports `match_level` separately from `coordinates_level`. The
  Japanese government arrived independently at our meaning-of-zero convention, and its 24-field
  output is a ready-made resolve-schema target.
- **A residual tag for non-address content** (MGeo's `other`, ABR's `unmatched_address`). Delivery
  notes and building names are not parse failures.
- **A romanization lexicon at no cost:** Geolonia v1 carries kana and romaji for 277k town-level
  rows (CC BY 4.0). abr-geocoder cannot search romaji, so this would put Mailwoman ahead of it
  rather than at parity.
- **Historical address conversion has commercial value.** ZENRIN sells it, and no open equivalent
  exists. ABR's masters carry effective dates, so the raw material is GREEN-licensed but
  unpackaged.
- **KR structure notes** (for when KR is unblocked):
  - 지하 is a building-number prefix.
  - 행정동 is officially "reference only", so never key on it.
  - Road names are written without spaces and contain digit runs (테헤란로4길), which bears
    directly on digit ownership.
  - The jibeon↔road crosswalk is 1:N with a representative flag.

## Found bugs / gaps in our own code (filed)

- `normalize/cjk.ts` folds only U+FF01–FF5E. **Half-width katakana (U+FF66–FF9F) passes through
  unfolded** (篠ﾉ井). Folding ﾃﾞ→デ changes string length, so the offset map must handle it. The
  hyphen class folds only U+FF0D, so **U+2212 (IME minus), U+30FC (prolonged-sound mark typed as
  a hyphen) and U+2010/2015/FE63/FF70 all survive** in real JP input. The normalizer needs a
  hyphen-equivalence class.
- The JP char vocab must be rebuilt from the full Phase-3 extract. The probe vocab has 1,918 kanji,
  and the full MLIT data has 2,640 distinct kanji. The missing tail is proper-noun kanji, which is
  the class an address parser exists to handle. A hash-bucket OOV fallback is under consideration
  as an alternative.
- Non-BMP correctness: 49.5% of Japan's official administrative character set is outside the BMP.
  Two Plane-2 kanji (𨦻 𨫤) are verified real place names in Overture-JP. The TS decode path must
  work on code points. The lesson from #519 applies here too.

## Latin-side exclusions (receipts, so nobody re-litigates cheaply)

- Learned/dynamic chunking: static boundaries beat learned ones at our scale (a 41M-param study
  with WikiANN static 66.79, learned ≤66.57, BPE 61.39).
- BLT: licensed CC-BY-NC, needs a 100M-param entropy LM at inference (+~62% FLOPs), and has a
  negative result at 1.5B scale.
- Byte-SSMs: ONNX has no fused Mamba op, the loop path runs 17× slower than realtime at 9.6M
  params, and the contrib ops are float-only (no int8).
- FLOTA: lossy, so it cannot carry char-offset gold. CANINE without channels: −13.8 NER.
- Per-word CharCNN has a structural limit for Latin. It cannot represent a tag boundary inside a
  word (`12-14`, `123A`, `SW1A 1AA`). Pure char mode (built for JP) is the Latin variant if the v9
  unification ever runs.
- Evidence for keeping v9 open: ByT5 beats mT5 on NER at every size (+4.2 at Small). Under
  random-case noise, ByT5 loses only 1.5 while mT5 loses 25.7, which replicates the user-register
  doctrine externally. CharacterBERT reaches parity with fewer params and gains 5 F1 at 40% noise.
  Char gains are 5–10× larger outside English (Dutch +8.6), which matches our multi-locale
  condition.

## JP dictionary licensing (if a JP dictionary channel is ever wanted)

ipadic is Debian-non-free, which blocks npm shipping, and Kuromoji's bundled model inherits that
license. jumandic has no license file upstream. **The clean path is SudachiDict (Apache-2.0) plus
UniDic (BSD-3).** MJ文字情報一覧表 and MJ縮退マップ (the official variant-collapse tables) are CC
BY-SA 2.1 JP. Share-alike is a real constraint on shipping a derived normalization table. Our
char-level design needs none of these at inference. The itaiji problem (辺/邊/邉, and 舘/館 at
near coin-flip rates in real data) belongs to resolver-side normalization and can be sourced from
GREEN data.

## Data-licensing summary for the CJK roadmap

| Region | Verdict             | Note                                                                                                                                                                                                                                           |
| ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JP     | GREEN               | ABR PDL-1.0 (CC BY 4.0-compatible; modification notice required), MLIT PDL-1.0, Geolonia CC BY 4.0, KEN_ALL copyright expressly disclaimed. Parcel-level (地番) is AMBER (a second MoJ grant rides it).                                        |
| KR     | RED pending counsel | juso ToS + the export pledge; portal metadata saying "no restriction" does not override the statute. VWorld unverifiable from here.                                                                                                            |
| TW     | GREEN               | OGDL-Taiwan-1.0 with a per-agency attribution manifest (~21 entries) shipped in the package; attribution failure voids ab initio; pin/archive against §5.2 withdrawal. Chunghwa Post 3+3 postcodes are RED (no distribution/adaptation grant). |
| CN     | RED                 | Law rather than licensing.                                                                                                                                                                                                                     |
| HK     | AMBER               | ALS bulk exists; terms silent on adaptation/sublicense — same counsel posture as osm/.                                                                                                                                                         |

## Addendum 2026-07-30 — the KR alternative path (operator prompt: WOF + the data-sources vein)

The RED verdict above applies only to the **juso bulk address register**. It does not cover Korea as a whole. Two
assets we already hold change the Phase-6 picture:

1. **WOF-KR is already in our shipped admin DB** (`admin-global-priority.db`). It has 18 regions,
   308 counties, 1,482 localadmins, 50,465 localities and 693 neighborhoods, with centroids and
   68,658 Korean-language name records (Hangul 충청북도, the alias 충북, and hanja 忠淸北道). Its
   license is clean (the WOF CC0/CC-BY family). WOF-KR covers the admin and resolve side. WOF has
   no streets or house numbers anywhere, which is the known hierarchy gap.
2. **`.notes/data-sources.md` already lists the corpus source: localdata.go.kr.** It covers every
   permitted business in Korea under KOGL (attribution required, commercial use and derivatives
   allowed). Each record has both the road-name and the jibun address, which is the dual-system
   pairing signal the notes point out. This is a different legal object from the juso register.
   It is business-permit disclosure data published for public release, and it is not covered by
   the 도로명주소법 pledge that binds the address DB. HIRA, NEIS and FSS are the cross-check
   registries, per the notes' triangulation principle.

**The assembled KR recipe without juso:** the parse corpus combines localdata, synthetic data
generated from the schema, and the clean NEIS/HIRA registers. Localdata mixes both address formats,
and that mix is the training signal. The synthetic data covers 지하 prefixes and road names with
embedded digit runs, and the official rendering rules are public documentation. The gazetteer is
the WOF-KR admin ladder. This recipe cannot provide rooftop geocoding, since house-number → point
still depends on juso or a partner. Resolve reaches the admin/locality-centroid tier. Several EU
locales shipped at that tier before their coverage arcs, following the coverage-not-retrain
precedent.

**Operator disposition (2026-07-30): the KR framework is decided.**

- Parse uses the no-juso recipe above. It also uses OSM-KR through the osm/ implementation, which
  is disabled but retained, with ODbL data quarantined per standing practice.
- Juso becomes a **plug-and-play build-local layer** on the layer interface. We ship
  `gazetteer build juso`, written against the documented format and synthetic fixtures. We do not
  touch real juso data ourselves before counsel review. The customer acquires juso under their own
  grant and builds in-country. The layer manifest carries the juso obligations as a structural
  notice, and the resolver's AddressPointLookup consumes the layer as a tier upgrade
  (locality-centroid → rooftop).
- The GTM framing is that the export pledge blocks every cloud geocoder. In-process self-hosting is
  the only legal path to rooftop KR, and that is the product.

**The counsel question is now narrower.** It was "clear the juso export pledge". It is now (a)
confirm the KOGL type on the specific localdata datasets and (b) confirm that the address-register
rule does not cover business-permit addresses. Phase-6 sequencing is an ordinary product call
again. TW is the full-stack second CJK locale. KR parse capability can be built now from the
alternative source, and KR rooftop remains conditional.

## Consequences folded into standing plans

1. The G1 counsel agenda adds the juso export question and HK ALS adaptation. ODbL is already on
   it.
2. CJK Phase 6 is provisionally re-pointed from KR to TW pending the juso answer (operator call).
3. The Phase-3 extract build gets the full-extract vocab rebuild and the normalization steal-list.
   The Phase-5 runtime gets code-point-native decode and the cjk.ts folding fixes.
4. The v9 unification pre-registration must state the channels-attached condition.
5. Vocab pruning and the SP 0.2.2 WASM are banked as v8.4-class Latin changes, outside this arc.
