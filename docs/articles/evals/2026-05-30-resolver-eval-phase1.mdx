# Direction C — Phase 1 end-to-end resolver eval (2026-05-30)

The first **"address string → correct WOF place"** benchmark, and the kill/continue
gate for the per-input routing thesis. Headline: the win was **fixing the resolver**,
not routing parsers.

## Setup

- **Ground truth:** `scripts/eval/gen-wof-bootstrap.py` samples real US WOF localities
  (2,406 rows, 401 localities × 51 regions × canonical/lowercase/nocomma), rendered to
  address strings, labelled with the source WOF id + centroid (hierarchy-tolerant:
  locality or its region accepted). Sampled from the **custom** gazetteer (never the
  off-the-shelf dumps — different ids).
- **Runner:** `scripts/eval/resolver-eval.ts` parses each input two ways — neural
  (v0.7.2) and v0-via-adapter (`scripts/eval/v0-tree-adapter.ts`, flat record → tree) —
  resolves both once through the shared WOF resolver, and derives all baselines from the
  two resolutions (neural-only / v0-via-adapter / arbiter=pick-higher-resolver-score /
  oracle=correct-if-either). Metrics: hierarchy-tolerant Acc@1 + great-circle error.

## The resolver was broken on realistic US addresses — and we fixed it

The first run exposed two resolver gaps the deleted off-the-shelf DB had masked:

1. **No top-level country constraint** — `ResolveOpts` only propagated country _down_
   from a resolved parent, so a bare "IL" over the 7-country gazetteer fuzzy-matched a
   **French** region (`@48.15,−1.64`), poisoning the whole walk.
2. **US state abbreviations didn't resolve** — WOF regions carry "Illinois", not "IL";
   `findPlace('IL')` returned nothing, killing the parent-constraint the walk depends on.

Fixes (both production keepers):

- **`ResolveOpts.defaultCountry`** — a top-level country hint (set from the locale-gate).
- **Region-abbreviation enrichment** — `scripts/add-region-abbrevs.ts` adds each region's
  abbreviation as a searchable name, sourced from the in-repo chromium-i18n /
  libaddressinput dataset (`sub_keys`↔`sub_names`), 51 abbrevs across 7 countries.
  (TIGER's `corpus/src/codex/us-fips-state.ts` is the US-specific alternative.)
- Plus `resolver_score` stamped on resolved nodes (for the arbiter + downstream).

| metric          | before fixes |      after |
| --------------- | -----------: | ---------: |
| Acc@1 (all)     |         ~10% |  **68.9%** |
| coord error p50 |       843 km | **0.0 km** |
| coord error p90 |     7,640 km |   1,090 km |

## Kill/continue gate (full 2,406-row run)

| baseline       | clean | perturbed |       all |
| -------------- | ----: | --------: | --------: |
| neural-only    | 77.1% |     64.8% |     68.9% |
| v0-via-adapter | 69.5% |     60.8% |     63.7% |
| **arbiter**    | 76.9% | **69.5%** | **72.0%** |
| oracle         | 79.4% |     77.1% |     77.9% |

- **Arbiter beats neural-only by +3.1pp overall and +4.7pp on noisy input.** Gate: all
  +3.1 (≥3 ✓), perturbed +4.7 (≥−2 ✓), clean −0.1 (≥5 ✗).
- The strict clean-5pp criterion **fails on an inverted premise**: it assumed _v0 wins
  clean_ (so the arbiter would pick v0's clean wins). End-to-end, **neural wins clean**
  (77% vs v0's 70%) — the opposite of the _parse-level_ capability map (libpostal). The
  routing gains correctly land on noisy + overall, where the robustness story lives.
- Oracle shows ~6pp of headroom above the arbiter — a better router (lexical quality
  signal, not just resolver score) could capture more.

## Conclusions

1. **The resolver was the bottleneck, not parser routing.** Fixing country + abbreviation
   coverage took the stack from broken (~10%) to 68.9% Acc@1 / 0 km median. Ship
   **neural→resolver** as the geocoding stack.
2. **Routing is a real but modest lift** (+3.1pp overall, +4.7pp noisy). Worth building as
   the **banded** version (cheap lexical router → arbiter only on the noisy/ambiguous band),
   so the dual-parse cost is spent only where it pays and clean inputs stay on neural.
3. **The biggest remaining lever is resolver coverage**, not the parser: more aliases/
   abbreviations, street-level resolution (TIGER — WOF has no street node), more locales.
   The p90 of 1,090 km is the cross-state ambiguity tail when a region fails to constrain.

Caveats: synthetic WOF-rendered addresses (the OpenAddresses track —
`data/eval/external/openaddresses-us-sample.jsonl`, 10k real US points — is the
independent coordinate-error check, to run next); admin-level only (no street/house).
