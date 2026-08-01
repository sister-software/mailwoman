# GB venue-led fine-tune — pre-registration (#1366, the first B11 template exercise)

Written before any code, data, or GPU spend. This run is double-duty: fix the GB venue-led class
AND exercise the B11 fine-tune template end-to-end for the first time (init_from model 7.0.0 +
the Fisher/EWC brake + λ calibration + the acceptance battery as exit).

## The defect (from #1366, attribution verified on the rebuilt regression DB)

GB venue-led full addresses ("Ye Three Lords, 27 Minories, London EC3N 1DE") never get a venue
span on shipped 6.7.0 OR the 7.0.0 base. Mechanism: the house-venue shard taught FR
("…, 75005 Paris") and US ("…, Springfield, IL 02101") tails; the GB tail — locality THEN
postcode, no region, no comma ("London EC3N 1DE") — matches neither template, so GB venue-led
rows fall into the shipped-era collapse (venue absorbed as locality/street).

## The delta (ONE mechanism, pre-registered)

1. **Synthesizer**: a GB order in `synthesize-house-venue.ts` — tail `${locality} ${postcode}`,
   no region emitted, locale `en-GB`, both venue-before/after templates. GB house numbers sample
   RANGES some of the time ("287-293") — the range form appears in the target class.
2. **Venue pool**: a GB-flavored pool alongside PLAIN_VENUES — institutional forms (Club/Centre/
   House/Arms/Station), "Ye"-archaic, and brand–dash–place compounds, INCLUDING directional-led
   names (the target class is venue-leading compass words). **The six probe venues themselves are
   excluded** — the gauntlet fixtures must stay held-out, not taught to.
3. **Tuples**: extend `build_house_venue_tuples.py` with `--gb` sampling from the on-disk PPD
   derivation (`$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv`: NUMBER/STREET/CITY/DISTRICT/
   REGION/POSTCODE) → house-venue-tuples-v3.jsonl (FR 60k + US 60k + GB 60k).
4. **Feed**: the v0.15.0-venue feed with the house-venue shard REBUILT from v3 tuples, same
   weight 2.0, everything else byte-identical. Fine-tune per the v3.2x precedent: init_from the
   7.0.0 base checkpoint (step-060000), fresh optimizer, 8k steps, checkpoints every 2k, each
   graded.
5. **EWC**: `ewc_fisher_path` = fisher-diag-v1 (the 7.0.0 artifact), `ewc_reference` = the base
   checkpoint, λ from the calibration below.

## λ calibration (the template's one open knob — calibrated HERE, inherited by B11)

Sweep λ ∈ {0, 1e2, 1e4, 1e6} × 2k-step probes on the identical feed/config. Per probe, grade at
step-2000: (a) the GB venue target board (the shard's own held-out template rows + golden venue
tags), (b) the quick base legs (P0 fragment sample + golden sample). **Pick rule (verbatim from
the Fisher design): the largest λ that leaves the target metric within noise of λ=0.** That λ
becomes the B11 template default. Ties break to the larger λ.

## Bars (the main run at the chosen λ)

- **V1 (target)**: all six #1366 gauntlet `improvement_target` fixtures flip to PASS at the ship
  config. No partial credit — six of six.
- **B1 (the guarantee gate, the sellable sentence)**: the full `v7.0.0-base` spec passes with NO
  floor waivers; gauntlet regression + metamorphic PASS; canary zero-flip; the P0 fragment grid
  within noise of the base. A Fisher-protected fine-tune must hold every base capability — that
  is the product claim this run dogfoods.
- **Receipt**: per-λ probe table, the chosen λ with its rationale, before/after on the six
  fixtures, battery deltas vs base.

## Stop rules

- Main run misses V1 → ONE contingency allowed only with a named mechanism (e.g. the GB venue
  pool composition, range-number rate); a second miss = operator conversation, no third launch.
- B1 misses at the chosen λ → do not ship; report the λ-vs-target conflict as the finding (it
  prices the B11 guarantee).
- If only λ=0 clears V1, λ=0 IS the calibrated answer — record it; the template inherits it
  honestly rather than a wished-for larger value.

## What ships on PASS

Model 7.0.1 (a venue increment off the 7.0.0 base) is **staged, not auto-promoted** — the promote
decision is the operator's with the verdict in hand. The gauntlet fixtures flip
`improvement_target` → `pass` only at promote time.

---

## Addendum 1 (2026-08-01, post-probe — BEFORE the main run)

The first λ sweep (v4.1.0, venue weight 2.0, lr 1e-5, 2k steps) came back **non-signal**: all
four λ values byte-identical to the base on the six target fixtures, GB board venue 53.8% →
54.5% (noise). Dose math confirms the design defect: at weight 2.0 the venue shard is ~1.4% of
samples — ~7k venue rows (~2.4k GB) seen in 2k steps at a fine-tune lr. The probe cannot
exercise λ if the increment moves nothing; the sweep result is VOID, not "λ unconstrained".

**Named revision (the one allowed):** raise `synth-house-venue` to **12.0** for the fine-tune
feed — the v3.8.x oversample precedent (no-fragment ran its corrective shard at 12.0) — and
re-run the identical 4-λ × 2k sweep as v4.1.2. Everything else unchanged. The λ pick rule
applies at the revised dose. If the revised probe still shows no target movement, STOP —
operator conversation before any further spend (the mechanism, not the dose, would be in
question).

---

## Addendum 2 (2026-08-01) — MAIN-RUN VERDICT: V1 MISS / B1 PASS → operator conversation

**λ calibration delivered**: at dose 12.0 the sweep separated — λ=1e6 brakes the target (−4.5pp
venue on the board), λ=1e2/1e4 within noise of λ=0 → **λ=1e4 is the calibrated B11 template
default**, with a receipt.

**B1 (the guarantee gate): PASS.** The 8k main (v4.1.1, dose 12, λ=1e4, md5 02b8c323…) passes
the FULL v7.0.0-base spec (every floor, no waivers) and the full gauntlet (regression +
metamorphic + held-out). The sellable sentence — "a Fisher-protected fine-tune holds every base
capability" — held on its first dogfood.

**V1 (target): MISS — 2 of 6 full flips** (North Face - Covent Garden, East India Club), with
real partial progress on two more (New North: house_number "287-293" + postcode now correct;
Far East: the mixed-script venue now extracted in full). GB board: venue 53.8→80.8, locality
54→78.8, postcode 74.5→92.3, all-components 10.5→20.5.

**Why the residual three are NOT one more dose turn** (the reason this stops here per the stop
rules): they fail through three different mechanisms, each outside the shard's teaching —

1. _Typeless GB street names_ ("Minories" — no Road/St/Close token): board street accuracy sat
   at ~29% through every dose; the PPD tuples are overwhelmingly typed streets. Ye Three Lords
   needs the model to accept a bare proper noun as a street on positional evidence alone.
2. _The doubled bare venue_ ("Southfields Station, Southfields Station") — a venue-only
   fragment, not the shard's venue+address template at all.
3. _Abbreviated internal directionals_ ("New N Rd") interacting with a directional-led venue —
   plus a digit-split oddity on "13 Gerrard St" (house_number "Ger") worth its own look.

Each is nameable future work (a typeless-street shard leg; a venue-only doubled template in the
no-street shard; an abbreviation-augmentation pass over the GB leg) — but that is three
mechanisms, not the one contingency the envelope allows. **Stopped per pre-registration; the
candidate (model 7.0.1-candidate, staged, NOT promoted) + all receipts go to the operator.**
The six gauntlet fixtures stay `improvement_target`.
