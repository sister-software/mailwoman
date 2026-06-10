# Parity Scorecard — 2026-06-11 (baseline: v4.3.0, the relabel + conventions release)

Supersedes [2026-06-10](./parity-scorecard-2026-06-10.md). Same two lenses, same rules:
arena head-to-head is whole-parse-strict (honest, understates per-tag wins); per-tag F1 is
what the campaign moves; real-OOD columns are the truth for campaign tags. Self-emitted
from `external-arenas.sh` + `per-locale-f1.ts` + the real-OOD scorers — do not hand-edit.

**What changed since 06-10:** the #492 ladder closed (cause = a 1,039:1 label contradiction,
NOT capacity), the #511 relabel run shipped as **v4.3.0** after a FAIL→corrective→PASS gate
(`2026-06-11-v4.3.0-ship-gate.md`), and the conventions layer shipped its first slice (#478:
locale head exported + fr mask). Ship config now includes `addressSystemConventions: "auto"`.

## Lens 1 — capability arenas (v4.3.0 int8, TRUE ship config: anchor + gaz + conventions fed)

| arena | n | v0 | v4.2.0 | **v4.3.0** | both | neural-only | v0-only | both-fail |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| libpostal (clean/canonical) | 69 | 29% | 41% | **36%** | 16% | 20% | 13% | 51% |
| perturb (noisy/degraded) | 398 | 39% | 71% | **64%** | 34% | 30% | 5% | 31% |
| postal (edge formats) | 38 | 26% | 18% | **13%** | 5% | 8% | 21% | 66% |

> **Recorded dip, characterized:** the perturb drop vs v4.2.0 is dominated by the "glue"
> perturbation class (region+postcode fused: `NY14201` — v1.1.0 swallows the token as postcode,
> ~24–31 of 40 flips), plus street-boundary wobbles (post-directional `NW`, `Main St Apt`).
> Same boundary-instability family as the FR digit-split the conventions mask fixed; the US glue
> class needs a training-side augmentation (follow-up filed). Flagged-not-gated, same precedent
> as night-10. v0 still leads only on rare edge formats.

## Lens 2 — per-tag truth (int8, gaz+anchor+conventions fed)

| tag | eval | v4.1.0 | v4.2.0 | **v4.3.0** |
| --- | --- | --: | --: | --: |
| street_prefix | real-affix (32-row) | 0 | 64.9 | **93.6** |
| street_suffix | real-affix (32-row) | 0 | 48.8 | **96.6** |
| street_prefix | NAD-native v2 (193-row, NEW) | — | 18.2 | **92.2** |
| street_suffix | NAD-native v2 (193-row, NEW) | — | 8.9 | **90.3** |
| unit | real-designators | 92.3 | 90.6 | **92.1** |
| country | homograph-real | 27 | 89.8¹ | **85.1** |
| us.street (folded) | golden dev | 78.5 | 76.2 | 75.5 |
| us.locality | golden dev | 60.1 | 72.9 | **74.4** |
| us.region | golden dev | 78.4 | 89.1 | 89.1 |
| us.postcode | golden dev | 98.3 | 97.3 | **97.8** |
| us.micro | golden dev | 81.6 | 84.8 | **85.1** |
| fr.postcode | golden dev | 99.5 | 99.6 | **99.7** |
| fr.house_number | golden dev | 91.0 | 94.6 | **97.7** |
| fr.region | golden dev | 30.2 | 27.6 | 16.2 |
| de.native_locality | de-order (anchor on) | 90.6 | 90.9 | 90.1 |

¹ v4.2.0's country figure was measured under the historically gaz-starved country leg
(fixed this gate) — not directly comparable to v4.3.0's 85.1; both clear the 83.3 floor.

The authoritative gate record, including the honest-eval VT leg (region 99.6, coord p50/p90
3.4/7.4 km) and the FAIL→corrective→PASS story: [v4.3.0 ship gate](./2026-06-11-v4.3.0-ship-gate.md).

Open per-tag gaps after this release: po_box/cedex (deferred coverage lever — both Montréal
gate rows), FR region tail (27.6 → 16.2, unfloored), the US glue/post-directional boundary
classes (arena dip above), intersections (#487, needs corpus rows).
