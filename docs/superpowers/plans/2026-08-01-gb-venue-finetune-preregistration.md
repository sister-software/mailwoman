# GB venue-led fine-tune — pre-registration (#1366, the first B11 template exercise)

This document was written before any code, data, or GPU spend. The run has two goals. It should
fix the GB venue-led class, and it is the first end-to-end exercise of the B11 fine-tune template:
init_from model 7.0.0, the Fisher/EWC brake, λ calibration, and the acceptance battery as the final
check.

## The defect (from #1366, attribution verified on the rebuilt regression DB)

GB venue-led full addresses ("Ye Three Lords, 27 Minories, London EC3N 1DE") never get a venue
span on shipped 6.7.0 or on the 7.0.0 base. The house-venue extract taught FR ("…, 75005 Paris")
and US ("…, Springfield, IL 02101") tails. The GB tail is a locality followed by a postcode, with no
region and no comma ("London EC3N 1DE"), and it matches neither template. GB venue-led rows
therefore fall into the collapse seen in shipped models, where the venue is absorbed as a locality
or street.

## The delta (one mechanism, pre-registered)

1. **Synthesizer**: add a GB order to `synthesize-house-venue.ts`. It uses the tail
   `${locality} ${postcode}`, emits no region, uses locale `en-GB`, and covers both the
   venue-before and venue-after templates. GB house numbers are sometimes sampled as ranges
   ("287-293"), because the range form appears in the target class.
2. **Venue pool**: add a GB-flavored pool alongside PLAIN_VENUES. It includes institutional forms
   (Club/center/House/Arms/Station), archaic "Ye" names, and brand–dash–place compounds, including
   names that start with a direction, since the target class has venues that begin with compass
   words. **The six probe venues are excluded**, so the gauntlet fixtures stay held out.
3. **Tuples**: extend `build_house_venue_tuples.py` with `--gb`, which samples from the on-disk
   PPD derivation (`$MAILWOMAN_DATA_ROOT/ppd/2026-07-22/gb-tuples.csv`: NUMBER/STREET/CITY/DISTRICT/
   REGION/POSTCODE). The output is house-venue-tuples-v3.jsonl (FR 60k + US 60k + GB 60k).
4. **Feed**: use the v0.15.0-venue feed with the house-venue extract rebuilt from v3 tuples, at the
   same weight of 2.0. Everything else stays byte-identical. The fine-tune follows the v3.2x
   precedent: init_from the 7.0.0 base checkpoint (step-060000), a fresh optimizer, 8k steps, and a
   graded checkpoint every 2k steps.
5. **EWC**: `ewc_fisher_path` is fisher-diag-v1 (the 7.0.0 artifact), `ewc_reference` is the base
   checkpoint, and λ comes from the calibration below.

## λ calibration (the template's one open knob — calibrated here, inherited by B11)

Sweep λ ∈ {0, 1e2, 1e4, 1e6} with 2k-step probes on an identical feed and config. Grade each probe
at step-2000 on (a) the GB venue target board (the extract's own held-out template rows plus golden
venue tags) and (b) the quick base legs (P0 fragment sample plus golden sample). **Pick rule
(verbatim from the Fisher design): the largest λ that leaves the target metric within noise of
λ=0.** That λ becomes the B11 template default. Ties go to the larger λ.

## Bars (the main run at the chosen λ)

- **V1 (target)**: all six #1366 gauntlet `improvement_target` fixtures flip to pass at the ship
  config. Only six of six counts as a pass.
- **B1 (the guarantee check, the claim the product sells)**: the full `v7.0.0-base` spec passes
  with no floor waivers. Gauntlet regression and metamorphic checks pass, the canary shows zero
  flips, and the P0 fragment grid stays within noise of the base. The product claim this run tests
  on itself is that a Fisher-guarded fine-tune keeps every base capability.
- **Receipt**: a per-λ probe table, the chosen λ with its rationale, before/after results on the
  six fixtures, and battery deltas against the base.

## Stop rules

- If the main run misses V1, one contingency run is allowed, and only with a named mechanism (for
  example, the GB venue pool composition or the range-number rate). A second miss goes to an
  operator conversation, and there is no third launch.
- If B1 misses at the chosen λ, do not ship. Report the conflict between λ and the target as the
  finding, since it sets the cost of the B11 guarantee.
- If only λ=0 clears V1, then λ=0 is the calibrated answer. Record it, and the template inherits it
  directly instead of a larger value.

## What ships on PASS

Model 7.0.1 (a venue increment off the 7.0.0 base) is **staged rather than auto-promoted**. The
operator makes the promote decision with the verdict in hand. The gauntlet fixtures flip from
`improvement_target` to `pass` only at promote time.

---

## Addendum 1 (2026-08-01, post-probe — BEFORE the main run)

The first λ sweep (v4.1.0, venue weight 2.0, lr 1e-5, 2k steps) produced **no signal**. All four
λ values were byte-identical to the base on the six target fixtures, and GB board venue moved from
53.8% to 54.5%, which is noise. The exposure arithmetic explains the design defect. At weight 2.0
the venue extract is about 1.4% of samples, so the run saw about 7k venue rows (about 2.4k GB) in 2k
steps at a fine-tune learning rate. The probe cannot test λ if the increment leaves the outputs unchanged, so the
sweep result is void. It does not show that λ is unconstrained.

**Named revision (the one allowed):** raise `synth-house-venue` to **12.0** for the fine-tune feed,
following the v3.8.x oversample precedent (the no-fragment run used 12.0 for its corrective
extract). Re-run the identical 4-λ × 2k sweep as v4.1.2, with everything else unchanged. The λ pick
rule applies at the revised weight. If the revised probe still shows no target movement, stop and
talk to the operator before any further spend, because the mechanism itself, and not the weight,
would then be in question.

---

## Addendum 2 (2026-08-01) — MAIN-RUN VERDICT: V1 MISS / B1 PASS → operator conversation

**λ calibration result**: at weight 12.0 the sweep separated. λ=1e6 held back the target (−4.5pp
venue on the board), while λ=1e2 and λ=1e4 stayed within noise of λ=0. **λ=1e4 is therefore the
calibrated B11 template default**, and the sweep is its receipt.

**B1 (the guarantee check): pass.** The 8k main run (v4.1.1, weight 12, λ=1e4, md5 02b8c323…)
passes the full v7.0.0-base spec (every floor, without waivers) and the full gauntlet (regression,
metamorphic, and held-out). The claim "a Fisher-guarded fine-tune holds every base capability" held
on its first test.

**V1 (target): miss, with 2 of 6 full flips** (North Face - Covent Garden, East India Club). Two
more fixtures made real partial progress. New North now gets house_number "287-293" and the
postcode right, and Far East now extracts the mixed-script venue in full. GB board: venue
53.8→80.8, locality 54→78.8, postcode 74.5→92.3, all-components 10.5→20.5.

**Why another weight change would not fix the remaining three.** The stop rules end the run here
because the three remaining fixtures fail through three different mechanisms, and the extract
teaches none of them:

1. _Typeless GB street names_ ("Minories", with no Road/St/Close token). Board street accuracy
   stayed near 29% at every weight, and the PPD tuples are overwhelmingly typed streets. Ye Three
   Lords needs the model to accept a bare proper noun as a street from its position alone.
2. _The doubled bare venue_ ("Southfields Station, Southfields Station"). This is a venue-only
   fragment and does not match the extract's venue+address template.
3. _Abbreviated internal directionals_ ("New N Rd") next to a venue that starts with a direction.
   "13 Gerrard St" also shows a digit-split oddity (house_number "Ger") that deserves its own look.

Each can become named future work: a typeless-street extract leg, a venue-only doubled template in
the no-street extract, and an abbreviation-augmentation pass over the GB leg. That is three
mechanisms, and the envelope allows one contingency. **The run stopped per the pre-registration.
The candidate (model 7.0.1-candidate, staged rather than promoted) and all receipts go to the
operator.** The six gauntlet fixtures stay `improvement_target`.

---

## Addendum 3 (2026-08-01) — the country-tail mechanism: BANKED AS CODE, run deferred

The probe set's strongest named mechanism comes from the FR control row: a trailing country surface
makes the whole venue template out of distribution. The synthesizer now covers it with
`COUNTRY_APPEND_RATE = 0.3` across every template order. The appended surface is tagged `country`
and drawn from per-country surface pools (including the UK/United Kingdom mix), and rate-band and
order tests cover it. The fine-tune run (`v4.1.3-gb-venue-country-8k.yaml`, calibrated weight 12,
λ=1e4) is deferred by the operator's budget call. The next base retrain would supersede a
fine-tuned 7.0.1 anyway, and the extract code is the part that lasts, since the next base feed
inherits it. Pre-registered bars for whoever runs it:

- T1: `fr-op2-le-colimacon` flips to a full pass.
- T2: op2 venue-field hits at least double relative to the staged 7.0.1 candidate.
- T3: the six #1366 fixtures score at least the candidate's 2.
- B1: the full battery and gauntlet pass with no waivers.

Stop rule: any miss goes to an operator conversation, with no contingency run.

---

## Addendum 4 (2026-08-01) — country-tail RUN VERDICT: NEGATIVE (stopped per the stop rule)

The v4.1.3 run (weight 12, λ=1e4, v0.15.2 overlay, md5 baccf7df) fails its bars. For T1, the FR
control still fails at both the pipeline and bare-classifier levels. The model learned to tag the
tail (`country` now emits on tailed rows), but it did not learn to find the venue in rows with a
tail. Venue is null everywhere, and the FR control's house_number degraded from 44 to "4". The
corrected gauntlet shows 0 newly passing fixtures and a conditional regression (VERDICT FAIL).

The likely mechanism is that at fine-tune weight the model learns the new pattern by its easiest
route (tail token → country). The added tail tokens then dilute the venue boundary signal instead
of extending it. The extract change stays in the code, because a from-scratch base learns the joint
pattern from step 0, and the run-2 lesson says composition behaves differently in base training.
The fine-tune route to this pattern is now recorded as a dead end. There are no further launches,
and the staged 7.0.1 (v411, B1-clean) remains the best venue candidate.
