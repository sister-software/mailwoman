# Overture ES postcode centroids vs the GeoNames baseline (#474)

#474 asked to close the postcode-anchor's **ES/IT coverage gaps** from Overture postcode centroids. The
measurement says the gap is **mostly already closed** (a GeoNames backfill got there first), Overture
adds a **marginal +1.5% ES coverage at equivalent accuracy**, and **IT is Overture-blocked**. Net: the
anchor's ES/IT coverage is effectively solved; Overture is a complementary source, not a needed fix.

## What was measured

The shipped `postalcode-intl.db` already carries GeoNames-backfilled ES/IT postcode centroids (ES 11,331
postcodes / IT 4,936). From the local Overture release (`addresses-es.parquet`, ES postcode fill 100% /
15.7M points) I aggregated per-postcode centroids (mean after dropping points >3σ from the per-postcode
mean — `scripts/eval/overture-es-postcode-centroids.ts`, 10,850 ES postcodes) into a `spr`-table DB, and
ran the existing harness (`scripts/eval/postcode-anchor-accuracy.ts`) on the 3,000-row ES eval
(`openaddresses-es-sample.jsonl`) for each source.

| source | postcodes | placed (eval) | p50 km | p90 km | p99 km | within 10 km | within 25 km |
| --- | --: | --: | --: | --: | --: | --: | --: |
| GeoNames (shipped) | 11,331 | **98.5%** | 1.0 | 6.3 | 27.9 | 95.2% | 98.6% |
| Overture | 10,850 | **100.0%** | 1.0 | 6.3 | 27.9 | 95.2% | 98.7% |

## Reading

- **Coverage:** Overture places 100% of the eval postcodes vs GeoNames' 98.5% — it covers the 45 (1.5%)
  ES postcodes GeoNames missed. But GeoNames carries ~481 more postcodes overall (11,331 vs 10,850), so
  the two are **complementary**: the union (GeoNames ∪ Overture) is strictly ≥ either alone.
- **Accuracy: a tie.** The distance distributions are identical (p50 1.0 km, p90 6.3 km). The metric
  reflects the **postcode's spatial extent** (a random address sits ~1 km from the postcode centroid),
  not centroid error — both methods place the centroid near the postcode's true center, so Overture's
  15.7M-point density buys no accuracy edge here. The anchor only needs centre-of-postcode; it has it.
- **IT is blocked.** Overture's IT postcode fill is **0%** (the #474 ingest gate "≥80% else renegotiate"
  fails for IT) — GeoNames stays IT's source. Documented as an Overture gap alongside GB (Overture has no
  GB either — Ordnance Survey licensing).

## Recommendation

The ES/IT postcode-anchor coverage gap is **effectively closed by GeoNames** (98.5% / 90% placed). The
honest call:

1. **ES** — optionally merge Overture into the canonical (`postalcode-intl.db`) as a **union** to pick up
   the residual ~1.5% at equal accuracy, with `source` provenance. This is a **canonical-DB change** →
   the operator's call; the validated Overture ES centroids are staged at
   `postcode-es-overture.db` + the reusable extractor is committed. Marginal value — not urgent.
2. **IT** — keep GeoNames; Overture can't help (0% postcode fill).
3. **GB** — permanent external gap (no open licensed source).

No model retrain, no posterior re-weighting (the #474 scope guard) — this is a data-layer measurement.
The takeaway for the anchor coverage docs: **es/it are no longer gaps; gb is the only permanent one.**

_Source: `scripts/eval/overture-es-postcode-centroids.ts` (Overture → centroids → spr DB);
`scripts/eval/postcode-anchor-accuracy.ts` (the before/after on `openaddresses-es-sample.jsonl`)._
