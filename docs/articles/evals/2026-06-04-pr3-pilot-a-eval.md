# PR3 Pilot A — self-conditioning decisive eval

**Date:** 2026-06-04
**Model:** `v0.9.0-pilot-selfcond-s42`, step-20000 (early gate), fp32 ONNX
**Baseline:** v0.7.2 (`/tmp/v072-eval/model.onnx`), fp32, same v0.6.0-a0 tokenizer, same 33-label schema
**Verdict:** **Do not promote. Clean negative result.** Self-conditioning did not prevent the German end-of-string locality collapse.

## What the pilot tested

One hypothesis (design doc: `docs/articles/plan/2026-06-04-pr3-self-conditioned-retrain.md`): a from-scratch model with an auxiliary locale head over the pooled sequence + zero-init FiLM modulation of its own per-token reps would learn German word order **without** triggering the v0.8.0 Saint-Albans span collapse. Single variable on the v0.7.2-proven recipe (1.5e-4 constant, ls 0.1, CRF off); the only addition is the conditioning. Corpus `v0.4.1-de`: v0.4.0 (US/FR) base + a 200K-row synth-german overlay (~18% of the mix).

## The pre-registered gate, and the result

| Gate (from the design doc) | Target | Result | Pass? |
|---|---|---|---|
| DE locality — resolver match | ≥ 70% and rising | **25.6%** | ❌ |
| DE locality — parse F1 (held-out golden) | ≥ 70% | **34.8%** | ❌ |
| US/FR resolver utility vs v0.7.2 | within ~1pp | US locality −1.6pp | ⚠️ (confounded by 20k-vs-100k) |
| cross_pollution per locale (live) | < 1% | 0.00% throughout | ✅ (but blind — see below) |

## DE — the headline locale collapsed

Resolver eval (the pre-registered judge), German OA sample, n=3000, `--default-country DE`, postcode-anchor on. Figures self-emitted to `/tmp/pilot-eval/resolver-{pilot,v072}-de.md`.

| parser | locality-match | region-match | resolved | coord p50 (anchor) |
|---|--:|--:|--:|--:|
| v0.7.2 (baseline) | **77.4%** | 43.6% | 99.4% | 1.3 km |
| Pilot A (self-cond) | **25.6%** | 0.0% | 37.1% | 1.3 km |
| v0 (Pelias rules) | 79.4% | 99.3% | 99.3% | — |

Per-state: Pilot Berlin 34.2% / Sachsen 16.9%, against v0.7.2's Berlin 100.0% / Sachsen 54.7%. **−51.8pp on DE locality.** The postcode anchor still pins the coordinate (p50 1.3 km) because it extracts the postcode independently of the parser — but the admin **match** is gone, because the locality span itself is gone.

Parse F1 on the held-out German golden (1500 rows, `data/eval/external/openaddresses-de-golden.jsonl`) tells the same story and adds the texture:

| tag | Pilot A | v0.7.2 | Δ |
|---|--:|--:|--:|
| locality | 34.8% | 72.5% | **−37.7** |
| postcode | 31.4% | 89.0% | **−57.6** |
| street | 41.3% | 19.1% | +22.2 |
| house_number | 35.5% | 14.6% | +20.9 |
| exact-match | 28.7% | 11.3% | +17.4 |

That shape — street and house_number **up**, locality and postcode **down**, exact-match up — is the v0.8.0 Saint-Albans signature exactly. The pilot genuinely learned German street order (v0.7.2 mangles German streets under its US-order prior); it paid for it by dropping the trailing city.

### What the collapse actually looks like

Raw parses, pilot vs v0.7.2 (`scripts/diag-de-pilot.ts`):

```
Davoser Straße 22 A, Berlin
  pilot: street="Davoser Straße 2"  house_number="2 A"          ← "Berlin" dropped
  v072 : locality="Davoser Straße"  postcode="22"  locality="Berlin"  street="A"

Prager Straße 8, 01069 Dresden
  pilot: street="Prager Straße 8"  postcode="01069"             ← "Dresden" dropped
  v072 : locality="Dresden"  street="Prager Straße 8"  postcode="01069"

Bautzner Straße 101, 01099 Dresden
  pilot: street="Bautzner Straße 10"  house_number="1"  postcode="01099"   ← "Dresden" dropped
  v072 : locality="Dresden"  street="Bautzner Straße 101"  postcode="01099"
```

The pilot drops the **trailing city** (locality → O) once it has committed to `street house [postcode]`. The aux locale head correctly identifies German (locale_acc 0.95–0.97 throughout training) — but a FiLM scale/shift over per-token features never imposes "a locality must still live at the end of this string." Knowing the country is not the same as keeping the city.

## US — healthy, the failure is German-specific

US resolver eval, n=2000, `--default-country US`:

| parser | locality-match | region-match | resolved |
|---|--:|--:|--:|
| v0.7.2 | 97.7% | 99.9% | 100.0% |
| Pilot A | **96.1%** | 99.8% | 100.0% |
| v0 (rules) | 95.8% | 99.5% | 99.7% |

The pilot is within 1.6pp of v0.7.2 on US locality **and still beats the rules parser** — at 20k from-scratch steps against v0.7.2's 100k. The US street parse-F1 regression (−18pp) doesn't reach the resolver because US locality is position-robust. So the conditioning architecture didn't poison the dominant locale; the damage is confined to German order. That localizes the problem cleanly: this is the boundary bug, not a training blow-up.

## The corpus is correct — this is not garbage-in

Every German training row labels the trailing city properly (`/tmp/german-train.jsonl`):

```
Dommitzscher Straße 19, Torgau   →  …  19|B-house_number  Torgau|B-locality
Am Westhang 7, 01734 Rabenau Sachs →  …  01734|B-postcode  Rabenau|B-locality  Sachs|I-locality
Grünsteinweg 45 H, Berlin        →  …  45|B-house_number  H|I-house_number  Berlin|B-locality
```

The model was shown the right answer 200K times and still learned to drop it. The hypothesis got a fair test; it failed on its own terms.

## Why the live tripwires stayed green

Two blind spots let training look healthy to the dashboard while German was breaking:

1. **`cross_pollution` measured the wrong failure.** It counts gold city/region-start tokens predicted as *postcode* (B/I-postcode). The actual collapse is city → **O** (dropped), not city → postcode. So the metric read 0.00% the whole run while locality recall cratered. A live DE-locality-recall (or city→O) tripwire would have fired.
2. **Aggregate val F1 hid it.** The headline val locality F1 was 0.829 — but that's US-dominated (US is ~82% of the mix). The German-specific locality was never in the headline. Per-locale val F1, streamed live, is the fix.

## Shipped from this run regardless

- **Export bug fix (`corpus-python/src/mailwoman_train/model.py`).** The FiLM split used `.chunk(2, dim=-1)`, which the dynamo exporter emits as an opset-18 `Split(num_outputs=2)` node. onnxruntime-node — and the WASM/WebGPU web runtime — reject it: `Unrecognized attribute: num_outputs`. v0.7.2 had no FiLM so it never hit this. Replaced with two explicit slices (`film[..., :H]`, `film[..., H:]`) — mathematically identical, same trained weights, every runtime loads it. Any future self-conditioned export needs this. 11 PR3 CPU tests stay green.

## Decisions made

- **Did not promote** the pilot to `releases.json` / HF. Gate failed by ~45pp on the headline metric; the model is not on disk anywhere a consumer would pick it up.
- **Did not launch the 100k follow-up.** That was conditional on the gate passing. At 25.6% (vs a 70% bar), and with the 10k-vs-20k slope flat (German locality pinned — see above), extending to 100k would not cross the bar. Not justified by this data.
- **Did not launch another from-scratch German pilot autonomously.** This is the 2nd reproduction of the same end-of-string locality collapse via a *new* mechanism (v0.8.0 continue-train was the 1st), on correct data. The evidence now points away from recipe/conditioning tweaks. The next direction is the operator's call.

## The slope: flat, not rising — the recipe is not salvageable by more steps

Exported step-10000 and re-ran the same DE evals to test whether German locality is climbing across steps. It is not:

| metric | step-10000 | step-20000 | Δ |
|---|--:|--:|--:|
| DE resolver locality-match | 25.5% | 25.6% | +0.1 |
| DE parse locality F1 | 35.4% | 34.8% | −0.6 |
| Berlin locality | 34.2% | 34.2% | 0.0 |
| Sachsen locality | 16.8% | 16.9% | +0.1 |

Doubling the training moved German locality essentially zero — Berlin is pinned at 34.2% at *both* checkpoints. The collapse is a **converged failure mode** the model settled into by step-10000 and stays in, not an undertraining artifact. A 100k run of this recipe would not cross the 70% bar. So "just train longer" is off the table, and the fix has to be structural.

## Open questions for the operator

1. **Structural vs. statistical fix.** A FiLM scale/shift can't enforce structure. Candidates that can: a trained CRF transition prior (was off here — the bf16 NaN history), a positional "last content token is rarely O" constraint, or the **anchor-based parsing direction** (DeepSeek-signed, `project-anchor-based-parsing-direction`) — postcode-as-anchor → country posterior → soft channel — which doesn't depend on the parser recovering locality from raw spans at all. The last is the standing LEAD.
2. **Does the resolver already paper over this?** With the postcode anchor pinning coordinates at p50 1.3 km even when locality-match is 25.6%, how much does the dropped city actually cost a production lookup? Worth quantifying before deciding how hard to chase the parser fix.

## Numbers

| | |
|---|--:|
| Modal spend (pilot train, prior session) | ~$2–3 |
| Modal spend (3 ONNX exports this session) | ~$0.45 |
| Local eval compute | ~18 min (CPU ONNX) |
| Models promoted | 0 |
| Bugs fixed | 1 (FiLM chunk→Split export) |
| NaN incidents | 0 |
