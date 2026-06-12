# v0.5.0 char-offset launch — shift postmortem (2026-06-12)

Continuation of the night-12 build session. The build finished and validated; this shift's job was
to get the first model TRAINING on the v0.5.0 char-offset corpus. It did — after closing a corpus gap
that should have been caught earlier and routing around a Modal volume consistency failure. Training
is live and healthy at write time; the gate result is ~4h out.

## What shipped

- **First v0.5.0 char-offset training run is LIVE on A100** (`v1.4.0-charoffset`, Modal app
  `ap-tG4Os3vGel5MHREGwR9R0X`). Step-2000 val: `macro_f1=0.627` (street 0.81 / house_number 0.99 /
  locality 0.70 / region 0.65 / postcode 0.70), loss converging, no NaN. The char-offset format
  (#519 span triple) trains end-to-end — the headline de-risking of the whole v0.5.x line.
- **The corpus was completed.** The from-source build was BASE-ONLY (11 adapters); the shippable
  corpus also needs the 7 parity overlays. Re-emitted all 7 (synth-affix/german/country/unit/
  po-box-cedex/intersection + deepseek-kryptonite, ~485k rows) through the current span-native
  aligner so they carry the char-offset triple, merged into the v0.5.0 MANIFEST (689 shards, 676.6M
  train), re-validated: 18/18 weighted sources present, 0 out-of-bounds spans, 0 golden-in-val.
- **PR #559** — config (`v1.4.0-charoffset.yaml`), bridge-retirement gate (`v0.5.0-bridge.json`),
  `align-canonical-shard.mjs`, and the `train_remote.py` reroute (`sync_v050` + launcher fix).
- **DeepSeek re-align plan** drafted (`.agents/skills/deepseek-consult/plan-2026-06-12-codepoint-realign.md`)
  for the UTF-16→code-point offset fix (the lasting fix behind the #558 astral-skip stopgap).

## What went well

- **Verify-before-assert paid off repeatedly.** The "overlay gap" alarm was real, but I confirmed the
  mechanism (loader buckets shards by parquet `source`; an unweighted source's rows train but at the
  wrong sampling weight) before crying wolf. The "2 base adapters missing" alarm was a FALSE alarm —
  they were packed into mixed tail shards, present and training, same as v4.4.0. Both checks took
  minutes and prevented wrong conclusions.
- **The R2 reroute used the architecture's own grain.** Once CLI `volume put` proved container-blind,
  the fix was `sync_corpus`'s existing pattern (R2 → container-side rclone), not a bespoke hack.
- **Held the GPU.** Zero A100 spend until a fresh container provably saw the corpus + config. The
  launcher's own `config not found` caught the volume issue before any training money burned.

## What could've gone better

- **The overlay gap should have been caught at build time.** The rebuild plan's step 5 said "+ the
  v0.4.x overlay shards re-emitted natively"; the prior session did the from-source half, validated
  it, and reported "train-ready" without the overlays. A base-only corpus would have regressed every
  parity tag and made the bridge-retirement gate untestable. The validation report graded the build
  in isolation, not against the training config's `source_weights` — that cross-check is the fix.
- **A long Modal-infra detour ate most of the shift.** Two retries + a marker test + an env-mismatch
  hypothesis + a container-write test before the cause was nailed. Faster path: the marker test (CLI
  put → fresh container can't see it) is the 2-minute decisive probe; reach for it first next time.
- **Trackio dashboard was down** (`sister-software/mailwoman-trackio` Space not running), so the run
  logs CSV-only — no live web dashboard for the operator. Should have checked the Space was up before
  relying on `--trackio`.

## Decisions made autonomously

- **Re-emit overlays + complete the corpus before launching**, rather than launch base-only as a
  fast format-control signal. Base-only can't ship and can't answer the bridge question (the run's
  scientific point); the overlay re-emit was bounded (~minutes, builders are span-native). Surfaced
  the gap to the operator; proceeded under "start training now" + extended trust once corrected.
- **R2 reroute over volume recreation.** Recreating the volume would be faster but destroys the
  container-visible model history (every `output-*` checkpoint). The R2 path is non-destructive and
  reusable. Chose it without waiting on the operator since it risks only bandwidth, not data.
- **Bridge-retirement gate: inherit v4.4.0 floors verbatim, flag the unpinned thresholds.** Rather
  than fabricate numbers for "over-merge precision" + "#518 lens", encoded what's contractually
  pinned and flagged the rest for the operator/DeepSeek. No silent gate drift.
- **Enabled `--trackio`** for operator visibility (degrades to CSV-only on failure — which is what
  happened, harmlessly).

## Open questions

1. **Modal volume CLI-write blindness — root cause unknown.** CLI `volume put` writes are invisible
   to containers on `mailwoman-training`; container-side writes propagate. Suspected reconciliation
   state from this session's heavy churn (rm -r of 17 old corpora + a 41G put). Will it self-heal?
   Does it warrant a Modal support ticket or a volume rebuild? (Memory saved: route via R2 meanwhile.)
2. **Bridge-retirement gate thresholds.** `over-merge precision` + `#518 punctuation lens` need
   numeric floors before the gate is authoritative. Operator/DeepSeek to pin.
3. **Will char-offset hold v4.4.0 parity?** The step-2000 val is healthy but early. The real answer
   is the post-training gate (all v4.4.0 floors, bridge OFF). Pending.
4. **Trackio Space** needs waking if a live dashboard is wanted for this and future runs.

## Concrete next steps

- **When the run finishes (~4h):** run the full battery against the final checkpoint with the
  `v0.5.0-bridge` gate (bridge OFF). The decisive read: does `us.po_box_real` hold ≥89.1 bridge-off?
  If yes → retire the decode-side span bridge. If no → keep it, flip `requires_bridge:true` for the
  ship gate, treat as a MISS (don't re-baseline). Compare every tag against v4.4.0 — format-only
  change should be ~flat.
- **Review/merge PR #559** (merge-wall: operator).
- **Hand the DeepSeek re-align plan off** for the code-point offset fix → corpus-v0.5.1 (retires the
  #558 astral-skip stopgap).
- **Modal volume:** decide self-heal vs. rebuild vs. support ticket (open question #1).

## Numbers

| | |
|---|---|
| Shift focus | complete corpus + launch first char-offset training |
| Overlay shards re-emitted | 7 (~485k train rows) |
| Corpus | 689 shards, 676.6M train / 1.89M val / 1.89M test |
| Models trained | 1 launched (v1.4.0-charoffset, in-flight) |
| A100 spend before launch | 0 (held on the volume issue) |
| Training rate | ~2.6 steps/s (num_workers:0 data loader bound); ~4h ETA |
| Step-2000 val macro_f1 | 0.627 (healthy early checkpoint) |
| Infra incidents | 1 (Modal volume CLI-write blindness; rerouted via R2) |
| NaN incidents | 0 |
| PRs opened | #559 |
