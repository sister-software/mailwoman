---
title: "Night shift 2026-06-19 — v1.8.0 international admin-split (surpass-v1.5.0)"
---

# Night shift 2026-06-19 — the international admin-split retrain

_Goal: produce a candidate that genuinely beats the production default **v1.5.0** on the **assembled
anchor-ON coordinate** (not label-F1), by fixing the one admin-deciding, coordinate-coupled failure
class — on non-US formats the model fuses the trailing admin token into the locality. NOT promoted
without operator GO (merge wall)._

> **STATUS: COMPLETE.** Training finished (40k steps, loss-abort passed), gated, verdict below —
> v1.8.0 is a clean coordinate net win (FR p50 42→2 km, US flat). Shift window: overnight →
> hand-off ~12:53 UTC (operator returned early). GPU lost to error: ~0. Regressions shipped: 0.
>
> **Morning wrap (2026-06-19 ~12:53 UTC):** operator GO — the 7 night commits rebased + pushed to
> main (`00ae8f56`, Test + Docs CI green), and **v1.8.1 launched** (`ap-K2x5hDTbABeEhdaW3i5WUS`,
> the country-bearing shard that closes fr.country; loss-abort passed). On v1.8.1's completion: gate
> (FR centroid + US/FR guardrails) → test → publish the chosen candidate. v1.8.0 stays the fallback.

## The arc (how we got here)

1. **Row-level read of the v1.7.0 HOLD** (day session) showed its only systematic street regression
   was trailing-directional clipping the #723 fold already recovers, and the US coordinate is
   data-bound (meter-grade via the situs cascade for ~90%). A US-parse retrain risks another label
   win that never reaches the coordinate.
2. **4-turn DeepSeek-Pro consult** (`surpass-v150`) reframed: only parse decisions that change the
   admin polygon matter. **International** is the headroom (no situs shards → the coordinate IS the
   admin centroid). The arena confirmed the class: postal-standards 68% both-fail, intl-format 29%
   v0-only; the unifying failure is "fails to split locality from the adjacent admin token."
3. **The anchor-positional unlock:** the v0.9.2 "intl washes anchor-on" scar was _positional_
   (German leading postcode); AU/FR have _trailing_ postcodes like the US → the anchor reinforces
   the split. Scar tissue is conditional, not universal (operator-named principle, now in memory).
4. **Pre-GPU self-validation PASSED** (`db8ac933`): splitting the département cuts collision-commune
   coordinate error −61%, the merge resolves 0%. The resolver demonstrably uses the région tag → the
   lever moves the anchor-ON coordinate. GPU justified before a minute was spent.

## What shipped (code, committed)

- `scripts/build-fr-admin-split-shard.mjs` — renders bare/space/comma FR place rows with the locality
  split from the département (`region`), from **real BAN** commune+postcode tuples; département
  derived via codex `departementForCodePostal`. Anchor-ON by construction (99.9% postcode-landing).
- `scripts/assemble-fr-admin-split-overlay-manifest.py` — overlay manifest (corpus-v0.5.0 690 shards
  verbatim + the shard), re-rooted to `/data` (0 `/mnt` paths).
- `scripts/eval/fr-admin-split-gate.ts` — the live centroid gate (ship-config parse → resolve →
  coord on the held-out golden; coord error + région-emit-rate + #727 diacritic break).
- `scripts/eval/fr-admin-split-selfvalidation.ts` + `docs/.../2026-06-19-fr-admin-split-prevalidation.md`
  — the pre-GPU gate (committed day session).
- `corpus-python/.../configs/v1.8.0-fr-admin-split.yaml` + `train_remote.py::sync_v080`.
- Issue **#727** filed (the `Lozère → ère` diacritic decode bug; rides the shard fix).

## The numbers (filled as they land)

**FR centroid gate** — held-out FR golden (3000 rows, disjoint communes, ship-config anchor-ON):

| metric                | v1.5.0 |     v1.8.0 | Δ                                 |
| --------------------- | -----: | ---------: | --------------------------------- |
| coord mean (km)       | 174.99 | **105.51** | **−40%**                          |
| coord p50 (km)        |  42.52 |   **2.17** | **−95%**                          |
| coord p90 (km)        | 389.37 |     334.15 | −14%                              |
| resolve-rate          |  59.5% |  **78.5%** | +19pp                             |
| région-emit-rate      |  39.6% |  **99.6%** | +60pp                             |
| région-correct-rate   |  36.4% |  **96.4%** | +60pp                             |
| #727 diacritic breaks |     23 |         24 | ~flat (rate among emitted halved) |

**The FR centroid gate passes decisively** — the median held-out FR address now resolves at 2 km
(was 42 km); the model learned the locality↔département split (région-emit 40→99.6%). This is the
goal: surpass v1.5.0 on the shipped FR coordinate.

**US guardrail** — `per-locale-f1` on `us.jsonl` (anchor-ON), 2pp gate:

| tag          | v1.5.0 | v1.8.0 | Δ          |
| ------------ | -----: | -----: | ---------- |
| house_number |   98.3 |   98.6 | +0.3       |
| **locality** |   77.9 |   75.7 | **−2.2** ⚠ |
| region       |   90.5 |   89.8 | −0.7       |
| street       |   80.2 |   80.8 | +0.6       |
| postcode     |   98.6 |   98.6 | flat       |
| country      |   68.4 |   68.9 | +0.5       |

The 2pp gate **fired on us.locality (−2.2pp)** — but the row-level read shows it's **precision-only**:
**0 new recall misses, 0 fixes** (every real US locality v1.5.0 caught, v1.8.0 still catches); the F1
drop is spurious-locality false-positives on _gold-locality-absent_ rows.

**US assembled coordinate — CONFIRMED FLAT** (oa-resolver-eval, OA-US, 2000 rows, anchor-ON, matched
pair):

| metric         | v1.5.0 |    v1.8.0 |
| -------------- | -----: | --------: |
| locality-match |  97.5% | **97.6%** |
| coord p50 (km) |    3.3 |       3.3 |
| coord p90 (km) |   10.8 |      10.7 |
| region-match   |  99.9% |     99.9% |

The −2.2pp us.locality _label_ regression does **not reach the coordinate** — locality-match is
actually +0.1, coord identical. The day's lesson reproduced: a label moves, the assembled coordinate
doesn't. Precision-only label blips on fragment rows are invisible in real full-address geocoding.

**Standard FR golden** — `per-locale-f1` on `fr.jsonl` (anchor-ON), matched pair (the FR-side
guardrail, complementing the custom centroid golden):

| tag          | v1.5.0 | v1.8.0 | Δ          |
| ------------ | -----: | -----: | ---------- |
| house_number |   99.3 |   99.5 | +0.2 ✓     |
| locality     |   86.3 |   87.6 | +1.3       |
| po_box       |   72.7 |   83.3 | +10.6      |
| region       |   41.8 |   43.7 | +1.9       |
| street       |   87.5 |   89.4 | +1.9       |
| postcode     |   99.7 |   99.7 | flat       |
| **country**  |   62.7 |   59.2 | **−3.5** ⚠ |

Net FR improvement (incl. `fr.house_number` held at 99.5 — v1.5.0's raison d'être) **except
fr.country −3.5pp**. Likely mechanism: the shard's bare `Commune, Département` rows carry
`country: FR` metadata but **no country token in the text**, so the model learns to emit country less
often on FR. Coordinate-invisible for the FR coord eval (which is given `--default-country FR`), but
over the 2pp gate — a clean v1.8.1 refinement is to mix in FR rows that DO carry "France".

## Verdict — v1.8.0 is a net win on the shipped coordinate; RECOMMEND promote (operator GO), with two flagged label deltas

**FR coordinate massively up (p50 42→2 km, −40% mean), US coordinate flat.** This is the first model
in the arc (v1.6.0 and v1.7.0 both HOLD) to genuinely surpass v1.5.0 on the metric we ship. **Two
label deltas exceed the 2pp gate, and both are coordinate-invisible:** us.locality −2.2pp
(precision-only — 0 recall misses; spurious-fp on fragment rows) and fr.country −3.5pp (the resolver
is given the country, so it doesn't reach the coordinate). No silent drift — both are stated here and
on #728; the promote is the operator's call with the full picture.

Per the merge wall this is **NOT auto-promoted** — the artifact is staged beside the canonical
(int8 `model-v180-step-40000-int8.onnx`, md5 `d163396ce30869e117bf29ffb939177b`, on the volume +
`./out/v180/`) and flagged for operator GO. The 2pp label gate technically fired, but the coordinate
(the canonical metric) is flat-to-better, so this is the "regression is coordinate-invisible — state
the trade, operator promotes" path, not an experimental-as-cover ship.

**Residual:** #727 diacritic is only _partially_ fixed — the break rate among emitted régions halved
(2.8%→1.1%) but ~24 absolute cases remain; the residual is likely tokenizer-level (the accent strands
a subword) and wants a separate decode/tokenizer look, not more shard data.

## What went well

- **Salvage-first paid off:** codex `departementForCodePostal`/`FR_DEPARTEMENTS`, AU `state.ts`, and
  the `build-fr-order-shard.mjs` template meant zero re-derived reference data and a fast build.
- **Pre-GPU falsification:** the self-validation gate turned "plausible lever" into "evidence-backed
  ceiling" before the GPU spend — the discipline the whole day's campaign was about.
- **Real data throughout** (BAN, 27M rows → 35k distinct communes), anchor landing 99.9%.

## What could've gone better

- **The zero-padded `step-040000` gotcha bit once** — `export_onnx --step=40000` looked for
  `step-40000` (the dir is `step-040000`); cost one failed export. The runbook flags it; I should
  have padded from the start.
- **A `grep + 2>/dev/null` pipe on the first US eval discarded the whole table** (and I ran the 10k
  default instead of `--limit 2000`), costing a re-run. Don't filter+silence an eval you haven't seen
  the shape of; run it visible first, then filter.
- **#727 only partially fixed by the shard** — the diacritic break is tokenizer-level, so more shard
  data couldn't fully close it (diagnosis after the fact, not before).

## Decisions made autonomously

- **FR-only first build** (the min-viable cut): AU + venue-leading deferred to a second run. FR has
  hard coordinate truth and a closed département set; the space-delimited shape is covered via FR's
  own space variant. Lower-risk first GPU spend.
- **Shard weight 6.0** (matching synth-german, the other intl coverage shard) — strong signal,
  modest enough that the ~90%-US base corpus still dominates the batch (the #375 narrowing guard).
- **Cloned v1.5.0-fr-order verbatim** except the one added shard (one headline variable).
- **AU iteration deferred — and now known to be BLOCKED:** the resolver DB (`admin-global-priority.db`)
  has **zero AU rows** (US+DE+FR only), so AU places can't be resolved → no AU coordinate gate is
  possible without first expanding the resolver DB to AU. FR-only wasn't just the min-viable cut, it
  was the only feasible one. (Verify-before-build caught this during training-window prep.)

## Open questions (operator)

- Promote v1.8.0 → v4.x default? (Gated on the verdict below + operator GO; merge wall.)
- If it lands: the AU + venue-leading second run, and whether to ship a held-out AU coordinate set.

## Concrete next steps

- **Operator promote decision for v1.8.0** (the artifact + md5 are staged; gate evidence above). If
  GO: the standard release flow (releases.json + HF/R2 publish; the int8 is
  `/data/models/quantized/model-v180-step-40000-int8.onnx` + `./out/v180/model.onnx`).
- **#727 diacritic follow-up** — tokenizer/decode-level (the accent strands a subword as its own
  span); not a shard-data fix. A decode-side span-merge or a tokenizer look.
- **AU iteration is blocked** until the resolver DB (`admin-global-priority.db`) gains AU rows — scope
  an AU WOF ingest if AU coverage is wanted (then the AU admin-split shard is a fast follow on the FR
  template).
- **The shard + gate are reusable** — `build-fr-admin-split-shard.mjs` + `fr-admin-split-gate.ts` +
  `fr-admin-split-selfvalidation.ts` generalize to other locales with trailing postcodes (ES/IT) once
  their resolver coverage exists.

## Numbers table

|                   |                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shift window      | 2026-06-19 02:00→15:00 UTC                                                                                                                                                                                                                                                           |
| Models trained    | 1 (v1.8.0-fr-admin-split, from scratch, 40k steps)                                                                                                                                                                                                                                   |
| Modal $           | ≈ $5 (1× A100-40GB ~2h train + export/quantize/sync)                                                                                                                                                                                                                                 |
| NaN incidents     | 0                                                                                                                                                                                                                                                                                    |
| Loss-abort gate   | PASSED (loss 5.0 → ~0.7, decreasing)                                                                                                                                                                                                                                                 |
| GPU lost to error | ~0 (one failed export attempt, CPU-side, seconds)                                                                                                                                                                                                                                    |
| Verdict           | v1.8.0 = net win on shipped coordinate (FR −40%, US flat); 2 coordinate-invisible label deltas (us.locality −2.2 precision-only, fr.country −3.5); RECOMMEND promote (operator GO)                                                                                                   |
| Promoted          | YES — shipped as **v4.11.0** (2026-06-19 PM, operator GO with the two coordinate-invisible deltas); HF + R2 + npm verified at md5 `d163396c`, clean `npm install mailwoman@4.11.0` resolves; npm leg needed one `publish_only` retry (transient OIDC E401). Runbook in RELEASING.md. |
