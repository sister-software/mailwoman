---
sidebar_position: 8
title: What the eval numbers mean
---

# What the eval numbers mean

Mailwoman evaluates itself by running against a set of 4,535 hand-labelled addresses (the "golden set") and measuring how well each pipeline mode does. This article explains the four modes, the metrics, and what the v0.5.0 results actually tell us — in plain terms.

## The four modes

Mailwoman can parse addresses in four different ways. Each one uses a different combination of tools:

| Mode | What it uses | Analogy |
|---|---|---|
| **Rule-only** | Hand-written rules, pattern matching, dictionaries | A postmaster who memorises the rulebook |
| **Neural** | The AI model's best guess, decoded with structural constraints | A student who writes their first instinct, checked for grammar |
| **Hybrid** | Rules + AI model working together | The postmaster and the student collaborating |
| **Hybrid-joint** | Rules + AI + a "sanity checker" that rejects incoherent guesses | The collaboration, plus an editor who crosses out answers that contradict each other |

These are simplifications of the same [staged pipeline](./the-staged-pipeline.md) — each "mode" is a different composition of the same underlying stages, not four separate parsers.

## The metrics

**Exact match** — did the parser get *every single component* of the address right? House number, street, city, region, postcode — all must match the human-labelled answer exactly. This is harsh. Getting 4 out of 5 components right scores zero.

**Macro F1** — a softer measure that balances two questions per component type: did you find it when it was there? (recall) and did you make it up when it wasn't? (precision). The score averages the balance across all component types. A parser that's great at postcodes but bad at venues gets partial credit.

**Empty-parse rate** — how often does the parser give up entirely and return nothing? Lower is better. A parser that always guesses something (even if wrong) scores 0% here.

**Overconfident-wrong rate** — how often does the parser say "I'm very sure" (confidence above 90%) but get the parse wrong? This is the most dangerous failure mode for downstream consumers: a geocoder that's confidently wrong will silently return the wrong coordinates with no signal that something went amiss.

## The v0.5.0 results

| Mode | Exact Match | Macro F1 | Empty Parse | Overconf Wrong |
|---|---|---|---|---|
| Rule-only | **30.8%** | 22.0% | 6.3% | 2.4% |
| Neural | 0.1% | 7.3% | 0.3% | **54.5%** |
| Hybrid | 0.1% | 7.3% | 0.3% | 54.5% |
| Hybrid-joint | 6.0% | 16.6% | **0.0%** | **0.1%** |

## What this tells us

### Rule-only is still the most accurate on addresses it covers

30.8% exact match means: for roughly 1 in 3 addresses in the golden set, the rule parser gets every component perfectly right. This sounds low, but exact match is a strict measure — and the rule parser only knows the patterns it was hand-taught. It has zero coverage on addresses outside its training (different countries, unusual formats).

The rule parser's weakness: 6.3% empty-parse rate (gives up on some inputs entirely) and only 22% macro F1 (meaning it's good at some component types but bad at others — venue detection is particularly weak at 24% F1).

### The neural model learned to spell words but not write sentences

The v0.5.0 neural model achieved val_macro_f1=0.605 during training — which sounds good. But on the eval matrix it scores 0.1% exact match and 54.5% overconfident-wrong. What happened?

Training eval asks "did the model label each word correctly?" — a local question. The golden eval asks "did the parser produce a correct address?" — a global question. These are different. The model can score 0.605 on the first and 0.001 on the second because correct per-token labeling doesn't guarantee correct parses — one wrong token cascades into a structurally invalid address.

The concrete smoking gun: the model invented a `dependent_locality` (a sub-city neighborhood) **956 times** where none existed in the golden labels. It wasn't just overconfident — it was actively hallucinating a component it hadn't learned to distinguish. Cross-entropy treats every mislabeling equally, so the model never learned that `dependent_locality` is rare and should be emitted sparingly.

In hybrid mode, the neural model's overconfidence drowns out the rules entirely — when the neural decoder says "this token is a dependent_locality" at 95% confidence and the rule parser disagrees, the neural vote wins. This is why hybrid and neural show identical numbers: the rules never get a say.

### The reconciler fixes the honesty problem

Hybrid-joint mode (the reconciler) drops overconfident-wrong from 54.5% to 0.1%. How? By checking whether the parsed components form a consistent real-world hierarchy. "Is there actually a city called Houston in a state called NY?" If not, the parse is rejected or rewritten.

The reconciler also eliminates empty parses entirely (0.0%) — it always produces *something*, even if conservative.

The trade-off: exact match drops from 30.8% (rule-only) to 6.0% (hybrid-joint). The reconciler is more honest but less precise on well-formed addresses. This is a calibration-vs-accuracy trade-off that the next iteration will address by re-adding class weights to the training recipe.

### The architecture is working, the quality isn't there yet

The staged pipeline — rules for structure, neural for ambiguity, reconciler for honesty — is producing the behaviour it was designed for. Each layer adds value:
- Rules contribute high precision on common patterns.
- Neural contributes coverage on unusual inputs (0% empty parse vs rules' 6.3%).
- Reconciler contributes honesty (0.1% overconfident-wrong vs 54.5%).

The quality gap is in the neural classifier's per-component accuracy. This is addressable without architectural changes: class-weighted cross-entropy (pulling the model's attention back to underperforming tags) and longer training are both now safe to try because the dual-loss instability that blocked them is gone.

## See also

- [The staged pipeline](./the-staged-pipeline.md) — how the four modes compose
- [The knowledge ladder](./the-knowledge-ladder.md) — why each layer exists
- [Dual-loss curvature conflict](../../concepts/dual-loss-curvature-conflict.md) — why the training was unstable before and what fixed it
- [v0.5.0 — as shipped](../../plan/v0-5-0-shipped.md) — what the six threads delivered
