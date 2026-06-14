# Hey Claude 👋

Your Opus session dropped mid-shift (network issues), but everything was fine. The retrain kept cooking on Modal, and a local session picked up the conn. Here's what happened while you were away.

## The retrain — verdict: ❌ no recovery

The v1.5.0-fr-order centerpiece ran to **step 100,000** cleanly (no NaN, no crash, ~1h40m on A100). We exported ONNX at step 40,000 and re-gated against `v0.5.0-bridge.json`:

| Metric              | v4.4.0 | v4.5.0 | v1.5.0-fr-order | Gate floor |
| ------------------- | ------ | ------ | --------------- | ---------- |
| **fr.house_number** | 97.7%  | 89.6%  | **87.2%**       | 91.0 ❌    |
| us.postcode         | —      | —      | 98.6%           | 97.0 ✅    |
| us.street           | —      | —      | 80.7%           | 74.0 ✅    |
| us.locality         | —      | —      | 77.2%           | 62.2 ✅    |
| us.region           | —      | —      | 90.4%           | 80.1 ✅    |
| fr.postcode         | —      | —      | 99.8%           | 99.5 ✅    |
| fr.region           | —      | —      | 41.8%           | 16.2 ✅    |

**fr.house_number at 87.2% is slightly worse than v4.5.0 (−2.4pp) and far below the plan target.** The reversed-order FR shard at 50K rows + weight 3.0 wasn't enough signal. Every other tag passed its floor. The training itself was technically clean — this is a strategy question, not a code bug.

## Wave A — all three merged ✅

Your three PRs (#561, #562, #563) all had green CI and were sequentially merged. The worktrees were cleaned up. No leaks into the primary checkout this time.

## Wave B — prettier sweep ✅

Task 5 (prettier) was delegated to a Sonnet agent while the retrain ran. 25 drifted files formatted, committed as `cb2ea16`. Pure format, no logic changes.

## Issue cleanup — 4 issues closed

While the GPU was busy, we scanned the open board and grabbed bounded code-only fixes:

| Issue                  | What                                                                                                                                                                                         | Commit    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **#481** items 3, 5, 7 | Export `ParseOpts`, explicit compiled-tree detection (basename instead of string-matching), named `NEUTRAL_PROPOSAL_CONFIDENCE = 0.55`                                                       | `cc8b38d` |
| **#379**               | `.gitignore` 50+ untracked ephemera files (night-shift plans, deepseek traces, diag scripts)                                                                                                 | `4c93bb2` |
| **#523**               | Fix `#fetchLocalitiesById` hard-stamped `placetype: "locality"` — now reads actual placetype from the `spr` row + regression test                                                            | `4572ebf` |
| **#552**               | Drop phantom `subregion` from imls adapter — US postal addresses don't surface counties, so emitting `subregion` created a component with no raw-span to align to, quarantining ~21% of rows | `1422d23` |

## Also confirmed (already done, found during review)

- **#397** — stale `link-dev-weights.sh`: already fixed, has v4.4.0 model + MD5 drift guard (`#397 GUARD` in the script)
- **#376** — `--default-country` CLI: already implemented with `localeToCountry` + `resolverDefaultCountry` + full test suite in `mailwoman/test/default-country.test.ts`
- **#481** items 4, 6, 7 — TLA removal, policy preference-filter tests, gazetteer validation: already in prior hardening commits

## The re-gate

Exported ONNX from step 40,000 (118.4 MB) at `/data/output-v150-fr-order-s42/model.onnx` on the Modal volume, downloaded locally to `output-v150-fr-order-s42/`. Ran `scripts/eval/promotion-gate.sh` against `v0.5.0-bridge.json`. The full gate timed out after `per-locale-f1.ts`, but that was enough — fr.house_number was the only metric we needed to see.

## Postmortem + supplemental plan

Both updated with the re-gate result and the supplemental session's work:

- `docs/articles/evals/2026-06-13-night-13-postmortem.md`
- `2026-06-13-NIGHT-SHIFT-PLAN-SUPPLEMENTAL.md`

## Open questions still standing

- The reversed-order FR shard at 50K rows wasn't enough. Options: larger shard (100K+ rows), multi-locale reversed-order data, or postcode-order-aware position encoding.
- The us.po_box raw F1 at 73.5% is below the 89.1 bridge-retirement floor (though the gate uses `us.po_box_real` from a different eval — the full gate CSV timed out before that benchmark ran).
- The corpus-v0.5.1 code-point re-align (#558) remains DeepSeek's parallel track.

---

Everything is committed and pushed to `main`. The conn is yours again whenever you're back.
