# Parser-improvement backlog (2026-05-30)

Scoped from the **three-arena capability eval** (libpostal + corpus-perturbation
+ postal-standards). Those arenas — unlike our own Pelias-derived 376-assertion
suite — surface where the neural parser actually fails. This doc turns those
failures into a prioritized backlog, categorized by **fix mechanism**, because
the mechanism (not the symptom) determines cost and risk.

## The capability picture

| arena | what it tests | v0 | neural | takeaway |
| --- | --- | --: | --: | --- |
| libpostal | clean/canonical | 29% | rules-favoured | gazetteer + rules win on their turf |
| perturbation | noisy/degraded | 39% | 64% | neural is the robustness layer |
| postal-standards | edge formats | 26% | TBD@v0.7.2 | coverage gaps on military/PO-box/rural-route |

The neural model is the **robustness layer**, not a worse v0. The backlog
below sharpens that layer where the arenas show it bleeding.

## The real neural failures (from arena spot-checks)

1. **Drops secondary units** — `… Apt 456` → no unit label; postal
   secondary-unit edge class 0% neural.
2. **Over-spans street boundaries** — `Stone Way North Seattle` →
   `street: "Stone Way North Seattle"` (the locality bleeds into the street).
3. **Confuses country ↔ region** — `UK` labeled region; trailing country names
   dropped or mis-tagged.
4. **County → locality** — UK/IE counties (`Co. Mayo`, `Derbys`) land as
   locality instead of region.
5. **Locale sparsity** — AU/NZ/GB/IE canonical underperform US (the
   data-imbalance constraint, already on the tier list).

## Categorize by fix mechanism

The cheapest, lowest-risk lever is a **deterministic post-decode repair pass**
(the postcode-repair `#35` family): detect a rigid surface shape with a regex,
snap/add the BIO labels after decode, before tree-build. The model is untouched,
the pass is opt-in, and precision guards keep it from regressing a confident
parse. Postcode-repair earned default-on at a measured **+135/0**. Not every
failure fits that mould — some need coverage (retrain) or a boundary model.

| # | failure | mechanism | cost | risk | status |
| --- | --- | --- | --- | --- | --- |
| B1 | drops units | **post-decode repair** | low | low (opt-in) | ✅ **built** (`unit-repair.ts`) |
| B2 | country↔region | **post-decode repair** (country lexicon) | low | low (closed set) | scoped |
| B3 | county→locality | coverage (lexicon or synth) | med | med | scoped |
| B4 | street over-span | decoder/boundary (gazetteer-clip or morphology-FST anchor) | high | med-high | scoped |
| B5 | locale sparsity | coverage (real EU/Oceania data, #40) | high | low | tier-listed |

**Why units fit the repair mould and street-overspan doesn't:** a unit has a
self-announcing shape (`Apt`/`Ste`/`Unit`/`#` + identifier). A street boundary
is defined by *what comes after it* — there's no local shape that says "the
street ends here," so a regex can't draw the line. B4 needs either a locality
gazetteer to clip the tail or the street-morphology FST to anchor the head;
both are real work and belong after the cheap repairs land.

## B1 — unit-repair (BUILT)

`neural/unit-repair.ts` + `unit-repair.test.ts`, wired as opt-in
`ParseOpts.unitRepair` and harness `--unit-repair`. Mirrors postcode-repair:

- **Detect** explicit designators (`Apt`, `Apartment`, `Ste`, `Suite`, `Unit`,
  `Rm`, `Room`, `Fl`/`Floor`, `Bldg`, `Dept`, `Lot`, `Flat`, `PH`, …) + an
  identifier (`4B`, `12`, single letter `STE D`), plus bare `#104`.
- **ADD** a unit span only over `O` tokens (never over house_number / street /
  postcode / po_box / a geographic container). **SNAP** an existing unit span to
  the full shape. Local smear-clip on the flanks.
- **Precision guards:** word-boundary after the designator (so `Unit` ≠ inside
  `United`, `Fl` ≠ `Florida`); excludes `Box` (po_box), bare `F`/`No`,
  `Space`/`Stop` (common words); single-letter ident only fires on a standalone
  token.

**Validation plan:** opt-in until the v0.7.2 arena re-run quantifies the delta
on the postal secondary-unit class and the libpostal sub-premise cases (target:
secondary-unit 0% → meaningfully positive, zero regression elsewhere). Promote
to default-on only on a clean +N/0, exactly as postcode-repair was.

## B2 — country-repair (scoped, not built)

Same mould as B1. A closed lexicon of country names/codes (`UK`, `United
Kingdom`, `USA`, `U.S.A.`, `Canada`, `Australia`, `New Zealand`, `Ireland`,
`GB`, …) → force `B-country` when the model tagged it region/locality/O at the
**tail** of the address (position guard: only the trailing run, so `Washington`
the city isn't clobbered). Closed set + position guard = low risk. Build next if
B1 validates the pattern again.

## Sequencing

1. ✅ B1 built (this session). Measure at the v0.7.2 arena re-run.
2. B2 country-repair — build if B1's measured delta confirms the repair lever
   still pays on v0.7.2.
3. B5 / B3 — coverage items fold into the next training shard (real EU/Oceania
   data, #40), not a post-decode pass.
4. B4 street-overspan — design after the cheap repairs; it's the one true
   model/decoder change here and deserves its own investigation.

All deltas measured through `scripts/eval/external-arenas.sh` against the v0.7.2
model — the same three-bucket harness that surfaced the failures.
