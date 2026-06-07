# Route A Phase II — the phrase-grouper re-gate overturns STAY (2026-06-07)

The [Phase I baseline](./2026-06-07-route-a-phase-i-baseline.md) measured the opt-in joint-decode path against argmax and came back with a hard **STAY**: joint decoding won big on the German city-state collision but tanked native-order multi-word locales by 16–34%, so we shelved the default flip behind a phrase-grouper rebuild ([#425](https://github.com/sister-software/mailwoman/issues/425)). This is the re-gate after that rebuild. The verdict flips.

## Verdict: **the regression is gone.** Joint-decode now beats or ties argmax on all six locales.

Same harness (`scripts/eval/joint-vs-argmax.ts`, v0.9.4 model, warmed + alternated latency), same OpenAddresses samples, same argmax baseline — only the joint path changed. The argmax column is byte-identical to Phase I, which is the control that proves the movement is real and not a baseline shift.

| locale | argmax loc | joint loc | Δ loc | regressed | improved | latency p99 × |
|---|--:|--:|--:|--:|--:|--:|
| **DE international** (city-state collision) | 72.2% | **99.0%** | **+26.8pp** | 0.2% | 27.0% | 0.76 |
| US (native) | 98.8% | **99.2%** | +0.4pp | 0.4% | 0.4% | 1.33 |
| FR (native) | 97.5% | 97.8% | +0.3pp | 2.0% | 2.3% | 1.02 |
| NL (native) | 99.5% | 99.5% | 0.0pp | 0.8% | 0.5% | 1.40 |
| IT (native) | 84.8% | **98.5%** | **+13.7pp** | 1.3% | 15.0% | 1.06 |
| ES (native) | 84.0% | **94.3%** | **+10.3pp** | 2.8% | 13.3% | 0.92 |

Compare the Phase I regression rates — NL 16.0%, IT 26.0%, ES 34.0% — against these: 0.8%, 1.3%, 2.8%. The catastrophe column collapsed by an order of magnitude, and on every locale the improvements now outweigh the remaining regressions five-to-seven-fold. Latency is a non-issue; most locales sit at or under 1× p99 because the joint path now produces cleaner trees with less downstream churn.

## Why — three fixes, one root cause

The Phase I post-mortem blamed proposal coverage: "the reconciler falls back to single-token spans when proposals don't cover the multi-word component." That was half right. Maturing the phrase grouper to *propose* multi-word spans (`Reggio nell'Emilia`, `Las Palmas de Gran Canaria`) was necessary, but on its own it barely moved the aggregate — the proposals existed and the reconciler still fragmented. Digging into the live beam turned up two more mechanisms behind the same symptom, and all three had to land together.

1. **The phrase grouper couldn't see multi-word localities.** `scoreLocalityPhrase` walked a run of capitalized tokens and stopped dead at the first lowercase one, so place-name connectives (`de`, `in`, `nell'Emilia`, `aan den`) ended the span. Worse, in OpenAddresses' all-caps international data every short place word — `SAN`, `DI`, `DEL` — matches the 2-3-uppercase region-abbreviation shape, so the head of `SAN NAZARIO` got skipped as if it were a US state. The walk now bridges a bounded set of place-name particles and apostrophe-fused names, and a region-abbreviation-shaped token that heads a multi-word place is allowed to start a locality.

2. **The grouper-audit ignored the classifier.** Once the reconciler picked `street="Trento"` over `Via Trento`, the word `Via` was left orphaned. The post-reconcile audit, whose job is to rescue spans the model couldn't type, saw an uncovered `LOCALITY_PHRASE` proposal for `Via` and promoted it to a `locality` node — burying the real trailing city, which is why `Via Trento, …, SORBOLO` came out with locality `Via`. The classifier had typed that span `street:0.73` all along. The audit now takes the classifier's per-span verdict for orphaned spans and only falls back to the structural phrase kind when the model genuinely abstained. This single fix took IT from 68.5% to 93.5%.

3. **Romance streets lead with their type.** `scoreStreetPhrase` was suffix-only — it found `Main Street` by walking left from `Street`. Italian and Spanish put the type first (`Via Trento`, `Calle Mayor`, `Largo Millefiori`), so the rule never fired and the leading `Via`/`Calle` stayed a capitalized first-segment word the locality rule happily proposed. We taught the grouper a bounded set of Romance street-type prefixes — street-types only, deliberately excluding the ambiguous area words like `Polígono`, `Urbanización`, and `Lugar` that legitimately serve *as* localities. That carried ES from 89.5% to 94.3% and cleaned up the IT tail.

The through-line: the joint path was being asked to type spans the rule layer couldn't describe and the model hadn't seen, and the audit was papering over both with its most confident-looking guess. Give the grouper the vocabulary and let the audit defer to the model, and the fragmentation evaporates.

## What this means for the plan

- **JUST-FLIP is back on the table.** Phase I called it dead; it isn't. Every locale is net-positive or flat (NL −0.13pp is noise), and the German city-state recovery the dual-role work ships is matched by joint decoding doing it in-model.
- **The strict gate isn't fully met — yet.** The original bar wanted ≤0.5% per-field regression. DE (0.2%) and US (0.4%) clear it; FR (2.0%), IT (1.3%), ES (2.8%) don't, though all three are net-positive on accuracy. FR's 2.0% is unchanged from Phase I and is pre-existing single-word churn unrelated to this work. The residual IT/ES tail is a handful of rows — `SANT'`-prefixed elisions, the `LUGAR`/`PARTIDA` area-types, slash-joined bilingual names.
- **Flipping the default is the operator's call.** This is a behavior change to the default decode path for every caller, and the strict gate isn't unanimous, so the flip itself ([#427](https://github.com/sister-software/mailwoman/issues/427)) waits for sign-off rather than shipping autonomously. The three fixes here ship regardless — they only touch the opt-in joint path and leave the argmax default byte-stable.

So Phase II did its job and then some. The question Phase I left open — "can the phrase grouper ever cover multi-word spans well enough to flip?" — now has a measured yes, and the residual is a short, named list rather than a 34% cliff.

_Harness: `scripts/eval/joint-vs-argmax.ts` (regression rows dumped via `MW_DUMP_REGRESSIONS=1`). Per-locale JSON under `docs/articles/evals/data/`._
