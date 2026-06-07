# Route A Phase I — joint-decode vs argmax baseline (2026-06-07)

The decision document for [epic #421](https://github.com/sister-software/mailwoman/issues/421). Before committing to making the joint-decode / concordance stage the default, we measured the *existing* opt-in path (`forceJointReconcile`) head-to-head against the argmax default. The result is decisive, and it points the opposite way from what you'd hope.

## Verdict: **STAY** — do not flip the default. Phase II (phrase grouper) is a hard gate, not an option.

Joint-decode wins enormously on the case it was built for and **catastrophically regresses everything else**, for one diagnosable reason. The "just flip the default" option is dead; the full programme is the only viable path, and it's blocked on a prerequisite.

## What we measured

`scripts/eval/joint-vs-argmax.ts` runs the same runtime pipeline twice per address — default vs `forceJointReconcile` — over the OpenAddresses samples (v0.9.4 model). Latency is warmed and the run-order is alternated per row so neither path eats the ONNX cold-start.

| locale | argmax loc | joint loc | Δ loc | regressed | improved | latency p99 × |
|---|--:|--:|--:|--:|--:|--:|
| **DE international** (city-state collision — the target) | 72.2% | **97.2%** | **+25.0pp** | 2.4% | 26.8% | 1.45 |
| US (native) | 98.8% | 97.4% | −1.4pp | 2.2% | 0.8% | 1.75 |
| FR (native) | 97.5% | 97.8% | +0.3pp | 2.0% | 2.3% | 2.07 |
| NL (native) | 99.5% | **84.0%** | **−15.5pp** | **16.0%** | 0.3% | 1.63 |
| IT (native) | 84.8% | **68.5%** | **−16.3pp** | **26.0%** | 9.8% | 1.73 |
| ES (native) | 83.8% | **58.5%** | **−25.3pp** | **34.0%** | 8.8% | 1.62 |

The gate (from #421) wants a regression rate **≤ 0.5%** to even consider flipping the default. The multi-word locales come in at **16–34%** — fifty to seventy times the bar.

## Why — the phrase grouper, exactly as predicted

The win and the loss have the same root. The reconciler decodes over the spans the phrase grouper proposes; when those proposals don't cover a multi-word component, it falls back to single-token spans. That's a *feature* for the city-state collision (`…, Berlin, Berlin 10115` — the second `Berlin` is a single token the reconciler can re-tag as a locality, which argmax drops — hence +25pp). It's a *disaster* for native-order locales whose place names are multi-word:

```
"Reggio nell'Emilia"          argmax → "Reggio nell'Emilia" ✓     joint → "Reggio"        (fragmented)
"Las Palmas de Gran Canaria"  argmax → "de Gran Canaria"          joint → "CALLE MAYOR"   (grabbed the street)
```

Italian, Spanish, and Dutch are dense with multi-word localities, so they take the full brunt; US and French, mostly single-word, barely move. The improvement column confirms the upside is real (DE 26.8%, IT 9.8%, ES 8.8% of rows get *better*) — joint decoding genuinely recovers cases argmax can't — but it's swamped by the fragmentation it introduces.

Latency is a non-issue: p50 is unchanged across the board and p99 sits at 1.5–2.1×, comfortably under the 3.0× ceiling. The blocker is purely quality.

## What this means for the plan

- **JUST-FLIP is dead.** Flipping `forceJointReconcile` to default today would tank locality accuracy on three of six locales by 15–25 points. No telemetry gate survives that.
- **The dual-role / multi-role work was the right call.** The city-state recovery it ships (Berlin → 80.9% PIP) is exactly the +25pp that joint-decode also delivers — but the Resolve-stage relation completion delivers it *without* the multi-word collateral. That mechanism stays.
- **FULL Route A hinges entirely on Phase II ([#425](https://github.com/sister-software/mailwoman/issues/425)) — maturing the phrase grouper to propose multi-word spans reliably.** Until the phrase grouper covers `Reggio nell'Emilia` as one span, joint decoding cannot be the default. This A/B is the re-gate: after #425, re-run it; flip only if the native-order regression drops under the bar.

So Phase I did its job — it cost a day and a benchmark, and it turned "should we spend weeks making concordance the default?" into "not until the phrase grouper can cover multi-word spans, and here's the test that proves when it can." Phases III–IV (concordance dual-role signal, flip) stay closed behind that.

_Harness: `scripts/eval/joint-vs-argmax.ts`. Numbers generated; per-locale JSON under the run's `--out-json`._
