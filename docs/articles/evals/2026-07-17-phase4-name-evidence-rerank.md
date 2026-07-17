# 2026-07-17 — Phase 4: the rerank zero, the redesign, and +18.5pp on bare-street (zero training)

Night-4 of the #727 stage-2 arc (plan #1134), the phase the plan called "the whole ballgame": how
much of the measured k-best headroom (oracle@5 0.723 vs seg@1 0.577 on parity) can evidence-based
reranking actually collect? Two measurements, one redesign, one decisive result — all zero-GPU.

## 1. The phase-4a zero: full-geocode tier evidence is the wrong instrument

The repaired phase-4a harness (`scratchpad/rerank-valid.mjs`, the full situs+BAN+OSM cascade after
the earlier admin-only dark-resolver bug) ran the 267 live parity fixtures through k=5 segmentations
on the v301 span-head artifact, geocoding EVERY hypothesis and preferring the finest resolution tier:

```
seg@1: 0.5768      rerank@1: 0.5768  (delta +0)     oracle@5: 0.7228
fired on 1/267: fixed 0, broke 0
evidence rate: 9/267 (3.4%) — tier census: 1308 admin / 25 address_point / 2 street
```

**The rerank collected NOTHING — because it is evidence-starved, not wrong.** The failing class is
context-free fragments, and a fragment cannot reach the rooftop layers (no locality/postcode to shard
on), so every hypothesis ties at admin tier and the arbiter has nothing to prefer. Full-geocode tier
is structurally blind exactly where the headroom lives.

## 2. The redesign, converged on twice in one night

P1's measured-negative design doc (PR #1152) independently specified the same fix hours earlier:
the arbiter needs **street-NAME existence evidence** — "does this hypothesis's street surface exist
as a street name" — which is queryable even for fragments. The BAN street-centroids DB
(`street-centroids-fr.db`, 2.2M `street_norm × locality` rows) is that index for FR, already built
and provenance-tracked.

## 3. The phase-4b result: name evidence collects the headroom

Falsifier at board scale (`/tmp/span-worktree/name-evidence-board.mjs`; the FR fragment board's four
street classes, n=1600, v301 k=5, rerank policy = first hypothesis by parse rank whose street surface
exists in BAN; positive evidence only, no scores blended):

| class              | n    | seg@1 | name-rerank@1 | delta       |
| ------------------ | ---- | ----- | ------------- | ----------- |
| bare-street        | 400  | 0.675 | **0.860**     | **+18.5pp** |
| date-name          | 400  | 0.100 | 0.182         | +8.2pp      |
| street-particle    | 400  | 0.802 | 0.860         | +5.8pp      |
| street-housenumber | 400  | 0.897 | 0.922         | +2.5pp      |
| **overall**        | 1600 | 0.619 | **0.706**     | **+8.7pp**  |

Of 202 recoverable fixtures (wrong at rank 1, right in the top 5): **fixed 140, broke 14, neutral
48** — a 10:1 fix/break ratio. The +18.5pp lands on **bare-street — the 66% recall class** that every
corpus lever plateaued on (the ~0.77 ceiling) and that option C was designed to attack. The arbiter
collects it without a single training step.

## Caveats, stated

- Measured on the **v301 span-head artifact** (the archived `feat/727-span-head` branch's k-best
  surface) — the only model with exported span scores. The JS decoder is NOT on main; this result is
  the consumer that justifies merging it.
- **FR only** — the one locale with a complete street-name index on hand. Generalizing needs
  per-country name sources (US TIGER/situs, NO Kartverket, PT/RO BAN-equivalents) behind one
  `StreetLocalityEvidence` interface (P1's spec).
- The index is BAN and the board fixtures are BAN-derived — not circular (the index is a lookup,
  not the model; production carries the same index and the eval surfaces are real streets), but the
  coverage is by construction ideal. Foreign-locale generalization will be lower.
- The 14 breaks are real street names outranking gold; a locality-scoped lookup (street × locality)
  should cut them further. Unscoped membership was the v0 policy.

## Addendum — falsifier v2: the break audit + two guards (same night, 06:20)

The 14 breaks decompose into exactly two classes: **truncation wins** (10/14 — the picked street is
a sub-span of gold that is itself in the index, usually the bare type word `rue`/`chemin`) and
**moved off a correct rank-1** (4/14 — gold at rank 1 but missing from the index on a
hyphen/apostrophe fold, with the in-index pick 2–5 score units down). Two guards, pre-registered
(breaks ≤6, fixes ≥135): G1 = no evidence credit for pure street-type vocabulary; G2 = evidence may
not promote a hypothesis more than 2.5 score units below rank 1. Result:

| policy              | fixes   | breaks | street@1  | bare-street |
| ------------------- | ------- | ------ | --------- | ----------- |
| v1 (bare existence) | 140     | 14     | 0.706     | 0.860       |
| **v2 (+G1 +G2)**    | **148** | **3**  | **0.711** | **0.875**   |

Both bars cleared; G1 also lets evidence land on gold more often (fixes UP). One residual: G2 dips
street-housenumber 0.922 → 0.912 (blocks a few legitimate deep picks). The implementation spec with
the interface + productionization plan is
`docs/superpowers/specs/2026-07-17-727-phase4c-street-name-evidence.md`.

## What this decides

- **Phase 4c is justified and specified:** merge the archived span-decode surface (it now has a
  consumer), define `StreetLocalityEvidence`, build per-country name indexes, wire the rerank behind
  a flag, isotonic ambiguity gate on top-1/margin per the plan. The bare-fragment class no longer
  needs option C as the primary lever — the arbiter beat the projected channel gains without
  touching the model.
- The plan's discipline held: parse scores stayed in one probability space; the rerank signal is
  measured atlas evidence only; rank-2-beats-rank-1 cases (140 of them) are loggable training data.
