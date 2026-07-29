# v8 — Crossing the non-Latin (CJK) threshold: architecture plan

Epic #1176. North star: parse JP (then KR, then CN/TW) into resolvable components without regressing the Latin 23.

_Planning artifact. Grounded in: `what-mailwoman-is.mdx`, `SCHEMA.mdx`, `model.py` (CharCNNEncoder), `char_tokenizer.py`, `neural-weights-en-us/model-card.json`, the #825 bsplice postmortem, and the shard-recipe pipeline. No code touched._

---

## TL;DR (the decisions)

1. **Approach A (char-level encoder), deployed script-routed (C at the runtime layer). Reject B outright.** A and C are not competitors — A is the _encoder_, C is the _shipping mechanism_. The Latin SP model is not touched at all; a new char-level CJK model ships beside it and a script-router dispatches. This makes the forgetting guard **provable, not measured** (Latin bytes are identical → diff 0 CI[0,0], the same proof the #825 mean-init won on).
2. **The char path is already half-built.** `CharCNNEncoder` (`model.py`) + `char_tokenizer.py` are committed, ONNX-clean, and gated-off — the deliberate "CJK-forward path" from #825. v8 activates and trains it; it is not a from-scratch encoder rebuild. This collapses the cost gap that made A look expensive.
3. **Schema is already done on paper.** The seven JP tags (`prefecture`/`municipality`/`district`/`block`/`sub_block`/`building_number`/`building_name`) are declared in `COMPONENT_TAGS` and gated by `LocaleProfile.componentsSupported`. v8 activates them — a universal-schema extension, not a JP-private fork.
4. **The real long pole is not the encoder or the schema — it is corpus BIO alignment over _unsegmented_ kanji.** Overture gives field _values_ (`street=字崎枝`), not character-level spans, and JP addresses have no whitespace. Aligning fields back to a space-free string is the hidden risk (§5). De-risk it in week 1, before any training.
5. **Model the large-to-small order natively (model-first). Do not normalize.** A human reads order from context; the model must too. The block grammar is learned from labels, not rewritten by a preprocessor.

---

## 1. The decision: A vs B vs C, and the probe that settles it

### Why B is rejected before the probe (it fights known scar tissue)

The #825 postmortem is the whole argument. A Slavic-diacritic **retrain on the same subword tokenizer failed** — root cause was tokenizer fragmentation, and _data cannot fix a fragmentation a unigram vocab structurally cannot emit_. CJK is that failure mode maximised: there are no coherent CJK subword pieces in `v0.9.0-multisplice` at all, only byte-pieces. B's three named risks (Latin dilution, vocab blowup, F1-comparison invalidation) are all real, but the disqualifier is subtler: **B forces the choice between diluting the hardened Latin model or forking it anyway** — and if you fork it anyway, you have paid the multilingual-retrain tax _and_ still ship two models. B is strictly dominated.

There is also a structural fact that inverts the "A is the big rebuild" intuition: **the embedding table already dominates the model.** 73,143 pieces × 384 = ~28M of the ~29M total params; the transformer body is only ~8.87M. A char-level front-end collapses that table to a few-thousand-char vocab. **The char model is _smaller_, not bigger** — it is easier on the pocket budget, not harder. The "biggest rebuild" framing was true when char-level meant writing a new encoder; it is false now that `CharCNNEncoder` exists.

### The recommendation: A internally, C at the boundary

- **A (char-level CharCNN):** the CJK model's front-end. Word-composition-from-characters, so there is no subword vocab to fragment CJK. Already scaffolded, ONNX-clean (Embedding + Conv1d + ReLU + masked max-pool + Linear — all runtimes accept it).
- **C (script-routing):** the _deployment_. Detect script (trivial: Unicode block histogram on the raw string — the `query-shape` stage already computes character-class priors and is the natural home). Route CJK → char model, Latin → the untouched SP model. Ship side-by-side.

This buys the one property the operator demanded — "a new capability, not a trade" — **by construction**. The Latin model is not retrained, not spliced, not touched. Its regression is provably zero.

The open question that A-internally leaves unresolved, and that the probe must answer, is whether the two models eventually **unify** into one char model serving all scripts. Unification is elegant (one transformer body, shared) and is the bitter-lesson-honest end state. But it re-introduces the dilution risk. **Decision: do not unify in v8.** Ship dual-path. Treat unification as a later consolidation gated on a Latin bake-off (§3).

### The cheapest pre-registered probe

Two legs, both ~1-hour A100 retrains at this model size (the pocket budget's iteration loop is the point). Pre-register both reads before running.

**Leg 1 — CJK viability (the go/no-go for A on CJK):**

- Build ~200k JP rows from Overture-JP on the JP schema subset (§2), aligned to character-level BIO (§5 must be solved first — this is the gate on the gate).
- Wire the data loader to feed `char_ids` (currently `char_tokenizer.encode_row_charword` exists but `data_loader.py` has no char path — this is the one piece of real plumbing the probe needs).
- Train the **bare** char model — no anchor/gazetteer/phrase channels (the scaffolding docstring already scopes the probe this way; channels re-align per-word only after the probe confirms).
- Eval on a **held-out JP coordinate-acceptability board**, held out by locality bucket (the same discipline as the Latin coord boards).
- **Falsifiable read:** bare-char-JP reaches coordinate-acceptability ≥ the bare-Latin-model floor (~0.70 oracle@5, the substrate baseline). PASS → A is viable for CJK, proceed to the phased build. FAIL → the bottleneck is upstream of the encoder (alignment or schema), diagnose before spending on channels.

**Leg 2 — the unification bake-off (decides dual-path-forever vs eventual-merge):**

- Train the _same_ bare char model on the _Latin_ corpus. Compare to the bare SP Latin model on the existing Latin coord boards.
- **Falsifiable read:** does char-level match SP on Latin (within noise on US comma-free + FR-fragment)? If **yes**, unification is on the table for a future major. If **no**, dual-path is permanent — which is _fine_ (C handles it), but you want that answer now, cheaply, not after committing to a merge.

Leg 1 gates v8. Leg 2 gates the _shape of v9+_ and costs one extra retrain — run it in the same session.

---

## 2. Schema / grammar

### The tags exist; activate them

`COMPONENT_TAGS` already declares the JP seven (`SCHEMA.mdx` §JP-specific), gated behind `LocaleProfile.componentsSupported`. This was Phase-0 foresight paying off exactly as designed ("so that schema additions in Phase 6 do not require a core rewrite"). v8 is that Phase 6.

Mapping the chōme-banchi system to the tags:

| JP element                   | tag               | example        |
| ---------------------------- | ----------------- | -------------- |
| 都道府県 prefecture          | `prefecture`      | 東京都         |
| 市区町村 city/ward           | `municipality`    | 千代田区       |
| 大字/町 district-machi       | `district`        | 丸の内         |
| 丁目 chōme (block)           | `block`           | 1丁目          |
| 番地 banchi (sub-block)      | `sub_block`       | 1番地          |
| 号 gō (building number)      | `building_number` | 1号            |
| building name (often romaji) | `building_name`   | Tokyo Building |

Postcode (〒100-0005) maps to the existing universal `postcode`. Country to `country`. So JP reuses the universal head for the coarse fields and adds the seven street/block tags. **Do not reuse `street`/`house_number` for JP** — chōme-banchi is not a street+number grammar, and forcing it corrupts both label statistics (the same argument `SCHEMA.mdx` makes for keeping `cedex` out of `postcode`).

### Universal extension, not a JP fork

Activate the tags in the shared union; let `componentsSupported` per-locale gate emission. The classifier head expands from 33 → 47 labels (7 new tags × B/I). Rationale: KR and CN will need overlapping structure (KR has 시/도 province, 시/군/구 city, 동 dong, 번지 — several map onto `municipality`/`district`/`sub_block`), so a JP-private label set would just be re-forked at KR. One universal union, per-locale masks, is the established pattern (the FR `cedex` precedent).

**Head-expansion note (from #727 phase-1):** a freshly-added head/label group needs its **own param-group LR** — the existing warm layers and the cold new label rows must not share a learning rate. Bake this into the JP training config.

### Order: native, not normalized

Large-to-small is a _grammar the model learns from labels_, not a preprocessing step. This is the project's model-first doctrine verbatim ("if a human can reason it from context, the model should learn it"). Normalizing JP to Western order would (a) require a parser to do the reordering — the exact rule-engine the architecture rejects — and (b) train a surface real queries don't use, the same reason romanization (approach C-old) was rejected on 2026-07-18. The corpus synthesizes rows in native order; the model reads position from context, as it already does for FR's inverted `house_number`/`street` order.

---

## 3. Preserving the Latin 23

**Mechanism: separate model per script family, script-routed at runtime. The Latin SP model is not touched.**

This is the strongest possible forgetting guard — the Latin regression is not _measured small_, it is _provably zero_, because the artifact is byte-identical (the #825 "diff 0 CI[0,0]" proof, but for the whole model instead of the encoder). No dual-path-single-model complexity, no frozen-encoder-plus-adapter fine-tuning risk. Two ONNX artifacts, one router.

- **Router:** Unicode-block histogram on the raw string → script family → model. Lives in `query-shape` (already computes character-class priors). A mixed-script string (romaji building name inside a kanji address) routes by dominant CJK content; the char model handles the embedded romaji fine (its char vocab includes Latin).
- **Cost:** +1 model artifact. The char CJK model is _small_ (few-thousand-char embedding table vs 73k SP), so the marginal MB is modest and Tier-A/Tier-B payload logic is unchanged — the router picks the model, the gazetteer split is orthogonal.
- **Channels:** the anchor/gazetteer/country/conventions channels project per-SP-piece today. For the char model they re-align **per-word** (one projection per whitespace-or-CJK-char token). The scaffolding defers this until after the probe — correct sequencing; the bare probe isolates the encoder, channels come once CJK viability is proven.

Unification into one char model is explicitly **out of v8 scope**, gated on probe Leg 2. Ship dual-path; revisit at v9+ if char matches SP on Latin.

---

## 4. Phased v8 plan

Gate discipline: each phase has a falsifiable read; a FAIL diagnoses before the next phase, it does not proceed on hope.

| Phase                          | Work                                                                                                                                                                                               | Gate                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Alignment de-risk** (§5) | 500 JP rows: verify Overture field → character-span BIO alignment is correct against a segmenter. _No training._                                                                                   | ≥95% of 50 hand-checked rows align correctly. FAIL → adopt MeCab/Sudachi or block-regex segmentation before spending compute. **This gates everything.** |
| **1 — Probe**                  | Activate CharCNN; wire `char_ids` into `data_loader.py`; ~200k JP shard; bare char train; held-out JP coord board. Run Leg 2 (Latin bake-off) same session.                                        | Leg 1: JP coord-acceptability ≥ bare-Latin floor (~0.70). Leg 2: record char-vs-SP-Latin delta (informs v9, not v8).                                     |
| **2 — Schema activation**      | Expand active labels 33→47; JP `componentsSupported`; new head param-group.                                                                                                                        | Compile-clean; downstream alignment/inference updated in the same commit (`SCHEMA.mdx` rule).                                                            |
| **3 — JP corpus**              | Full JP shard from Overture-JP (19.6M) — `locale`-style recipe, CJK-aware synth in native order, character BIO. Postcode-anchor channel wired (JP is a WOF-priority country, gazetteer covers it). | Shard stats sane; coverage across prefecture buckets; no all-`O` rows (`JSON hides gaps` scar).                                                          |
| **4 — JP train + channels**    | Train char CJK model with channels re-aligned per-word; int8 ONNX export.                                                                                                                          | JP coord board clears the v8 bar (TBD — set from probe, e.g. wrong-prefecture < X%). Latin: N/A, untouched (provable).                                   |
| **5 — Ship JP-only**           | Router in `query-shape`; second model artifact; drop-in + browser (onnxruntime-web) verified; demo repoint.                                                                                        | Published-tarball md5 verify; **JP is the first non-Latin parse claim.**                                                                                 |
| **6 — KR**                     | Pull Overture-KR; KR schema map; KR shard; train (likely _same_ char model, KR labels added).                                                                                                      | KR coord board. **See reframe below — KR may be cheaper than JP.**                                                                                       |
| **7 — CN/TW**                  | Overture-TW 9.7M on disk; CN pullable. Hanzi, no whitespace (JP-alignment problem again).                                                                                                          | CN/TW coord board.                                                                                                                                       |

**What ships first: JP-only (Phase 5).** It is the operator's stated headline, the data is on disk (19.6M), and it validates the whole char+router+schema stack end-to-end before KR/CN pile on.

**Reframe worth surfacing: KR before JP may be the cheaper first ship.** Korean addresses are **whitespace-separated** between components — which is exactly the segmentation the existing whitespace-word pipeline assumes. JP is space-free and needs the Phase-0 alignment machinery. If the operator wants the _fastest_ non-Latin ship rather than specifically-JP-first, KR clears Phase 0 nearly for free. JP-first is the right call for headline value; KR-first is the right call for de-risking the char path with the least alignment work. Flagging the trade; JP-first as written unless the operator reprioritises.

---

## 5. The single biggest risk you haven't named

**It is not the encoder, the schema, or the tokenizer. It is corpus BIO alignment over unsegmented CJK — and it sits upstream of every training dollar.**

The Latin pipeline aligns because Overture fields map to **whitespace tokens** (`STREET=Salmon St` → tokens `[Salmon, St]`, BIO-aligned by the whitespace tokenizer). JP breaks both assumptions:

1. **No whitespace.** `東京都千代田区丸の内1丁目` is one unbroken string. The CharCNN scaffolding's "one char per token for CJK" degenerates each kanji to a single-char word — which _loses_ the morpheme grouping (丁目 as a unit, 番地 as a unit) that the block grammar needs. The word-composition-from-chars advantage evaporates if every token is one char.
2. **Field values don't carry positions.** Overture gives `district=丸の内`, `block=1丁目` as _values_, not offsets. Aligning them back to the concatenated string is a **substring-match problem that is ambiguous** when a kanji recurs (a district char that also appears in the city name binds to the wrong span). The Latin pipeline never faces this because whitespace disambiguates.

If alignment is silently wrong, you train on mislabeled spans and the coord board tells you _something_ is broken but not _what_ — the most expensive failure mode (compute already spent). This is the #825 lesson generalised: **grade the thing the model actually consumes, before you train.**

**Cheap de-risk (Phase 0, no compute):** take 500 Overture-JP rows, run field→character-span alignment, and **hand-check 50 by eye** — a human reads kanji spans in seconds. If field-concatenation alignment is clean, the risk is retired for pennies. If it is ambiguous, you have surfaced — _before training_ — that you need a JP morphological segmenter (MeCab/Sudachi) or the deterministic block-structure regex (postcode/丁目/番地/号 are regular delimiters) to produce gold character spans. Either way it is a Phase-0 data dependency, not a Phase-4 surprise. The whole point of the pocket-sized model is that the small model surfaces corpus bugs instead of absorbing them — Phase 0 is that principle applied before the first retrain.

Secondary de-risk it also retires: it tells you whether the CharCNN "one-char-per-CJK-token" scaffolding is adequate or whether CJK tokens must be **morpheme-grouped** before char-composition (i.e. segment first, then compose each morpheme from its chars). That is a small change to `char_tokenizer.encode_row_charword`, but you want to know in week 1, not after the probe.
