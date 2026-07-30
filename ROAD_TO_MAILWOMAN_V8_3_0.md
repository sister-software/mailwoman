# Road to Mailwoman v8.3.0 — the from-scratch retrain as the enterprise foundation

**Status:** 🟢 **EXECUTING** (updated 2026-07-30: run 1 graded, run-2 contingency in flight — see
§10, the execution register) · **Opened:** 2026-07-30 · **From:** 8.2.0 / bundle 6.7.0 / model
v3.24.0-bundle-ordinal (the first shipped evidence-bundle model) · **Authors:** Claude,
operator-directed.

**Directive (operator, 2026-07-30):** plan the from-scratch retrain **as the enterprise
foundation** — the base model the B11 fine-tune product starts every customer engagement from.
Full fit argument: `docs/superpowers/plans/2026-07-30-from-scratch-retrain-enterprise-fit.md`.
One sentence: the retrain is B11's first deliverable — the golden master, the training run where
forgetting-protection is captured at the only point it is cheap, and the base whose QA harness
becomes the per-customer acceptance battery.

Standing doctrine carried forward: coarse phases, no micro-gates unless genuinely confounded;
lowercase is the primary user register (every eval gets a lowercase leg); model-first — no new
decode-time flags ride this arc; the D-rule (iron rule 6) gates every cut.

---

## 1. What 8.2.0 leaves on the table (the debts this arc retires)

| Debt                                                    | Today                                                                | After the retrain                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| fr.cedex fine-tune forgetting + re-anchored floor       | named watch; floor waived at 82.2 (shipped-same-harness 85.6)        | re-learned natively; floor re-cut from the new base's own reading         |
| Fine-tune-of-fine-tune stacking (v3.24←v385←v381←v310…) | four generations deep; provenance smeared across recipes             | flattened — every capability from one recipe, one provenance              |
| Evidence bundle as a graft                              | channels + anti-over-trust curricula bolted on at 6k-step fine-tunes | channels + curricula in the base objective from step 0                    |
| Num-ordinal / directional invariants                    | trained in via late augmentation (v3.24) + gauntlet fixtures         | in the base recipe from step 0                                            |
| Calibration / capability-manifest drift                 | carried-forward blocks, environment re-anchors                       | regenerated from one run                                                  |
| DE country fold (the deliberately-deferred increment)   | locality lexicon is US+FR                                            | folded into the base lexicon build (one increment, gated like the others) |

## 2. The shape — two coordinated arcs, one release train

**Arc 1 — the Latin base retrain (this document's core).** From scratch on the assembled
production feed, the current SentencePiece tokenizer (v0.9.0-multisplice) unless §4 decides
otherwise, all shipped capabilities native. Produces the **model 7.0.0** weights bundle.

**Arc 2 — the CJK sibling model (epic #1176, the standing plan).** Per
`scratchpad/v8-cjk-architecture-plan.md` + `fable-v8-jp-char-encoder-design.md`: a char-level
(CharCNN — already committed and gated-off) **separate model**, script-routed at the runtime
layer. The Latin model is untouched by construction, which makes the Latin non-regression
**provable** (byte-identical routing), not measured. JP (then KR) data is acquired. The
single-model unification is explicitly deferred (v9-class).

Consequence worth stating plainly: **the Latin retrain does NOT carry the char-encoder decision.**
The two arcs share the release train and the acceptance battery, not an architecture gamble.

**Arc 2 is COMMITTED work with its own schedule** (operator, 2026-07-30 — the punt ends):
Phase 0 (the BIO-alignment de-risk, the plan's named biggest risk) was already retired 2026-07-18
at 1,560/1,560; the pre-registered Leg-1/Leg-2 probes (~2 A100-hours) run next, independent of
Arc 1's decision register. Execution plan:
`docs/superpowers/plans/2026-07-30-cjk-execution-plan.md`. Whether the JP model ships inside the
8.3.0 cut or as an 8.4 fast-follow falls out of the Leg-1 verdict by ordinary gate arithmetic.

## 3. The enterprise deliverables (what makes this "foundation" and not just hygiene)

1. **The golden master.** Model 7.0.0 with zero named watches at ship — the starting line every
   customer fine-tune inherits.
2. **Fisher capture** (the consolidation artifact). One extra pass during the base run stores the
   Fisher diagonal beside the checkpoint, making EWC-style protection available to every
   subsequent fine-tune — ours and customers'. Design note first (§6); the training-code delta is
   small, the contract addition ("the weights bundle ships its Fisher") is the real decision.
3. **The packaged acceptance battery.** The v8.2.0 arc's instruments — pre-registered gates,
   ablated-vs-fed columns, canary fixtures with receipts, replay dosing, the pre-ship gauntlet —
   formalized as a reusable battery (`mailwoman eval battery <config>`-shaped). The retrain is its
   first consumer; the first B11 engagement is its second.
4. **The fine-tune recipe template.** init_from 7.0.0 + Fisher penalty + replay defaults + the
   battery as exit criterion — the thing a customer engagement instantiates instead of researches.

## 4. Decision register (operator calls; nothing below launches until these are named)

| #   | Decision                       | Options / default leaning                                                                                                                                                                       |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Step budget + compute envelope | The v385 lineage totals ~40k+ steps across generations; a from-scratch base wants a real budget (agent-nights + GPU spend sized in the recipe memo, not guessed here)                           |
| D2  | Feed assembly                  | v385's feed + the bundle lexicons as baseline; each deploc passenger (gb/nz/es-pedania/fr-lieudit) + punct_drop 0.6 re-enters ONLY with its own promotion case; DE fold rides the lexicon build |
| D3  | Tokenizer                      | Keep v0.9.0-multisplice (default — comparability + the splice history) vs retrain SP (only with a named reason)                                                                                 |
| D4  | Fisher scope                   | Diagonal-only (default, cheap) vs blockwise; which distributions (the full feed vs per-locale slices)                                                                                           |
| D5  | Arc 2 in 8.3.0?                | RESOLVED 2026-07-30: the WORK is committed (probes first, phases 2–5 on a Leg-1 PASS); in-8.3.0 vs 8.4 fast-follow falls out of the Leg-1 verdict — see the CJK execution plan                  |
| D6  | Model/npm numbering            | Model 7.0.0 + npm 8.3.0 (default) — a from-scratch base is a model-major even when the API is additive                                                                                          |

## 5. The base recipe — known ingredients (assembly memo precedes launch)

Everything already proven, no research items: the v385 feed (v0.13.0-latam) + evidence channels
(street_type/locality_surface) painted from the digit-guarded four-law lexicons (street v3 /
locality-surface v6 + the DE fold → v7) + absence & false-evidence curricula + ordinal/directional/
region/glue/case/punct-drop augmentation (punct_drop level per D2) + the anchor/gazetteer/country
channels as shipped. The recipe memo assembles these with citations to each ingredient's receipt
and pre-registers the full gate sheet before any GPU spend.

## 6. Fisher / consolidation work item

Design note → capture implementation (training-side, ~days) → bundle-contract addition (the
Fisher artifact beside model.onnx, versioned like the lexicons) → the fine-tune recipe consumes it
(EWC penalty, λ calibrated once on our own next fine-tune) → the **guarantee gate**: a
Fisher-protected fine-tune must hold every base capability within noise on the battery. That gate
is the sellable sentence in B11.

## 7. Gates for the cut (pre-registered in the recipe memo, sketched here)

- The full G1–G7 ladder as evolved through v3.19→v3.24 (fragment bars incl. lowercase legs,
  ablation vs the 6.7.0 reference, invariance vs 6.7.0, gauntlet, golden ablated ALL floors with
  freshly-cut noise-honest margins, canary zero-flip, the pre-ship gauntlet on the flip).
- **Match-or-beat 6.7.0 everywhere** (the D-rule with no waivers — the entire point of the
  from-scratch is zero named watches at ship), including fr.cedex against the _original_ 85.6-class
  reading, not the waived floor.
- Per-locale full family (the Latin 23) + the demo smoke + the browser runner path.
- If Arc 2 ships: the script-router's provable Latin byte-identity + the JP gates from the CJK
  plan's own pre-registration.

## 8. Sequencing (coarse phases)

1. **Phase 0 — memos (no GPU):** the recipe-assembly memo (D1–D4 resolved, gates pre-registered);
   the Fisher design note; the CJK BIO-alignment de-risk spike (D5's input). Each ends in an
   operator sign-off, then hands are free.
2. **Phase 1 — Fisher capture implementation + battery packaging** (code, testable without the big
   run; the battery packaging is B11 work product regardless).
3. **Phase 2 — the run + the ladder** (the big spend; one run, the stop rules travel with it).
4. **Phase 3 — ship** (the 8.2.0 cut choreography, now twice-rehearsed: card/HF/R2/prepare/publish/
   demo) **+ B11 alpha** (the fine-tune recipe template exercised once on a synthetic "customer"
   shard as the dress rehearsal).

## 9. Open questions (beyond the register)

- Does the battery packaging live in-repo (`mailwoman eval battery`) or start as the runbook it
  already is? (Leaning: runbook first, CLI when the second consumer exists.)
- Per-customer canary methodology for B11 — who writes the customer's golden rows, and what is the
  minimum n for the noise-honest margins we now compute routinely?
- Where the Fisher artifact meets Trusted Publishing / HF staging (one more preflight file, same
  pattern — mechanical, but named so it isn't forgotten at the cut).

---

## 10. Execution register (updated 2026-07-30 POST-SHIP — v8.3.0 / model 7.0.0 LIVE)

### Done, with receipts

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Receipt                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase-0 memos (D1–D4) + Arc-2 commitment                                                                                                                                                                                                                                                                                                                                                                                                                  | #1348 merged; operator sign-off = the merge                                                                                                                               |
| **#1349**: shipped locality channel NEVER trained (frozen at xavier init; a consistent random marker shipped)                                                                                                                                                                                                                                                                                                                                             | fingerprint + per-channel ablation on the issue; trainer fix + structural key-parity test #1350; recipe reframe #1352                                                     |
| CJK char path (encode_row_units, char_mode, loader/trainer wiring)                                                                                                                                                                                                                                                                                                                                                                                        | #1351                                                                                                                                                                     |
| JP Leg-1 probe: **PASS 0.9925** vs the 0.70 gate (region 1.000/locality 0.994 on unseen municipalities)                                                                                                                                                                                                                                                                                                                                                   | verdict on #1176; scorer pre-registered at 34c7b6c2                                                                                                                       |
| Leg-2 bake-off: char-word within ~0.5pp of bare SP at 22% params                                                                                                                                                                                                                                                                                                                                                                                          | record on #1176; v9 door open (channels-attached condition now named)                                                                                                     |
| Fisher capture + EWC + acceptance-battery doc (Arc-1 Phase 1)                                                                                                                                                                                                                                                                                                                                                                                             | #1354; artifact contract = fisher-diag-v1.npz + sidecar                                                                                                                   |
| Locality lexicon **v7** (DE fold; law-4 city-state exception; Brandenburg = Washington class)                                                                                                                                                                                                                                                                                                                                                             | #1355; artifact staged to R2 (392,653 entries)                                                                                                                            |
| DE fragment board (G8's instrument)                                                                                                                                                                                                                                                                                                                                                                                                                       | overture-fragments-de.jsonl, #1356                                                                                                                                        |
| **Base run 1 (v4.0.0-base-60k)**: complete after a 4h-timeout resume (cap now 6h); Fisher captured (2,000 batches, all 39.26M trainables, sanity PASS); G1 grid FLAT 40k→60k (over-trust decay = fine-tune artifact, confirmed); candidate step-060000 int8 md5 b7ee5181; locality channel 384/384 nonzero                                                                                                                                                | config header = the pre-registration; grades in the session ladder                                                                                                        |
| Run-1 verdicts: **G5 16/17** (fr.cedex **90.5** — the named watch RETIRED above the unwaived 85.6; us.street 87.8; P0 board beats shipped on EVERY class) · street_prefix 93.6 vs 96 = the 2.0pp-fallback-margin trap (support n=25; floor-recut-per-the-spec's-own-rule disposition RECORDED, not waived) · homonym delta-bars read per the #1349 addendum (OFF≈0.95 — capability in the weights) · gauntlet: **3 real fails, one family: FR venue-led** | mechanism proven register-invariant; root cause = the feed NEVER admitted a venue shard (source_weights drops unlisted; shipped venue competence was lineage inheritance) |
| CJK Phase 2: per-config label sets (stage3-jp 47), checkpoint-owned id_to_label, ja-JP +house_number (D4), SCHEMA activation records                                                                                                                                                                                                                                                                                                                      | #1357                                                                                                                                                                     |
| Training-dynamics runbook section; glossary +34 v8-era terms                                                                                                                                                                                                                                                                                                                                                                                              | #1358, #1359                                                                                                                                                              |
| 4-survey synthesis (Latin: keep SP; CJK: char+window confirmed; **channels LOAD-BEARING for char NER — named precondition**; JP ship = category first) + KR addendum                                                                                                                                                                                                                                                                                      | #1360, #1362; cjk.ts folding gaps filed #1361                                                                                                                             |
| **KR framework DECIDED** (operator): parse = localdata(KOGL)+WOF-KR(already in our DB: 50,465 localities, Hangul+hanja)+synthetic+OSM-quarantined; **juso = plug-and-play build-local layer** (we ship the builder against the documented format + synthetic fixtures, never touching real juso pre-counsel; customer builds in-country; manifest carries obligations). GTM moat: the export pledge blocks every cloud geocoder                           | #1362 addendum                                                                                                                                                            |

### Arc 1 — SHIPPED 2026-07-30 (v8.3.0 / model 7.0.0)

The full chain executed under the operator's "Let's do it": run-2 venue contingency (v4.0.1, ONE
delta = synth-house-venue 2.0) → all 3 venue must-clears CLEARED + 3 tracked promotions, zero
P0/golden cost → ladder full pass (G1 grid FLAT both registers; G5 16/17 with the street_prefix
fallback-margin artifact; G2/G3/G6 clean; G7 pre-ship 47/47 + metamorphic; G8 DE-fold revert
executed per pre-registration — v6 ships, v6 ⊆ v7 verified) → new gate spec **v7.0.0-base**
(Wilson support-aware margins; final verdict PASS zero fails) → promote choreography complete:

- **npm 8.3.0 LIVE** (publish.yml prepare → release PR auto-merged → publish; clients PASS;
  tag + GitHub release v8.3.0). Card lockstep c968c24a; ledger row keyed by MODEL version 7.0.0
  (the guard caught the npm-keyed first attempt — same class it exists for).
- **HF v7.0.0 staged + defaultVersion** incl. the **Fisher artifact** (fisher-diag-v1 npz+sidecar;
  `release hf --fisher` added; publish.yml preflight HEAD-checks the card-declared file).
- **R2 demo REPOINTED**: carry-forward per RELEASING.md §"repoint" + model/card overwritten,
  releases.json flipped AFTER npm success; served model md5-verified c968c24a; Playwright smoke
  GREEN (v7.0.0 in-browser, Rockefeller preset parses, classify 62 ms, zero console errors).
- Docs: releases.mdx row + status.mdx infobox + the dated eval report
  (docs/articles/evals/2026-07-30-v700-base-promote.md); tags.yml registered the #1359 glossary
  tags + the research-post tags (docs build was red on main since the glossary merge — now green).
- TRANSITION-BETA test re-pinned (Glenfield → Upton): 15/17 probe rows self-recover beta-less on
  the base, incl. Hedon + Ashby Parva (never recovered at any β on the fine-tune lineage).
- ONE named watch rides: **si-sentinel-ucakar** (SI diacritic digit-split; designed fix = the
  char-path lineage). Six GB venue-led improvement targets = **#1366** (pre-existing on 6.7.0;
  the first B11 fine-tune exercise). λ calibration rides that same first post-base fine-tune.

**Post-promote levers still open** (tasks #25/#26): SP vocabulary pruning probe (byte-parity
pre-registration; embedding = 72.5% of params at ≤24% utilization) and the SP 0.2.2 WASM rebuild
(native offsets).

### Arc 2 — remaining (CJK Phases 3–5, JP)

5. **Phase 3 — full JP shard** off Overture-JP 19.6M: JP-native labels (prefecture/municipality/
   district + long-form designator splits; compact numbers stay whole-span house_number per D4);
   char vocab REBUILT from the full shard (probe 1,918 vs 2,640 distinct kanji in full data — or
   the hash-bucket OOV fallback); the normalization steal-list (two-register numerals, variant
   folding, 条/地割/無番地 tail, kyoto_st); KEN_ALL 〒 join; postcode-anchor channel wiring.
6. **#1361 cjk.ts fixes** (half-width katakana fold with length-changing dakuten composition + the
   hyphen-equivalence class) — pre-Phase-5.
7. **Phase 4 — train + channels re-aligned per-unit** (the channels are LOAD-BEARING per the
   survey precondition; int8 export; JP coord bar set from the probe).
8. **Phase 5 — ship JP-only**: query-shape script router (Latin byte-identity provable), second
   weights artifact + sealed char vocab, **code-point-native TS decode** (49.5% of the official
   JP character set is non-BMP; the #519 scar generalizes), browser byte-parity, drop-in + demo
   verification. **The first non-Latin parse claim.**
9. Phase 6 (later): TW = full-stack second CJK locale (OGDL green, 9.7M on disk); KR parse on the
   decided framework + the juso build-local layer builder.

### Counsel dossier (best-effort now; forwarded when the project pays for counsel)

10. Assemble `docs/superpowers/plans/counsel-dossier.md`: the BDC spec's 8 questions (#1214) ·
    ODbL posture (osm/ publish-block + OSM-derived corpora quarantine) · HK ALS adaptation
    silence · KR: KOGL type on the specific localdata datasets + the juso plug-and-play notice
    language + whether in-country-trained weights constitute export · MJ縮退マップ CC BY-SA
    share-alike if a derived normalization table ever ships · A2 commercial-license text (the
    pricing page's two durable public commitments precede review).

### Standing GTM items riding the release

- Pricing page **#1353 awaits operator ratification** (merging = ratifying A1's numbers; 7
  questions on the PR).
- The 3 CodeQL `postcode` false-positives on the security tab (operator dismissal).
- ~~The untracked blog post's missing tags~~ FIXED 2026-07-30: tags.yml registered multilocale/overture/testing/methodology (and the 13 glossary tags).
