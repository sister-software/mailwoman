# Tokenizer + CJK prior-art survey synthesis (2026-07-30)

Four parallel Opus research threads (operator-commissioned): Latin tokenizer alternatives, CJK
segmentation alternatives, the CJK address-parser prior-art landscape, and the JP character
inventory + dictionary licensing. Full reports lived in the session; this doc carries every
load-bearing finding. Verdicts first, receipts after.

## Verdicts

1. **Latin: keep SentencePiece unigram.** Nothing better-fitting exists under our constraints
   (browser WASM, deterministic char offsets, int8 ONNX, 40M-param scale). Two free levers found:
   **vocabulary pruning** (shipped-eval utilization ~6.7%, ceiling 24%; the embedding table is
   ~72.5% of model parameters) and a **WASM rebuild on SentencePiece 0.2.2** (native offsets).
2. **CJK: character-level with a composition window confirmed** — the only browser-feasible class
   (our sealed vocab ~24KB vs 40–380MB for every dictionary-based segmenter; TinySegmenter at
   20.6KB is the lone peer and is also a dictionary-free char model).
3. **The evidence channels are LOAD-BEARING for char-level NER, not supplementary.** Two
   literatures converge independently: CANINE loses NER by −13.8 F1 vs mBERT (its own authors:
   "NER rewards memorization"), repaired to −1.1 by n-gram/lexicon features; Zhang & Yang (ACL 2018) show char beats word for Chinese NER only WITH lexicon channels. Mailwoman externalized
   memorization into gazetteer/FST/lexicon channels years ago — that architecture is precisely
   why our char path works. Pin this as a PRECONDITION in every future char-model
   pre-registration (the Leg-2 bare-vs-bare ~0.5pp gap was measured in the char model's hardest
   configuration).
4. **The JP ship is a category first.** No open-source, in-process, neural address parser exists
   for Japanese or Korean. The one CJK neural prior art is Chinese: Alibaba DAMO's MGeo
   (Apache-2.0, 8.3M downloads, F1 92.39 on GeoGLUE) — Python/ModelScope-only, no ONNX, no
   browser. Everything else in the JP/KR ecosystems is regex + dictionary, with runtime HTTP
   fetches or multi-GB local databases.
5. **⚠ KR is legally gated; TW is the clean second CJK locale.** The juso bulk DB carries a
   signed pledge: 국외 반출 금지 (no export from Korea) + no-commercial/no-redistribution ToS —
   the acquired 6.17M juso rows need counsel BEFORE any training touches them (G1 agenda item).
   OpenAddresses KR is dead (frozen 2017); Overture does not cover KR at all. Taiwan, by
   contrast: OGDL-Taiwan-1.0 (CC BY 4.0-compatible), current OpenAddresses, 9.7M rows already on
   disk. **Recommendation: re-weight Phase 6 from KR-next to TW-next unless counsel clears juso.**
6. **CN is out of scope on law, not tech** (private surveying illegal, GCJ-02 obfuscation
   mandatory, API ToS bar storage). The one buildable precedent: GeoGLUE itself annotates on OSM
   to route around the mapping-data regime.

## The steal list (JP Phases 3–5)

- **Normalization tables** (Geolonia + ABR are canonical): the two-register numeral convention
  (町丁目 digits → kanji numerals; 番地/号 → Arabic with 番地/番/号 → `-`, so `1番3号` ≡ `1-3`);
  variant folding NFKC does NOT do (ヶ/ケ/が/ガ, 之/ノ/の, 新字体↔旧字体); prefecture/county
  completion; the non-丁目 tail (Sapporo 条, Iwate 地割, 甲乙丙/いろは, 無番地); half-width
  katakana folding with its length-changing dakuten composition.
- **Kyoto 通り名: keep it in a dedicated field** (ABR's `kyoto_st`), never delete it (Geolonia's
  choice loses information; 大和大路通正面下る大和大路2 is the documented worst case).
- **ABR's 7-level match ladder** with `match_level` reported SEPARATELY from
  `coordinates_level` — the meaning-of-zero discipline, independently invented by the Japanese
  government; its 24-field output is a ready-made resolve-schema target.
- **A residual tag for non-address content** (MGeo's `other`; ABR's `unmatched_address`) —
  delivery notes and building names are not parse failures.
- **Romanization lexicon for free**: Geolonia v1 carries kana + romaji for 277k town-level rows
  (CC BY 4.0). abr-geocoder cannot search romaji — a differentiator, not parity.
- **Historical address conversion is the commercial moat** (ZENRIN sells it; no open equivalent;
  ABR's masters carry effective dates — the raw material is GREEN-licensed and unpackaged).
- **KR structure notes** (whenever KR unblocks): 지하 is a building-number PREFIX; 행정동 is
  officially "reference only" (never key on it); road names are closed-up with embedded digit
  runs (테헤란로4길 — directly relevant to digit ownership); the jibeon↔road crosswalk is 1:N
  with a representative flag.

## Found bugs / gaps in our own code (filed)

- `normalize/cjk.ts` folds U+FF01–FF5E only: **half-width katakana (U+FF66–FF9F) passes through**
  (篠ﾉ井 unfolded; ﾃﾞ→デ contracts string length — the offset map must handle it), and the hyphen
  class folds only U+FF0D — **U+2212 (IME minus), U+30FC (prolonged-sound mark typed as hyphen),
  U+2010/2015/FE63/FF70 all survive** into real JP input. A hyphen-equivalence class is
  mandatory.
- The JP char vocab must be rebuilt from the FULL Phase-3 shard (probe vocab 1,918 vs 2,640
  distinct kanji in full MLIT data; the tail is proper-noun kanji — the class an address parser
  exists for). Alternative under consideration: hash-bucket OOV fallback.
- Non-BMP correctness: 49.5% of Japan's official administrative character set is outside the
  BMP; two Plane-2 kanji (𨦻 𨫤) are verified real place names in Overture-JP. The TS decode
  path must be code-point-native (the #519 scar generalizes).

## Latin-side exclusions (receipts, so nobody re-litigates cheaply)

- Learned/dynamic chunking: static boundaries beat learned at exactly our scale (41M-param
  study; WikiANN static 66.79 vs learned ≤66.57 vs BPE 61.39).
- BLT: CC-BY-NC + a 100M-param entropy LM at inference (+~62% FLOPs) + a 1.5B-scale negative.
- Byte-SSMs: no fused Mamba ONNX op; loop path 17× slower than realtime at 9.6M params; contrib
  ops float-only (no int8).
- FLOTA: lossy — cannot carry char-offset gold. CANINE bare: −13.8 NER.
- Per-word CharCNN structural limit for Latin: an intra-word tag boundary is unrepresentable
  (`12-14`, `123A`, `SW1A 1AA`) — pure char mode (built for JP) is the Latin variant if the v9
  unification ever runs.
- Supporting the v9 door staying open: ByT5 beats mT5 on NER at every size (+4.2 at Small),
  ByT5 loses only −1.5 under random-case noise vs mT5's −25.7 (the user-register doctrine,
  externally replicated); CharacterBERT reaches parity at fewer params with +5 F1 at 40% noise;
  char gains are 5–10× larger off-English (Dutch +8.6) — exactly our multi-locale condition.

## JP dictionary licensing (if a JP dictionary channel is ever wanted)

ipadic is Debian-non-free (blocks npm shipping; Kuromoji's bundled model inherits it);
jumandic has no license file upstream; **the clean path is SudachiDict (Apache-2.0) + UniDic
(BSD-3)**. MJ文字情報一覧表 + MJ縮退マップ (the official variant-collapse tables) are CC BY-SA
2.1 JP — share-alike, a real constraint on shipping a derived normalization table. Our
char-level design needs none of these at inference; the itaiji problem (辺/邊/邉; 舘/館 near
coin-flips in real data) is resolver-side normalization, sourceable from GREEN data.

## Data-licensing summary for the CJK roadmap

| Region | Verdict             | Note                                                                                                                                                                                                                                           |
| ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JP     | GREEN               | ABR PDL-1.0 (CC BY 4.0-compatible; modification notice required), MLIT PDL-1.0, Geolonia CC BY 4.0, KEN_ALL copyright expressly disclaimed. Parcel-level (地番) is AMBER (a second MoJ grant rides it).                                        |
| KR     | RED pending counsel | juso ToS + the export pledge; portal metadata saying "no restriction" does NOT override the statute. VWorld unverifiable from here.                                                                                                            |
| TW     | GREEN               | OGDL-Taiwan-1.0 with a per-agency attribution manifest (~21 entries) shipped in the package; attribution failure voids ab initio; pin/archive against §5.2 withdrawal. Chunghwa Post 3+3 postcodes are RED (no distribution/adaptation grant). |
| CN     | RED                 | Law, not licensing.                                                                                                                                                                                                                            |
| HK     | AMBER               | ALS bulk exists; terms silent on adaptation/sublicense — same counsel posture as osm/.                                                                                                                                                         |

## Consequences folded into standing plans

1. G1 counsel agenda += the juso export question + HK ALS adaptation + (already there) ODbL.
2. CJK Phase 6 provisionally re-pointed KR → TW pending the juso answer (operator call).
3. Phase-3 shard build: full-shard vocab rebuild + the normalization steal-list; Phase-5 runtime:
   code-point-native decode + the cjk.ts folding fixes.
4. v9 unification pre-registration must name the channels-attached condition.
5. Vocab pruning + SP 0.2.2 WASM: banked as v8.4-class Latin levers (not this arc).
