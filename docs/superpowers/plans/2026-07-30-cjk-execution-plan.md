# v8.3.0 Phase-0 memo 3 — the CJK execution plan (Arc 2, committed)

**Resolves:** ROAD_TO_MAILWOMAN_V8_3_0 §4 D5 — and upgrades Arc 2 from "cut-time scope call" to
**committed work with its own schedule** (operator, 2026-07-30: "you've punted on the CJK stuff a
few times… I think it's time").

This memo **promotes** the standing design work into the committed plan set. The full technical
substance lives in two documents this memo does not duplicate:

- `scratchpad/v8-cjk-architecture-plan.md` — the A/C architecture decision (char-level CharCNN
  internally, script-routing at the boundary; B rejected on the #825 receipt), schema activation
  (the JP seven exist in `COMPONENT_TAGS`, 33→47 head), the phased build, and the alignment risk
  analysis. _(To be moved under `docs/superpowers/plans/` with this memo — scratchpad is
  gitignored and this is now committed work.)_
- `scratchpad/fable-v8-jp-char-encoder-design.md` — the input-contract design (D1–D6 register:
  `char_ids (B,S,W)` with S=label units / W=composition window; sealed char vocab; one-char CJK
  units at ctx=3/W=7; compact `2-3-16` as whole-span house_number) and the full Leg-1 probe spec.

## Where this actually stands (the punt audit)

| Milestone                                                                  | Status                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Architecture decision (char + router; no SP retrain; no unification in v8) | **DECIDED** 2026-07-18                                            |
| Schema (JP seven declared, per-locale gating designed)                     | **DONE on paper** — activation is Phase 2                         |
| CharCNN encoder + char tokenizer                                           | **COMMITTED CODE**, ONNX-clean, gated off since #825              |
| **Phase 0 — the BIO-alignment de-risk** (the named biggest risk)           | **RETIRED 2026-07-18: 1,560/1,560 aligned** (`align.ts` verified) |
| Data: JP Overture 19.6M on disk; KR juso 6.17M acquired; TW 9.7M on disk   | **ACQUIRED**                                                      |
| Leg-1/Leg-2 probes (specced, gated, ~2 A100-hours total)                   | **NEVER RUN** ← the punt                                          |

The honest summary: everything cheap and hard was done in July; the two one-hour training probes
that convert the design into a verdict were never launched. That is what changes now.

## The committed schedule

**Step 1 — the probes (this week; independent of Arc 1, ~2 A100-hours + 1 agent-night):**

- **Leg 1 (JP viability, gates Arc 2):** bare CharCNN model, ~200k JP rows on the universal
  STAGE3 subset (D5: no JP-seven yet, compact numbers as whole-span house_number), held-out by
  municipality bucket, scored on JP coordinate-acceptability. **Pre-registered gate: ≥ 0.70**
  (the bare-Latin substrate floor). The FAIL ladder is written (per-tag split → boundary audit →
  collapse check) and _cannot_ indict alignment — Phase 0 retired that.
- **Leg 2 (unification bake-off, gates v9's shape, not v8):** the same bare char model on the
  Latin corpus vs bare SP on the Latin coord boards. Run in the same session; record the delta.
- Plumbing owed before launch (the one real code item): the `data_loader.py` char path
  (`char_mode` config, `encode_row_units`, char-vocab build) per the contract note's D1/D6.

**Step 2 — on a Leg-1 PASS: Phases 2–5 as written** (schema activation 33→47 with the
own-param-group-LR rule; the full JP shard; train with channels re-aligned per-unit; ship JP-only
with the query-shape script router, the second weights artifact, browser + drop-in verification).
Phase 2–5 sizing: ~4–6 agent-nights across corpus + train + ship, riding the same release
choreography as 8.2.0.

**Step 3 — KR (Phase 6):** likely the same char model with KR labels added. The standing reframe
stays flagged: KR is whitespace-separated and would have been the cheaper _first_ ship; JP-first
stands as the operator's headline preference unless reprioritized at the Leg-1 verdict.

## Coordination with Arc 1 (the Latin retrain)

- **No shared blocking dependency.** Different model, different tokenizer path, different corpus.
  The probes can run _before_ Arc 1's D-decisions are even signed.
- Shared surfaces, both additive: the release train (HF/R2/preflight gain the second artifact +
  char vocab — the lexicon-addition pattern), the acceptance battery (JP boards become battery
  configs), and the router in query-shape (pure addition; Latin routing byte-identical by
  construction).
- **D5 resolution:** the _work_ is committed now; whether the JP model ships inside the 8.3.0 cut
  or as an 8.4 fast-follow is decided at the Leg-1 verdict by ordinary gate arithmetic — with the
  work already in flight, that question stops mattering much.

## Enterprise tie-in

East-Asian address stock is a validation/record-matching segment no in-process competitor serves;
the char model is _small_ (the 28M SP embedding table collapses to ~0.3M), so the pocket/browser
story survives. A JP-capable base extends the B11 surface to JP-market customers with the same
fine-tune template — one more reason Arc 2 is foundation work, not a side quest.
