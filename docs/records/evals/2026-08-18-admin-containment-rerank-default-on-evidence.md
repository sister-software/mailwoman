# Admin-containment re-rank — default-on evidence (#1717 stage 2)

**Date:** 2026-08-18 · **Decision:** promoted to default-ON, operator-approved · **Flag:** `adminContainmentRerank`

A parsed region qualifier now participates in locality-candidate selection by default: candidates the
ancestors sidecar vouches sit under the qualifier are surfaced (injected past a locale-INFERRED
country scope — never an explicit one) and ordered first. `--no-admin-containment-rerank` (geocode),
`--admin-containment-rerank-off` (eval gauntlet) and `admin_containment_rerank: false` (dev-mcp) opt
out.

## Why a reorder alone would have shipped inert

The deciding-site measurement (the #1729 method, applied before designing): `Weimar, Thüringen`
under the default en-US locale probes the locality table with a hard `country = US` filter, so
Weimar DE **is not in the candidate list** — no reorder of the returned rows can reach it. The
change therefore injects contained same-key candidates (additive, never a filter — recall only
widens) and partitions contained-first via one shared function at both deciding sites (backend
pre-window and the walk's post-importance re-rank). It stands down entirely under an explicit
caller country (#912 posture) and on artifacts without the ancestors sidecar (capability-conditional;
the pick's `metadata.admin_containment` reads `unavailable`).

## Evidence (ON vs OFF, one declared variable, house graders)

| leg              | result                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| board (558)      | 7 differed; **2 improved / 0 regressed / 556 neutral**; region-contradicted census 15 → 12                                                        |
| panel v2.1 (420) | 12 changed rows, **12 improvements, 0 regressions**; rooftop @25km **256 → 264**, @5km 247 → 255, @1km 218 → 223 (n=345); city-only @25km 57 → 60 |
| Weimar six       | qualifier-bearing three land at **0.87 / 1.72 / 1.94 km** (from 5,800–8,600 km); the three with no parsed region node unchanged, correctly        |
| gauntlet         | regression 353/354 both arms, byte-identical single pre-existing failure; metamorphic PASS both arms, identical 3 xfails                          |
| parity           | untouched — the change's first touchpoint is after the parse                                                                                      |

Nine en-AU rooftop panel rows return from the wrong continent (0.09–3.8 km); `Georgetown, Penang` →
George Town MY; `Moscow, Russia` → Москва; `Páirc Adhamhnain … Co. Donegal` → Letterkenny.

## The D-rule (iron rule 6)

**Zero US or FR rows changed in any leg.** Changed rows: AU ×11, GE ×2, IE ×2, MY, RU, GB ×2, DE ×1.
No tier-1 movement, no regression anywhere across 1,332 graded rows.

## What the promotion's own confirmation battery caught

The first default-flip draft forwarded the change through the session as
`!== false ? { true } : {}` — which forwards true and **drops an explicit false**, whereupon
geocode-core's own default-on resurrected it: the opt-out arm measured byte-identical to the
default (`0 of 558 differed`), the #1706 one-sided-forwarding class, third appearance. Fixed to
explicit both-direction forwarding before the promotion shipped; the re-run reproduces the ON-vs-OFF
battery exactly (7 differed / 2 improved / 0 regressed, same row set). The permanent guard for this
class is #1732's planned lockstep test (dev-mcp effective defaults pinned against a production
session's resolved options).

## Bounds

- The verdict layer keeps its fold-equality bound: `Weimar, Thüringen` now RESOLVES to Weimar DE
  (50.978, 11.318) while its `admin_coherence.region` still reads `contradicted` (`Thüringen` vs
  stored `Thuringia`) — the change bridges via the artifact's alias keys, the flag-only verdict does
  not. Right coordinate, stale verdict; exonym bridging for the verdicts is the named follow-up on
  #1717.
- 12 board contradictions remain, each with a stated non-change reason (4 fold/codex-bounded
  verdicts on correct coordinates, 4 IE townland keys absent from candidate.db, 3 parse mislabels —
  the #1722 ledger class, 1 pluscode junk).
- The change is inert on the FTS and browser backends and on pre-sidecar artifacts, by construction,
  and says so in the pick's metadata.
