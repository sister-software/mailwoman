---
title: "#378 — browser/WASM cold-path budget + SLO proposal"
description: A cold-path accounting for the browser geocoder (model + candidate.db + WASM), a proposed latency/size SLO, and the one bottleneck the numbers already name.
---

# #378 — browser/WASM cold-path budget + SLO proposal

We target the browser as a first-class runtime but have never written down a performance budget, so nothing
tells us which features are even shippable to a mid-range phone. This sets a proposed SLO and accounts for
the cold path from measured artifact sizes + a node-side compute floor. **What's measured vs estimated is
marked** — the in-browser P95 still wants a real device/headless trace (see _Open_).

## Two budgets, not one

The browser geocoder has two distinct latency surfaces, and conflating them hides the real costs:

1. **Cold load** — page open → first interactive parse. One-time; network-dominated.
2. **Per-keystroke** — parse + resolve on each input change. Steady-state; compute + query dominated.

### Proposed SLO

| Surface | Target (Moto-G-class phone, 4G) | Bound by |
| ------- | ------------------------------- | -------- |
| Cold load (P95) | **< 6 s** to first interactive | the 29 MB model fetch |
| Per-keystroke parse (P95) | **< 50 ms** | WASM inference |
| Per-keystroke resolve (P95) | **< 50 ms** | the candidate-table SQLite probe |

## Cold-path accounting

What the loader (`neural-web/loader.ts`) fetches and runs before the first parse:

| Component | Size / count | Source | Cost driver |
| --------- | ------------ | ------ | ----------- |
| int8 ONNX model | **~29 MB** (measured) | HTTP fetch from R2 | the dominant cold cost — ~23 s @ 10 Mbps, ~4.6 s @ 50 Mbps |
| onnxruntime-web WASM | a few MB (estimated) | HTTP + compile | one-time WASM compile |
| tokenizer + anchor + postcode bins | ~MB (estimated) | HTTP fetch | small |
| `candidate.db` warmup | **~12 cold byte-range fetches** (measured, candidate-table spike) | sql.js-httpvfs over a **1.3 GB** R2 DB | NOT a full download — header + B-tree nodes only |
| model session-init | **126 ms** (measured, node native EP) | local | WASM EP is ~3–5× → est. ~400–600 ms in-browser |
| first (cold) parse | **219 ms** (measured, node; includes one-time lazy decoder/gazetteer init) | local | amortized after the first parse |

Per-keystroke floor (node native EP, measured): **warm parse 5.7 ms**. The browser WASM EP runs ~3–5× slower,
so a ~15–30 ms in-browser parse is the realistic estimate — comfortably inside the 50 ms parse budget. The
resolve half (the candidate-table SQLite probe) is the half we have NOT measured in-browser and is the
suspected per-keystroke bottleneck (DeepSeek S45).

## The bottleneck the numbers already name

**Cold load is network-bound on the 29 MB model**, not compute. The session-init (126 ms node → ~0.5 s WASM)
and the ~12 candidate-table byte-range fetches are small beside a 29 MB sequential download. So the cold-load
SLO is won or lost on **model transfer size**, which points the levers at: a smaller model (distillation /
structured pruning past int8), HTTP streaming + compile-while-download, and CDN edge-caching — not at the
SQLite path.

**Per-keystroke is the opposite** — transfer is done, so it's WASM inference (estimated in-budget) + the
candidate SQLite probe (unmeasured, suspected bottleneck). This is exactly where the **#372 flatbush
pre-filter** would help — pruning candidates by bbox before the name search. Per the diagnostic-before-fix
discipline, #372 should be gated on the per-keystroke trace below, not built ahead of it.

## Open — the empirical trace

These numbers bound the cold path from sizes + a compute floor, but the in-browser **P95 on a real device**
(the SLO's actual gate) needs a browser trace: cold-load waterfall (model/wasm/db fetch overlap), and a
per-keystroke breakdown (WASM inference vs the SQLite probe). That trace was blocked this shift — **no Chrome
on the lab box** for the chrome-devtools profiler. Next step: run it against the live `/demo` from a machine
with Chrome (or a throttled headless run), confirm the model-fetch-dominates-cold hypothesis, and measure the
resolve-half per-keystroke cost that gates #372.
