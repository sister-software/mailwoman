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
