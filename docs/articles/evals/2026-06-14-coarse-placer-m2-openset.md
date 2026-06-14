# Coarse-placer M2 Phase 1 — post-hoc open-set score comparison (#244)

_Frozen shipped model (`model`), NO retrain. In-map test 55000 rows (11 countries); off-map HELDOUT 66000 rows (never-trained families: baltic/oceania/middle-east). Mahalanobis fit on ≤2000/class in-map train logits. The 11-way routing is fixed; each score only changes the reject decision._

## Honest dev→test point (threshold picked on dev, frozen on test)

| score | TEST in-map | TEST held-caught | min | full-probe balanced |
|---|---:|---:|---:|---:|
| `maxprob` | 89.2 | 89.1 | **89.1** | 89.2 |
| `p_inmap` | 91.3 | 91.4 | **91.3** | 91.5 |
| `energy` | 83.5 | 83.4 | **83.4** | 83.5 |
| `maxlogit` | 83.6 | 83.6 | **83.6** | 83.6 |
| `maha` | 76.2 | 77.1 | **76.2** | 76.7 |

## Full-probe corners (the achievable Pareto), per score

| score | balanced min(in,held) | in-map @ held≥90 | held @ in-map≥90 |
|---|---:|---:|---:|
| `maxprob` | **89.2** (in 89.3, held 89.2) | in 88.1 / held 90.1 | in 90.2 / held 88.1 |
| `p_inmap` | **91.5** (in 91.5, held 91.5) | in 92.2 / held 90.5 | in 90.0 / held 92.8 |
| `energy` | **83.5** (in 83.5, held 83.6) | in 74.1 / held 90.3 | in 90.1 / held 77.2 |
| `maxlogit` | **83.6** (in 83.6, held 83.6) | in 74.2 / held 90.3 | in 90.3 / held 77.4 |
| `maha` | **76.7** (in 77.1, held 76.7) | in 67.1 / held 90.1 | in 90.0 / held 47.1 |

## Verdict

Best score (honest dev→test): **`p_inmap`** at min(in-map, heldout) = **91.3** on the frozen test half. **Clears 90/90 post-hoc** — wire it into CoarsePlacer as the open-set reject rule; no retrain needed (Phase 2 reject-head unnecessary).

Ranking (honest dev→test min): `p_inmap` 91.3 · `maxprob` 89.1 · `maxlogit` 83.6 · `energy` 83.4 · `maha` 76.2
