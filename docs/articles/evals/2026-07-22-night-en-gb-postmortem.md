# 2026-07-22 night shift — en-GB arc: the dependent_locality resurrection window

Conn handed 04:42 UTC with ship authority (gate-conditional); wrapped early — all task-list items executed or parked at a documented operator fork. PR: [#1249](https://github.com/sister-software/mailwoman/pull/1249).

## What shipped

- **PR #1249** (unmerged, morning review): 21 reviewed commits — GB corpus pipeline (PPD 31.3M→25.67M tuples), dep-loc shard paths for GB/NZ/ES/FR (each hard-gated), two formatter dependent_locality rendering fixes (quarter-slot; place-slot + post-render injection — ~169 countries newly renderable), resurrection training levers (`reinit_label_rows` + `classifier_learning_rate`), three pre-registered configs, four golden boards (GB/NZ committed in-arc; ES/FR landing as the shift's last commit), `@mailwoman/neural-weights-en-gb` overlay with full release wiring + the base-card-fallback Critical fix from the final review.
- **No model shipped** — the feed run failed its registered bars; ship discipline held despite standing authority.
- **Acquisition wave** (~13.7 GiB, all provenance-manifested): BR CNPJ 2026-07 (6.3 GiB, bairro confirmed), MX DENUE (548 MiB), GB EPC domestic (6.0 GiB), ONSPD, OS Open UPRN. Catalog corrections folded into `.notes/data-sources.md` (CNPJ WebDAV move; EPC Bearer auth).
- Issues filed: #1247 (stale STAGE2 label tests), #1248 (`_merge` silent unknown-key drop).

## The headline finding: resurrection is a _window_, not a switch

The arc's science, in four runs (full record: config headers + `.superpowers/sdd/task-8-report.md`):

| Run              | Recipe                                       | Decode dep-loc (NZ / GB)                | Raw-BIO (GB)                           | Verdict                                                                                                                         |
| ---------------- | -------------------------------------------- | --------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| probe-1 (2k)     | levers + synth-gb 6.0 (~1.3% dep-loc stream) | 0/246 · 0/69                            | 2/69, gap 4.61                         | starved, not dead                                                                                                               |
| probe-2 (2k)     | ONE var: synth-gb 36.0 (~6.6%)               | **3/246 · 1/69 — first emissions ever** | 12/69, min gap 0.000                   | mechanism CONFIRMED; skew costs (us −0.8pp, bare-locality 0.60)                                                                 |
| feed (8k)        | ONE var: 4-locale split at same density      | 0/246 · 0/69                            | 0/69, gaps worsened                    | skew costs recovered (bare-locality 0.988) but tag re-buried                                                                    |
| checkpoint sweep | (no GPU)                                     | flat zero all checkpoints               | **peak 5/69 @ 2k → monotonic decline** | **RE-BURIAL: hot classifier LR is a ~2k resurrection window, after which the 93% negative mass re-buries the tag at hot speed** |

The null condition is **not** met — the tag is learnable; the _schedule_ is wrong. Diversification did exactly what it promised for the guards and nothing for retention.

## Decisions needed (the morning fork)

1. **(A) Two-phase schedule** — hot classifier group for ~2k, then drop/decay `classifier_learning_rate` for consolidation. Mechanistically targeted at the sweep's finding. ~25 min A100.
2. **(B) Concentrate-then-resume** — probe-2 recipe 2k, then `resume` (optimizer state intact — the resume-not-init_from rule) into multi-locale at normal LR.
3. **(C) Upstream** — conventions loss-mask / collapse_to_active.
4. **(D) Ship en-GB v1 locality-mapped now** — fully de-risks October; resurrection becomes its own arc.
5. **Before ANY next real release dispatch:** re-stage HF with `--postcodes …,postcode-gb.bin` (publish.yml preflight now requires it — PR body has the command).
6. EPC×UPRN wave-2: probe says GO (99.99% join, WGS84 in-file, smoke 5/5) — needs GB address-line parsing + a `gb` StreetLocale + a workspace decision (`epc-uprn/`, shipped tier).
7. BR arc: CNPJ bairro data is on disk — fold bairro→dependent_locality into v3.8.6 or keep BR one-variable?

## What went well

- **Gate discipline caught four would-be disasters:** the 0%-dep-loc GB shard (formatter quarter bug) pre-training; the ES no-slot template pre-training; the card-less en-gb overlay that would have _published broken_ (final-review Critical); and the feed run's ship path stayed closed on a guard fail despite standing ship authority.
- Pre-registration + one-variable discipline made the four-run story fully attributable — every number traces to a header written before the run.
- The checkpoint sweep (zero GPU) converted a failed run into the arc's most valuable finding.

## What could've gone better

- **The run-A misadjudication** (~5 min A100 wasted on a byte-identical rerun): I called "instrument failure" from a maxΔ row comparison — the wrong instrument at 384 dims (element scale ~0.07). Cosine similarity settled it in one command. Lesson memorized: _cosine, not maxΔ, for re-init verification_.
- **Layer-blind grading nearly killed the arc:** probe-1's 0-emission was measured at production decode, which hides sub-margin signal ("JSON hides gaps" — again). The operator's raw-BIO instinct was the arc's pivotal correction.
- Three agents parked on background-job monitors instead of polling (known SDD lesson; re-briefing cost ~4 round-trips — the blocking-poll pattern should go into the dispatch template).

## Decisions made autonomously

- Probe-2 → feed escalation composition (4-locale split at held density) — operator had green-lit multi-locale direction.
- No training iteration after the feed fail (treadmill guard) — sweep diagnostic only, fork documented instead.
- ES semantics preserved via new source name + explicit flag; findLastIndex formatter fix landed with the ES shard's first-match drift documented, not rebuilt.
- Selective staging of `train_remote.py` (our 3 sync fns committed; operator's `sync_latam_br` restored untouched to the working tree).

## Numbers

Shift span 04:42–~08:00 UTC (wrap-work continuing to 15:00 under cron). Modal: 4 training runs (2×2k probe-class, 1×2k rerun, 1×8k) + ~8 export/quantize jobs ≈ **1.3 A100-hours**. GPU lost to error: ~5 min (run B). Local: 3 shard builds (800k each) + boards + 25.67M-row extraction. NaN incidents: 0. CI failures: 0. Demo regressions: 0 (nothing shipped). Agents dispatched: ~25 (implementers, reviewers, fixers, ops, probes); every code commit task-reviewed + whole-branch reviewed.
