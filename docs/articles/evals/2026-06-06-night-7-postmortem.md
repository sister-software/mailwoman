# Night Shift 7 — 2026-06-06 (order-robustness arc, concluded — plus a demo-refinement tier)

_Final. Numbers self-emitted. The shift opened on a single question — does both-order training close the German
international-order gap? — and closed it across three retrains; the back half turned to the demo-refinement
tier the operator asked for once DeepSeek (delegated authority) called "no more GPU."_

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
- **DeepSeek consult (3 turns, delegated authority)** — turn 1–2 pressure-tested the anchor-vs-word-order
  mechanism, signed off region-tail as the v0.9.3 single variable, and prescribed a posterior-ablation
  diagnostic (force DE=1.0) that left v0.9.2 intl at 44.5% → the anchor harm is **structural-positional, not
  posterior**; it designed v0.9.4 (dual-injection) as the fallback. Turn 3, after v0.9.4 also failed, **made
  the strategic call** (the operator was away and had delegated authority for the shift): accept the asymmetry,
  no more GPU, and the multi-locale plan survives via a country-conditioned anchor. See #337.
- **#328 / #329 — v0.9.3 region-tail** (merged, trained, evaluated, **not shipped**). International German
  renders `City, Region Postcode` now. **Clean negative:** ≈ v0.9.2 on every locality metric (native off/on
  48.3/83.6 beats Pelias, intl off/on 47.1/44.7, US 97.2 / FR 84.9 held). The region tail did exactly its job —
  international region-match 0% → ~40%, Berlin intl-loc 34.4→38.7 — but locality stayed flat. The anchor-on
  intl gap (38.9pp) is the anchor's **positional** harm, not the corpus (the posterior diagnostic already
  ruled out feature content). **The corpus lever is exhausted for the anchor-on intl gap.** → v0.9.4.
- **#334 / #336 — v0.9.4 dual-injection** (merged, trained, evaluated, **not shipped**). DeepSeek's signed-off
  architectural fix: pool the anchor and inject it _also_ at position 0, an order-independent cue (no new
  params, `c=0` identity holds, 8/8 anchor tests, ONNX-export-equivalent). It did **nothing** to the intl gap
  (native off/on 48.3/83.5, intl off/on 47.3/43.7, US 96.4 / FR 84.9 held). Three retrains, one immovable
  number (~44%). The anchor's native-help (+35) / intl-hurt (−4) asymmetry is **fundamental** — not corpus,
  not region, not injection position.
- **#337 — the anchor fork, RESOLVED** (merged). With the operator away, the third DeepSeek turn (delegated
  authority) made the call: **(b) accept the asymmetry, burn no more GPU.** Its mechanistic read reframes the
  multi-locale plan — the anchor's direction is _learned per locale_ from the dominant training order, so the
  next thread is a **country-conditioned anchor vector**, not another tuning pass. Decision record in
  `2026-06-06-v0.9.2-eval.md` §"accept the asymmetry".
- **Multi-locale tooling (#332 / #333 / #335)** — `build-locale-shard.mjs` rebuilt registry-driven, with a
  streaming Algorithm-R reservoir so FR/US-scale OA CSVs (2.5 GB+) sample without OOM; NL postcode
  normalization; and **Italy + Spain OA data acquired** (IT 468 MB, ES 451 MB, durable backups on
  `/mnt/playpen`). **DE / NL / FR / IT / ES are all shard-ready.** _(Correction: an earlier note here called ES
  "no clean countrywide aggregate." That was wrong — I'd only checked the `results.../latest/run/es` path, which
  404s. The `es/countrywide` source points to a cached upstream CSV on `data.openaddresses.io` that downloads
  fine; it's the raw CNIG schema rather than OA-conformed, so the builder gained a per-part `conform` map —
  street = join(`tipo_vial`, `nombre_via`), region = `comunidad_autonoma`. A 2k smoke build renders both orders
  with the region tail carried, e.g. `2 CALLE JACINTO, Lepe, Andalucía 21440`.)_
- **Demo-refinement tier (#338 / #339 / #340)** — the operator's "visualizer breakdown + polish" ask, shipped
  in three additive demo PRs once GPU was off the table:
  - **#338 (S34) — span-highlight visualizer.** The raw input rendered as a displaCy-style ribbon, each tagged
    span tinted by its confidence (the table's red→amber→green tiering) with the tag labelled beneath; dropped
    spans read as literal colour gaps. The decoder already carried char offsets — `flattenTree` was dropping
    them.
  - **#339 (S37) — per-stage timing breakdown.** A stacked bar (shape+kind / classify / resolve) sized by each
    stage's wall-clock; the neural inference visibly dominates. Measured in the demo via `performance.now()`,
    the one-time DB load excluded so resolve isn't skewed.
  - **#340 (S40) — copy-result-as-JSON.** A "Copy JSON" button that yields a clean paste-into-an-issue object
    (input + components with offsets + resolved place). Enter-submit and the loading splash already existed.

## What went well

- **Measure-first paid off twice.** The whole shift exists because we re-measured German in its native
  order and found the "collapse" was largely an eval artifact. Tonight's S1 probe (below) did the same to
  the anchor's role.
- **The corpus pipeline mirrored v0.4.1-de exactly** — overlay manifest, base shards by reference, no
  rebuild of 677M rows. Clean, fast, verified on the volume before launch.
- **Pivoting cleanly when GPU was called off.** DeepSeek's "(b), no more GPU" verdict could have read as a dead
  end; instead it freed the back half for the demo tier the operator had explicitly asked for. Three small
  additive PRs, each typechecked + logic-validated + e2e-safe, none touching the v0.6.0 production path.
- **The demo work degraded gracefully by design.** `SpanHighlight` and `TimingPanel` both render `null` when
  their data is absent (older models with no offsets, an all-O parse), so the table alone always tells the
  story — no new failure surface.

## What could've gone better

- **A branch-base trap:** the committed native-order asset read 0.0% because that branch predated #322
  (the anchor inference code); `parseAnchorLookup` wasn't compiled in. Cost ~15 min of confusion before I
  traced it to the branch base. Lesson logged: an anchor eval needs #322 on the branch.
- **The generalized builder (S3) hit real walls** I should have anticipated: FR's OA CSV is 2.5 GB (over
  the 1 GB buffer → needs streaming + reservoir sampling), NL's template reformats the postcode. DE-parity
  is proven; the rest is held, honestly documented, not half-shipped.
- **The demo tier serialized on merges.** S34/S37/S40 each touch `ResultPanel.tsx`, so each waited on the
  previous to merge before it could branch cleanly (the last one rebased onto the prior). It worked, but a
  single demo PR bundling all three would have spent less wall-clock on merge-poll loops. Worth batching
  same-file UI changes next time.
- **I couldn't visually verify the demo in-shift.** The ribbon/timing/copy UI only renders after a real parse
  (60 MB of model + WOF assets), so I leaned on `tsc` + the docs build + standalone segmentation tests rather
  than an actual screenshot. Sound, but the operator should eyeball the deployed demo — flagged below.

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

- **THE fork (#327) — RESOLVED by DeepSeek (delegated authority), ~11:50 UTC → (b) accept the asymmetry.**
  Three retrains — both-order corpus (v0.9.2), region tail (v0.9.3), **and the architectural fix,
  dual-injection (v0.9.4)** — ALL left the anchor-on international number immovable at ~44% (gap to native
  ~40pp). The anchor's native-help (+35) / international-hurt (−4) asymmetry is **fundamental** — not corpus,
  not region, not injection position. With the operator away, the third DeepSeek turn made the call: **(b)** —
  the native gain is large/robust/generalizing (US 96.4, FR 84.9 hold), the intl penalty small/stable, and
  anchor-off intl already ~48% (the `c=0` path serves international order), so burn no more GPU. The turn's
  mechanistic read reframes the multi-locale plan: the anchor's direction is **learned per locale** from the
  dominant training order (US trains postcode-after-city → anchor looks left → never hurt US; German native is
  postcode-before-city → looks right; one shared vector can't serve both). The plan is constrained, not dead —
  the documented next thread is a **country-conditioned anchor vector** (a future iteration with its own gate),
  plus a no-GPU operational lever: route international-order inputs to the `c=0` path via a lightweight
  order check. None of v0.9.2/3/4 promote; v0.6.0 stays production. The operator can revisit the next-thread
  choice; the shift's experimental arc is closed. _(Decision record: `2026-06-06-v0.9.2-eval.md`, §"accept the
  asymmetry"; #327.)_
- **The next anchor thread is the country-conditioned vector** — pick when you're ready. The shift mapped the
  ground and #327 now tracks it; it gates the multi-locale retrain program, so it's the lever before any
  ES/IT/NL/FR retrain. A cheap no-GPU interim (route international-order inputs to the `c=0` path via a
  lightweight order check) is filed there too.
- **Eyeball the deployed demo.** The span ribbon / timing bar / copy button were validated by `tsc` + the docs
  build + standalone tests, but not by an in-shift screenshot (they only render after a real 60 MB parse).
  A 30-second look at the live demo confirms the visuals land.
- **The demo's service-worker cache (S38) is the operator's other explicit ask, not yet started.** Today the
  ~60 MB bundle is HTTP-cache-only ("the browser caches everything" — fragile, no offline, no version
  awareness). Next session: evaluate `@docusaurus/plugin-pwa` vs a hand-rolled Cache API, precache
  `model.onnx` + `tokenizer.model` + `wof-hot.db` **keyed by `selectedVersion`** (evict old blobs on switch).
  Deserves its own focused session with real browser testing — too easy to half-ship at end-of-shift.
- **FR (#330):** the FR gap is venue (0%) + region (19%) — convention gaps, not basics. Worth a targeted FR
  venue+region corpus supplement on the next multi-locale push?
- The 19 high + 1 critical dependabot alerts (vitest dev-scope) — bump in a dedicated `chore(deps)` pass?

## Concrete next steps

- **Country-conditioned anchor (#327):** a per-locale anchor direction (DE specializes on postcode-before-city,
  US on postcode-after-city), so no shared vector is forced to compromise. Its own gate via `de-order-eval.sh`.
  The interim no-GPU lever (order-check → `c=0` route) is the cheap first move.
- **Multi-locale shards:** DE / NL / FR / IT / **ES** are all shard-ready via `build-locale-shard.mjs` (ES via
  a per-part `conform` map on the raw CNIG upstream). The gate before any retrain is the country-conditioned
  anchor (#327), not the data.
- **Demo S38 — service-worker precache** for the ~60 MB bundle, keyed by `selectedVersion` (see above).
- **FR (#330):** assemble a venue+region FR shard (real OSM/WOF POIs + FR région forms), measure with
  `per-locale-f1.ts`.

## Numbers

| metric                  | value                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| Shift window            | 04:16 UTC → 14:00 UTC                                                                     |
| PRs merged              | 18 — #321-326, #328-329, #331-340 (3 demo: #338 S34, #339 S37, #340 S40)                  |
| Issues filed / resolved | #327 anchor fork **RESOLVED** (b, DeepSeek delegated authority), #330 FR gap / #239, #241 |
| Models trained          | 3 (v0.9.2 both-order, v0.9.3 region-tail, v0.9.4 dual-injection — all 20k, all negative)  |
| Modal spend             | ~$12 of $15 _(3 runs; GPU called off after v0.9.4)_                                       |
| DeepSeek consults       | 1 session, 3 turns (turn 3 = the delegated-authority decision) + the posterior diagnostic |
| Data acquired           | Italy OA countrywide (468 MB); DE/NL/FR/IT shard-ready                                    |
| NaN incidents           | 0                                                                                         |
| CI failures             | 0                                                                                         |
| Demo regressions        | 0 (v0.9.x research line + additive demo tier; v0.6.0 production untouched)                |
