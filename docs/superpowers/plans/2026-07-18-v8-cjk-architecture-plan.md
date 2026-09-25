# v8 — Crossing the non-Latin (CJK) threshold: architecture plan

Epic #1176. Goal: parse JP (then KR, then CN/TW) into resolvable components without regressing the Latin 23.

_This is a planning artifact. It is based on `what-mailwoman-is.mdx`, `SCHEMA.mdx`, `model.py` (CharCNNEncoder), `char_tokenizer.py`, `neural-weights-en-us/model-card.json`, the #825 bsplice postmortem, and the extract-recipe pipeline. No code was changed._

---

## TL;DR (the decisions)

1. **Use approach A (a char-level encoder), deployed with script routing (approach C at the runtime layer). Reject B outright.** A and C do not compete. A is the _encoder_, and C is the _shipping mechanism_. The Latin SentencePiece (SP) model stays untouched. A new char-level CJK model ships beside it, and a script router dispatches between them. The protection against forgetting is then **provable rather than measured**: the Latin bytes are identical, so the diff is 0 with CI[0,0], the same proof that justified the #825 mean-init.
2. **The char path is already half-built.** `CharCNNEncoder` (`model.py`) and `char_tokenizer.py` are committed, export to ONNX, and are off unless enabled. They are the deliberate "CJK-forward path" from #825. v8 activates and trains that path rather than rebuilding an encoder from scratch, which removes most of the cost that made A look expensive.
3. **The schema already exists on paper.** The seven JP tags (`prefecture`/`municipality`/`district`/`block`/`sub_block`/`building_number`/`building_name`) are declared in `COMPONENT_TAGS`, and `LocaleProfile.componentsSupported` keeps them from being emitted. v8 activates them as an extension of the universal schema rather than a JP-private fork.
4. **The longest task is corpus BIO alignment over _unsegmented_ kanji. The encoder and the schema take less work.** Overture provides field _values_ (`street=字崎枝`) rather than character-level spans, and JP addresses have no whitespace. Aligning fields back to a space-free string is the hidden risk (§5). Reduce that risk in week 1, before any training.
5. **Model the large-to-small order natively (model-first). Do not normalize it.** A human reads order from context, and the model must too. The model learns the block grammar from labels, and no preprocessor rewrites it.

---

## 1. The decision: A vs B vs C, and the probe that determines the result

### Why B is rejected before the probe (it fights known scar tissue)

The #825 postmortem makes the case. A Slavic-diacritic **retrain on the same subword tokenizer failed**. The root cause was tokenizer fragmentation, and _data cannot fix a fragmentation that a unigram vocab cannot emit_. CJK is the extreme case of that failure: `v0.9.0-multisplice` has no coherent CJK subword pieces at all, only byte pieces. B's three named risks (Latin dilution, vocab growth, invalidated F1 comparisons) are all real, but the deciding problem is subtler. **B forces a choice between diluting the hardened Latin model and forking it anyway.** A fork means paying for a multilingual retrain _and_ still shipping two models. A is better than B on every axis.

A structural fact also reverses the intuition that A is the big rebuild: **the embedding table already dominates the model.** 73,143 pieces × 384 is about 28M of the ~29M total params, and the transformer body is only about 8.87M. A char-level front end shrinks that table to a vocab of a few thousand chars. **The char model is therefore _smaller_ than the SP model**, and it fits the pocket budget more easily. Calling A the biggest rebuild was accurate when char-level meant writing a new encoder. It stopped being accurate once `CharCNNEncoder` existed.

### The recommendation: A internally, C at the boundary

- **A (char-level CharCNN)** is the CJK model's front end. It composes words from characters, so there is no subword vocab to fragment CJK. It is already scaffolded and exports to ONNX (Embedding + Conv1d + ReLU + masked max-pool + Linear, which all runtimes accept).
- **C (script routing)** is the _deployment_. Detect the script with a Unicode-block histogram on the raw string, which is simple. The `query-shape` stage already computes character-class priors and is the natural place for it. Route CJK to the char model and Latin to the untouched SP model, and ship them side by side.

This design gives the operator's required property, "a new capability rather than a trade", **by construction**. The Latin model is not retrained, spliced, or otherwise changed, so its regression is provably zero.

The open question, which the probe must answer, is whether the two models should eventually **unify** into one char model that serves all scripts. Unification is elegant, with one shared transformer body, and it is the end state the bitter lesson points toward. It also brings back the dilution risk. **Decision: do not unify in v8.** Ship both paths. Treat unification as a later consolidation that depends on a Latin bake-off (§3).

### The cheapest pre-registered probe

The probe has two legs. Each is about a 1-hour A100 retrain at this model size, and fast iteration is the reason for the pocket budget. Pre-register both reads before running.

**Leg 1 — CJK viability (the go/no-go for A on CJK):**

- Build about 200k JP rows from Overture-JP on the JP schema subset (§2), aligned to character-level BIO. §5 must be solved first, because the probe's result is only as good as that alignment.
- Wire the data loader to feed `char_ids`. `char_tokenizer.encode_row_charword` exists, but `data_loader.py` has no char path, so this is the one piece of real plumbing the probe needs.
- Train the **bare** char model without the anchor, gazetteer, or phrase channels. The scaffolding docstring already scopes the probe this way. The channels are re-aligned per word only after the probe passes.
- Evaluate on a **held-out JP coordinate-acceptability board**, held out by locality bucket, using the same discipline as the Latin coord boards.
- **Falsifiable read:** Bare-char-JP reaches a coordinate acceptability at or above the bare-Latin-model floor (~0.70 oracle@5, the substrate baseline). If it passes, A is viable for CJK, and the phased build proceeds. If it fails, the bottleneck is upstream of the encoder (alignment or schema), so diagnose it before spending on channels.

**Leg 2 — the unification bake-off (decides dual-path-forever vs eventual-merge):**

- Train the _same_ bare char model on the _Latin_ corpus, and compare it with the bare SP Latin model on the existing Latin coord boards.
- **Falsifiable read:** Does the char-level model match SP on Latin, within noise on US comma-free and FR-fragment? If it does, unification becomes an option for a future major version. If it does not, the two paths are permanent. C handles that case _fine_, but the answer is cheap now and expensive after committing to a merge.

Leg 1 tests v8. Leg 2 tests the _shape of v9+_ and costs one extra retrain, so run it in the same session.

---

## 2. Schema / grammar

### The tags exist; activate them

`COMPONENT_TAGS` already declares the seven JP tags (`SCHEMA.mdx` §JP-specific), and `LocaleProfile.componentsSupported` holds them back. Phase 0 declared them in advance "so that schema additions in Phase 6 do not require a core rewrite". v8 is that Phase 6.

Mapping the chōme-banchi system to the tags:

| JP element                        | tag               | example        |
| --------------------------------- | ----------------- | -------------- |
| 都道府県 prefecture               | `prefecture`      | 東京都         |
| 市区町村 city/ward                | `municipality`    | 千代田区       |
| 大字/町 district-machi            | `district`        | 丸の内         |
| 丁目 chōme (block)                | `block`           | 1丁目          |
| 番地 banchi (sub-block)           | `sub_block`       | 1番地          |
| 号 gō (building number)           | `building_number` | 1号            |
| building name (frequently romaji) | `building_name`   | Tokyo Building |

Postcode (〒100-0005) maps to the existing universal `postcode`, and country maps to `country`. JP therefore reuses the universal head for the coarse fields and adds the seven street/block tags. **Do not reuse `street`/`house_number` for JP.** Chōme-banchi is not a street-plus-number grammar, and forcing it into those tags corrupts the label statistics of both. `SCHEMA.mdx` makes the same argument for keeping `cedex` out of `postcode`.

### Universal extension rather than a JP fork

Activate the tags in the shared union, and let the per-locale `componentsSupported` decide which tags each locale emits. The classifier head grows from 33 to 47 labels (7 new tags × B/I). KR and CN will need overlapping structure. KR has 시/도 province, 시/군/구 city, 동 dong, and 번지, and several of those map onto `municipality`, `district`, and `sub_block`. A JP-private label set would have to be forked again for KR. One universal union with per-locale masks is the established pattern, as in the FR `cedex` precedent.

**Head-expansion note (from #727 phase-1):** A newly added head or label group needs its **own param-group LR**. The existing warm layers and the cold new label rows must not share a learning rate. Put this in the JP training config.

### Order: native rather than normalized

The model learns large-to-small order _as a grammar from labels_, and no preprocessing step rewrites it. This follows the project's model-first doctrine: "if a human can reason it from context, the model should learn it". Normalizing JP to Western order has two problems. First, a parser would have to do the reordering, and that is the rule engine the architecture rejects. Second, the model would train on a surface form that real queries do not use. Romanization (approach C-old) was rejected on 2026-07-18 for the same reason. The corpus synthesizes rows in native order, and the model reads position from context, as it already does for FR's inverted `house_number`/`street` order.

---

## 3. Preserving the Latin 23

**Mechanism: a separate model per script family, routed by script at runtime. The Latin SP model stays untouched.**

This is the strongest available protection against forgetting. The Latin regression is _provably zero_ rather than merely _measured as small_, because the artifact is byte-identical. It is the #825 "diff 0 CI[0,0]" proof applied to the whole model instead of the encoder. The design avoids the complexity of a single model with two paths and the fine-tuning risk of a frozen encoder with an adapter. It consists of two ONNX artifacts and one router.

- **Router:** A Unicode-block histogram on the raw string selects the script family, which selects the model. The router lives in `query-shape`, which already computes character-class priors. A mixed-script string, such as a romaji building name inside a kanji address, routes by its dominant CJK content. The char model handles the embedded romaji, because its char vocab includes Latin.
- **Cost:** one more model artifact. The char CJK model is _small_ (an embedding table of a few thousand chars versus 73k SP pieces), so the added size is modest. The Tier-A/Tier-B payload logic is unchanged, because the router picks the model and the gazetteer split is independent of that choice.
- **Channels:** Today the anchor, gazetteer, country, and conventions channels project per SP piece. For the char model they are re-aligned **per word**, with one projection per whitespace token or CJK char. The scaffolding defers this until after the probe. That order is correct, because the bare probe isolates the encoder, and the channels come once CJK viability is proven.

Unification into one char model is explicitly **out of v8 scope** and depends on probe Leg 2. Ship both paths, and revisit at v9+ if the char model matches SP on Latin.

---

## 4. Phased v8 plan

Check discipline: Each phase has a falsifiable read. If a phase fails, diagnose the failure before starting the next phase rather than proceeding on hope.

| Phase                          | Work                                                                                                                                                                                                 | Check                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Alignment de-risk** (§5) | 500 JP rows: verify Overture field → character-span BIO alignment is correct against a segmenter. _No training._                                                                                     | ≥95% of 50 hand-checked rows align correctly. FAIL → adopt MeCab/Sudachi or block-regex segmentation before spending compute. **This checks everything.** |
| **1 — Probe**                  | Activate CharCNN; wire `char_ids` into `data_loader.py`; ~200k JP extract; bare char train; held-out JP coord board. Run Leg 2 (Latin bake-off) same session.                                        | Leg 1: JP coord-acceptability ≥ bare-Latin floor (~0.70). Leg 2: record char-vs-SP-Latin delta (informs v9 rather than v8).                               |
| **2 — Schema activation**      | Expand active labels 33→47; JP `componentsSupported`; new head param-group.                                                                                                                          | Compile-clean; downstream alignment/inference updated in the same commit (`SCHEMA.mdx` rule).                                                             |
| **3 — JP corpus**              | Full JP extract from Overture-JP (19.6M) — `locale`-style recipe, CJK-aware synth in native order, character BIO. Postcode-anchor channel wired (JP is a WOF-priority country, gazetteer covers it). | Extract stats sane; coverage across prefecture buckets; no all-`O` rows (`JSON hides gaps` scar).                                                         |
| **4 — JP train + channels**    | Train char CJK model with channels re-aligned per-word; int8 ONNX export.                                                                                                                            | JP coord board clears the v8 bar (TBD — set from probe, e.g. wrong-prefecture < X%). Latin: N/A, untouched (provable).                                    |
| **5 — Ship JP-only**           | Router in `query-shape`; second model artifact; drop-in + browser (onnxruntime-web) verified; demo repoint.                                                                                          | Published-tarball md5 verify; **JP is the first non-Latin parse claim.**                                                                                  |
| **6 — KR**                     | Pull Overture-KR; KR schema map; KR extract; train (likely _same_ char model, KR labels added).                                                                                                      | KR coord board. **See reframe below — KR may be cheaper than JP.**                                                                                        |
| **7 — CN/TW**                  | Overture-TW 9.7M on disk; CN pullable. Hanzi has no whitespace, so the JP alignment problem recurs.                                                                                                  | CN/TW coord board.                                                                                                                                        |

**What ships first: JP only (Phase 5).** JP is the operator's stated headline, its data is on disk (19.6M rows), and it validates the whole char, router, and schema stack end to end before KR and CN are added.

**KR before JP may be the cheaper first release.** Korean addresses separate components **with whitespace**, which is exactly the segmentation the existing whitespace-word pipeline assumes. JP has no spaces and needs the Phase-0 alignment work. If the operator wants the _fastest_ non-Latin release rather than JP specifically, KR clears Phase 0 at almost no cost. JP first gives the most headline value. KR first reduces the risk in the char path with the least alignment work. This plan keeps JP first unless the operator changes the priority.

---

## 5. The single biggest risk you haven't named

**The biggest risk is corpus BIO alignment over unsegmented CJK. It outweighs the encoder, the schema, and the tokenizer, and every training dollar depends on it.**

The Latin pipeline aligns correctly because Overture fields map to **whitespace tokens**. `STREET=Salmon St` becomes the tokens `[Salmon, St]`, and the whitespace tokenizer aligns the BIO labels. JP breaks both assumptions:

1. **JP has no whitespace.** `東京都千代田区丸の内1丁目` is one unbroken string. The CharCNN scaffolding treats each CJK char as one token, which reduces each kanji to a single-char word. That _loses_ the morpheme grouping (丁目 as a unit, 番地 as a unit) that the block grammar needs. Composing words from chars brings no benefit if every token is one char.
2. **Field values carry no positions.** Overture gives `district=丸の内` and `block=1丁目` as _values_ rather than offsets. Aligning them back to the concatenated string is a **substring-match problem that becomes ambiguous** when a kanji recurs. A district char that also appears in the city name can bind to the wrong span. The Latin pipeline avoids this because whitespace disambiguates.

If alignment is silently wrong, the model trains on mislabeled spans. The coord board then shows that _something_ is broken without showing _what_, and the compute is already spent. That is the most expensive failure mode. The #825 measurement led to this rule: **grade the input the model consumes before you train.**

**Cheap risk reduction (Phase 0, without compute):** Take 500 Overture-JP rows, run the field-to-character-span alignment, and **hand-check 50 by eye**. A human reads kanji spans in seconds. If field-concatenation alignment is clean, the risk is closed at almost no cost. If it is ambiguous, the check shows _before training_ that gold character spans need a JP morphological segmenter (MeCab/Sudachi) or the deterministic block-structure regex, since postcode, 丁目, 番地, and 号 are regular delimiters. Either way, the problem becomes a Phase-0 data dependency rather than a Phase-4 surprise. A pocket-sized model is useful because it exposes corpus bugs instead of absorbing them, and Phase 0 applies that principle before the first retrain.

The same check answers a second question. It shows whether the CharCNN scaffolding's one-char-per-CJK-token approach is adequate, or whether CJK tokens must be **grouped into morphemes** before char composition (segment first, then compose each morpheme from its chars). That is a small change to `char_tokenizer.encode_row_charword`, but the answer is needed in week 1 rather than after the probe.
