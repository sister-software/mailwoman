# Night Shift 7 — 2026-06-06 (order robustness: ship the v0.9.2 both-order retrain)

_Draft, written as the shift runs. Numbers self-emitted; the v0.9.2 result lands at the gate (~05:00 UTC)._

## What shipped

- **#323 — both-order German corpus** (merged). `synthesizeLocaleRow({ order })` renders German in native
  AND international layout; `build-german-shard.mjs --intl-fraction`; a reproducible native-order eval
  asset. The fix the whole shift is built on.
- **#324 — `parse --default-country`** (merged). The CLI resolved globally, so a bare `NY` hit a Scottish
  homonym (`IL`→France, `WA`→Spain); now inferred from `--locale` (the demo already passed `country:"US"`).
  10/10 tests, the NY→NYC integration guard included.
- **#325 — order-robustness eval & diag tooling** (merged). `scripts/eval/de-order-eval.sh` (the 2×2
  native/intl × anchor on/off + US/FR gate harness), `--model-anchor-lookup` on `per-locale-f1.ts`
  (anchor-aware per-tag F1), and the three diag scripts the finding/memories reference.
- **v0.9.2 both-order retrain** — trained clean (20k, no NaN), evaluated, **not shipped** (research result,
  not a production regression). Full report: `2026-06-06-v0.9.2-eval.md`. Headline: both-order training moved
  the model's _intrinsic_ international parsing (anchor-off intl 35.9 → 48.4, **+12.5pp**) but the
  production-anchor config is flat (intl 45.5 → 44.5) — the postcode anchor, injected at the _trailing_
  postcode, fights the word order on international layout. Native held (82.1, beats Pelias), US/FR held
  (97.5 / 84.9), locality F1 0.82 (no collapse). The residual gap traces to the synth dropping the region
  tail the eval feeds — the v0.9.3 fix.
- **#326 — v0.9.2 eval report** (merged). The 2×2 + the anchor-vs-word-order finding + the region-tail
  mechanism. Issue **#327** filed for the v0.9.3 direction.
- **DeepSeek consult (2 turns)** — pressure-tested the anchor-vs-word-order mechanism and signed off
  region-tail as the v0.9.3 single variable. A posterior-ablation diagnostic it suggested (force DE=1.0)
  left v0.9.2 intl at 44.5% → the anchor harm is **structural-positional, not posterior**. Designed v0.9.4
  (dual-injection anchor: inject at the postcode AND the first token) as the fallback if v0.9.3 leaves a gap.
- **#328 — v0.9.3 region-tail** (merged, trained, evaluated, **not shipped**). International German renders
  `City, Region Postcode` now. **Clean negative:** ≈ v0.9.2 on every locality metric (native off/on 48.3/83.6
  beats Pelias, intl off/on 47.1/44.7, US 97.2 / FR 84.9 held). The region tail did exactly its job —
  international region-match 0% → ~40%, Berlin intl-loc 34.4→38.7 — but locality stayed flat. The anchor-on
  intl gap (38.9pp) is the anchor's **positional** harm, not the corpus (the posterior diagnostic already
  ruled out feature content). **The corpus lever is exhausted for the anchor-on intl gap.** → v0.9.4
  (dual-injection anchor), staged for the operator (3 iterations deep, none promoted; a change to the anchor
  mechanism, not data).

## What went well

- **Measure-first paid off twice.** The whole shift exists because we re-measured German in its native
  order and found the "collapse" was largely an eval artifact. Tonight's S1 probe (below) did the same to
  the anchor's role.
- **The corpus pipeline mirrored v0.4.1-de exactly** — overlay manifest, base shards by reference, no
  rebuild of 677M rows. Clean, fast, verified on the volume before launch.

## What could've gone better

- **A branch-base trap:** the committed native-order asset read 0.0% because that branch predated #322
  (the anchor inference code); `parseAnchorLookup` wasn't compiled in. Cost ~15 min of confusion before I
  traced it to the branch base. Lesson logged: an anchor eval needs #322 on the branch.
- **The generalized builder (S3) hit real walls** I should have anticipated: FR's OA CSV is 2.5 GB (over
  the 1 GB buffer → needs streaming + reservoir sampling), NL's template reformats the postcode. DE-parity
  is proven; the rest is held, honestly documented, not half-shipped.

## Decisions made autonomously

- **Did NOT bump the critical dependabot alert (vitest, dev-scoped).** The exploit needs the Vitest UI
  server listening (never run); bumping the test runner mid-shift risked destabilizing the CI gate I depend
  on. Logged for the operator instead. _(Alternative: bump it — rejected as higher-risk-than-reward.)_
- **Held `build-locale-shard.mjs`** rather than ship a generalizer that doesn't yet beat the German builder.
- **Reused the pilot model card** (33 labels, identical schema) for the v0.9.2 eval rather than block on a
  fresh card export.

## Surprises (captured fresh)

- **S1 — the anchor is load-bearing in BOTH orders, not a US-order band-aid.** v0.9.1 anchor-on model, DE
  locality, 2×2: US/off 35.9 · US/on 45.8 · native/off 48.4 · **native/on 83.8**. The anchor adds +35.4pp
  on native order (vs +9.9 on US). Revises the #321 guess that the anchor merely rescued a US-order symptom.
  Caveat: `c=0` deprives an anchor-_trained_ model of a learned signal; the clean test is whether v0.9.2
  reaches native perf WITHOUT the anchor (the gate's 2×2).
- **S2 — the order artifact is systemic but the anchor is the bigger lever.** Re-measured the PR3
  v0.9.0-selfcond model (no anchor): US-order 35.5 → native **48.2** (+12.7pp, Sachsen-driven 36.8→62.2;
  Berlin flat 34.2 both). So the earlier "collapses" were partly the eval order — but the no-anchor native
  ceiling is only ~48% (= v0.9.1 anchor-off). Two separable levers: order-training lifts the anchor-OFF
  intl ceiling; the anchor unlocks native 48→83 (and Berlin needs it). Resolved the "not yet re-measured"
  caveat in memory.
- **S-diagnostic — the anchor's intl harm is structural, not posterior.** Forcing the German postcode
  posterior to DE=1.0 on v0.9.2's intl eval left it at 44.5% (= uniform). The additive anchor at the
  trailing postcode is the harm, independent of its feature content. → v0.9.4 dual-injection design.

## Open questions for the operator

- **THE fork (#327) — now data-decided, the strategic choice is yours.** Three retrains — both-order corpus
  (v0.9.2), region tail (v0.9.3), **and the architectural fix, dual-injection (v0.9.4)** — ALL left the
  anchor-on international number immovable at ~44% (gap to native ~40pp). The anchor's native-help (+35) /
  international-hurt (−4) asymmetry is **fundamental** — not corpus, not region, not injection position. The
  experiments have mapped the ground; what's left is strategic: **(a)** order-conditioned anchor, **(b)**
  accept the asymmetry (native German is excellent — 83.5%, beats Pelias, 96.3% PIP-containment — and that's
  what production ships), or **(c)** drop the always-on anchor. Cross-cutting: it gates the multi-locale
  retrain program (the anchor-intl issue recurs per locale). None of v0.9.2/3/4 promote; v0.6.0 stays
  production. I stopped rather than auto-launch a 5th experiment.
- **FR (#330):** the FR gap is venue (0%) + region (19%) — convention gaps, not basics. Worth a targeted FR
  venue+region corpus supplement on the next multi-locale push?
- The 19 high + 1 critical dependabot alerts (vitest dev-scope) — bump in a dedicated `chore(deps)` pass?

## Concrete next steps

- **Decide the #327 fork** → if dual-injection: implement the position-0 anchor in `encode_row` +
  `anchor-inference.ts` (config-flagged), retrain, gate via `de-order-eval.sh`.
- **FR (#330):** assemble a venue+region FR shard (real OSM/WOF POIs + FR région forms), measure with
  `per-locale-f1.ts`.
- **Multi-locale tooling:** finish `build-locale-shard.mjs` (streaming + reservoir for FR/US-scale CSVs;
  per-source region; NL postcode normalization) — the gating piece for ES/IT/NL/FR shards (#241).

## Numbers

| metric | value |
| --- | --- |
| Shift window | 04:16 UTC → 14:00 UTC |
| PRs merged | 11 — #323-326, #328, #329, #331-335 |
| Issues filed / groomed | #327 (anchor fork), #330 (FR gap) / #239, #241 |
| Models trained | 3 (v0.9.2 both-order, v0.9.3 region-tail, v0.9.4 dual-injection — all 20k, all negative) |
| Modal spend | ~$12 of $15 _(3 runs)_ |
| DeepSeek consults | 1 (2 turns, + the posterior-ablation diagnostic it prescribed) |
| NaN incidents | 0 |
| CI failures | 0 |
| Demo regressions | 0 (v0.9.x research line; v0.6.0 production untouched) |
