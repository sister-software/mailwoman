# Session report — FST arcs + comma-free + #1143 retest (2026-07-25, executing lead: Kimi)

**For:** Claude (coordination) · **From:** Kimi · **Repo:** mailwoman @ `main` (`426379e4`)
**Predecessor docs:** `STALE_FST_HANDOFF.md`, `2026-07-25-LEAD-HANDOFF.md` (both executed this session).
**Ledger:** `.superpowers/sdd/progress.md` carries the full dated entries (pre-registrations #1–#6,
every battery, every verdict).

---

## 1. What shipped (3 PRs, all merged)

| PR        | What                                                                                                                                                                                                                                                                                                                                                                                                               | Shape                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **#1315** | Street-context gate (`neural/fst-prior.ts`) — scales the _positive_ FST locality/region bias ×0.25 when a matched place span is syntactically street-headed: street-type adjacency via the **morphology FST** (prefix+suffix locales — never the US-only codex list) or house-number-left (`/^\d{1,6}[a-z]?$/`). Syntactic only, never importance magnitude; byte-identical absent street context (unit-asserted). | Inert-by-default code             |
| **#1317** | Trailing-locality prior (`neural/trailing-locality-prior.ts`) — the comma-free "street + trailing city" mechanism. Geometry-gated (R1/R1b longest-admin-match, R2 particle transparency, R3 locality-present-silent, R4 comma-separated-silent).                                                                                                                                                                   | **Per-call opt-in ONLY** — see §3 |
| **#1318** | FST distribution — per-locale `fst-<locale>.bin` ships in the en-us/fr-fr/en-gb weights packages; `resolveWeights` exposes `fstPath`; the runtime pipeline lazy-auto-loads + wires the gate (morph emission prior **always zeroed** at pipeline call sites). `fst: false` escapes; explicit FST wins; en-nz byte-stable.                                                                                           | **Default-on** (ratified)         |

Also: the 768k importance FST was **rebuilt and measured** (provenance byte-equivalent to the 07-18
build: 768,643 importance matches) — and the reship was **rejected by the fragment board**. It stays
staged at `/mnt/playpen/mailwoman-data/scratch-importance/`, unshipped; the 220k FST remains the
shipped gazetteer.

## 2. The measurements that drove each decision

**768k reship (STALE_FST Steps 2–4).** The handoff's core trap held: golden can only veto, the
fragment board decides. 7-config matrix (~44k parses). The rebuilt FST **fails under every shippable
config**: vs the designed config (homonym −13); vs the only veto-surviving config (gate-only:
homonym **−28**, plus a hazard regression — "Avenue Montaigne" → `locality:"Avenue"`; the 768k
population-fallback importance gives weight to a commune literally named Avenue). Its golden gains
(US +41, FR +22) are exactly the channel that can't green-light. **Keep 220k.**

**Comma-free fix (LEAD-HANDOFF §1, fork A→B).** Operator picked "measure A first." Fork A (activate
the broad FST prior) **failed 3/7 pre-registered bars** — it's _geometrically opposed_ to the gate: a
trailing city sits exactly where the gate suppresses ("Pennsylvania Ave Washington" ≡ "Washington
Blvd" syntactically). Fork B (geometry-first trailing-locality) went through three pre-registered
iterations: v1 failed bars 1/2/5 with precise anatomy; R1–R3 guards fixed collateral but V3 broke
golden (1.15%); R1b+R4 (importance-aware presence + comma-separated-silent) cleared **all 7 bars**
(fused 9/33 → 30/33, golden US+FR **zero** regressions).

**#1143 retest (LEAD-HANDOFF §2).** Re-anchored: **0.605 v385 / 0.777 v3101** — training is closing
it (the roadmap's 0.215 was stale; §3-F corrected). Residual anatomy (89 misses): 51 whole-span
(training-only), 37 token-grabs (the gate's class — now live via #1318), 1 dropped. **Suffix prior
not built** — training already ate its target class.

**FST default-on battery (#1318, all on shipped v385).** Golden **US +56 / FR +20** (≤0.27% genuine
regressions, 0 on FR) vs **−6.8pp FR admin-street-homonym**. The operator **ratified a dated bar
revision** to ship default-on: the same config is homonym-+13 on the v3101 candidate, so the next
model promotion is expected to retire the revision. **The battery re-runs at that promotion** —
that's a standing obligation.

## 3. Lessons (the durable part)

1. **The open-vocab wall is two-sided.** Street-name surnames collide with gazetteer localities in
   _both_ directions. The trailing-locality prior cleared all 7 bars on the 33-row big-city board,
   then the #1143 retest (400-row BAN population) showed the same config **net-negative**
   (−50/400 bare-street, −60/400 street-housenumber): "Avenue Marceau Julien" ≡ "Rue des Lyonnais
   Paris" syntactically — no decode geometry separates a trailing city from a person-name street
   surname. That's why #1317 ships **opt-in only** (the wiring was stripped post-measurement, PR
   body amended — the measurement record is in the ledger).
2. **Hand-built boards are biased by construction.** My 33-row comma-free board (Paris/Lyon/London/
   NYC) structurally could not see the person-name-street collision class. Held-out generality or
   don't build — the BAN population caught what the curated board couldn't. (Same lesson as the
   768k's golden-vs-fragment asymmetry, one level down.)
3. **The morphology _emission_ prior owns a US golden −48.** The gate and the emission prior share
   a matcher but not a fate: gate-only is golden-flat and fragment-positive; the emission prior is
   veto-failing broadly. The pipeline zeroes it at every call site; it stays reachable via direct
   `classifier.parse` for measured opt-in use. Don't enable it by default anywhere.
4. **v3101-cache ≠ shipped v385.** Several early boards ran on the candidate cache (bare-street
   0.777 vs 0.605 shipped). Every ship/no-ship claim was re-verified on shipped bytes (live CLI +
   gauntlet), and the default-on battery was run v385-only from the start. Board percentages from a
   candidate cache are candidate numbers — the §0.4 discipline is load-bearing.
5. **Pre-registration pays for itself twice.** Every sweep cell, bar, and fallback route was written
   before measuring — so when fork A failed, when W1 first failed, and when the default-on battery
   failed one bar, the next action was already decided (pivot / iterate / opt-in-fallback). The one
   bar revision that shipped was dated, operator-ratified, and carries its own retirement condition.
6. **Presence vs importance is a measured question, not a principle.** Fork B used gazetteer
   _presence_ to reach importance-zero places — but the marquee case (Sainte-Livrade-sur-Lot) never
   actually recovered (FST coverage/tokenization), while presence is exactly what let surname
   collisions fire. Presence bought ~nothing measured; R1b's importance-aware check is what made the
   mechanism safe.

## 4. Open items / handoffs

- **Next model promotion:** re-run the #1318 default-on battery (expect the homonym bar revision to
  retire — v3101 evidence). Also re-verify the trailing-locality W1 cell if the model changes.
- **HF staging of `fst-<locale>.bin`** at the next release — release-sequenced (`mailwoman-release`
  skill path), deliberately not in #1318.
- **#1143 disposition:** my recommendation stands — waive-with-owner+board (owner: the #1102
  training campaign, verifiably closing the gap; board: ban-fragments-fr bare-street class re-scored
  per candidate). The 37-row token-grab class is the gate's, now live in production via #1318.
- **#1102 context** (recovered for the operator): the v25x promote blocker — fragment/twin training
  mass eroded US region+locality recall ~2.5pp (class-balance side effect). Same campaign that's
  closing #1143; the two are coupled through class balance.
- **v8 cut items still parked on the operator:** breaking-batch green-light (Track A), Track B
  overlay re-cut, demo repoint (strictly post-cut).
- **Branch hygiene note:** #1316 was auto-closed when its stacked base branch was deleted on #1315's
  squash-merge — replaced by #1317 (identical, rebased). Worth knowing for future stacked PRs:
  `--delete-branch` on the base closes the stack.

## 5. State integrity

- Operator WIP preserved throughout (`corpus-python/modal/train_remote.py` `sync_latam_br` verified
  present after every stash/pop cycle; never committed).
- Gauntlet PASS at every ship point. Parity floors red but **numerically identical to main**
  (pre-existing campaign-target drift, proven by stash-recompile-compare — not from this work).
- All measurement harnesses + logs in `scratchpad/measure-*.mjs` (gitignored, reproducible).
