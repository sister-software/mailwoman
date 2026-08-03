---
title: "#727 Phase 4a — rerank built; the measurement was INVALID and is not a verdict"
---

# Phase 4a — the reranker exists, its first measurement was confounded, and I nearly shipped the false negative

**Status: code landed + unit-tested. The eval is VOID. No conclusion about resolution reranking is
supported by anything in this document.**

## What I nearly published

Two resolution-evidence signals, measured on the triaged parity corpus against the span decode's
top-5:

| signal                                      | fired  | fixed | broke | seg@1 → rerank@1          |
| ------------------------------------------- | ------ | ----- | ----- | ------------------------- |
| plausibility guard (veto country-centroids) | 3/267  | 0     | 0     | 0.5768 → 0.5768 (**+0**)  |
| resolution specificity (prefer finer tier)  | 44/267 | 2     | 18    | 0.5768 → **0.5169** (−16) |

The obvious write-up: _"resolution evidence cannot collect the oracle headroom; one signal is inert,
the other is actively harmful."_ That would have been a tidy, plausible, **wrong** negative — and it
would have undercut the entire Phase-4 thesis on a bad instrument.

## What the check found

Before writing it, the census — _can this resolver even see a street?_

```
finest-resolved tier across the 267 parity fixtures (admin + postcode DBs only):
  UNRESOLVED  128
  locality    118
  region       16
  country       5
  street        0     ← never. not once. no postcode tier, no house_number tier either.
```

**The harness resolver had no street-level data.** I constructed it as
`WOFSqlitePlaceLookup({ databasePath: [admin-global-priority.db, postcode-locality-intl.db] })` — no
situs, no interpolation, no BAN/OSM rooftop. It cannot distinguish a correct street parse from a
wrong one because **it never resolves streets at all**.

Both results are explained by the confound, not by the thesis:

- **The guard was inert** because country-centroid garbage is rare on this corpus — the fixtures land
  on a _locality_ centroid whether the street parse is right or wrong. Identical evidence for both.
- **Specificity actively hurt** because "finer" among `{country, region, locality}` rewards the
  hypothesis that produces a **locality** reading. For a bare street fragment, that is precisely the
  wrong parse (`Rue Montmartre` → locality). It fired 44 times and broke 18 by _rewarding the failure
  mode the arc exists to fix_.

The shards exist locally and I simply did not wire them: `/mnt/playpen/mailwoman-data/interpolation/`
(per-state US), `/ban/` (FR rooftop), `/osm/`. A valid test runs the **geocode cascade**
(`geocodeAddress` / `parseForGeocode` + a `ShardResolver`), not the bare WOF admin resolver.

## What IS supported

- `resolver/rerank.ts` — `rerankByResolution`, deliberately minimal: **veto implausible resolutions,
  otherwise keep the model's ranking**. No score blend, no per-class weights. The reason for that
  austerity is in the file: the moment it grows a hand-tuned ladder we have rebuilt Pelias's dictionary
  overrides with extra steps (94 of 276 lines, each resolving a collision by hand).
- **7 unit tests**, including the three that encode the judgement calls: rank-2 promotes over a
  country-centroid rank-1 (the arc's whole claim); **all-implausible falls back to rank-1** (evidence
  that everything is bad is not grounds to invent a different answer); **a resolver exception does not
  veto** (an outage is not evidence).
- `maxResolve` defaults to 5, not 10 — oracle@5 (0.723) captures nearly all of oracle@10's (0.775)
  ceiling for half the resolver round-trips.

## What Phase 4a still owes

1. **Re-run on the geocode cascade with street-level shards.** Until then there is no evidence either
   way about resolution reranking. The headroom (seg@1 0.577 → oracle@5 0.723) is measured and real;
   whether _this_ signal collects it is untested.
2. Expect the answer to be **locale-split**: the US has situs/TIGER street coverage, so the resolver
   can adjudicate there; CZ/FR/PT bare fragments resolve to a locality centroid regardless, so the
   evidence may genuinely not exist for them. A rerank that helps US and is inert intl would be a
   perfectly good result — but it has to be measured, per-locale, not assumed.
3. Only then: the isotonic ambiguity gate (4b) and option C (4c).

## The lesson, which is the same one twice in two days

The v3.0.0 probe looked like a falsified architecture and was a mis-specified LR. This looked like a
falsified rerank and was an unwired resolver. **Both times the tell was a number that could not
reproduce something already known** — there, `token@1` 0.348 against a known 0.573; here, a resolver
that never once produced the tier the whole experiment depends on.

Check the instrument before the hypothesis. The aggregate is not the verdict; the evidence is.
