# UPRN → unit postcode on the PO area: the null model and the same-building rule, graded against NSUL

Date: 2026-09-03. Record for #1975, falsifiers F2 and F3 of the design record
`docs/superpowers/specs/2026-09-03-physical-constraint-prior-design.md`. Point-in-time; numbers are
not updated.

## Question

Can the GB unit-postcode assignment (which addressable object carries which unit postcode) be
reconstructed from open physical inputs — postcode centroids, object coordinates, building
footprints — well enough to stand in for the register? The register exists openly (ONS NSUL), so the
reconstruction is graded against it, and its error is what the method would carry to a place with no
register.

## Inputs

| Input              | Artifact                                                                                                         | Rows in play                        | Provenance                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Truth              | ONS NSUL June 2026 (Epoch 127), `Data/NSUL_E127_JUN_2026_SE.csv`, rows with `PCDS` starting `PO`                 | 531,301                             | archive md5 `1b7dea3a15377dc5463a7801a5a8b179`, 514,786,231 bytes; OGL-UK-3.0 with four attribution lines |
| Object coordinates | `$MAILWOMAN_DATA_ROOT/uprn/uprn.db` (OS Open UPRN, release 2026-08)                                              | 531,266 joined by UPRN (35 missing) | manifest `os-open-uprn`, OGL-UK-3.0                                                                       |
| Centroids          | `$MAILWOMAN_DATA_ROOT/wof/postalcode-gb-codepoint.db` (Code-Point Open), PO box + 0.05°                          | 43,069 (24,496 `PO`)                | OGL-UK-3.0                                                                                                |
| Footprints         | OS Open Map – Local, tiles SU (md5 `8ca1f100…`) and SZ (md5 `8ac47c52…`), `Building` layer clipped to the PO box | 318,373 polygons                    | OGL-UK-3.0                                                                                                |

The PO box is 50.5662–50.9745 N, 1.5863 W–0.5857 W. Centroids from neighbouring areas are included so
a boundary point is not forced into PO.

## Method

1. `nearest-centroid` — each UPRN takes the unit postcode of the nearest Code-Point centroid
   (haversine; grid-bucketed search).
2. `same-building` — points inside one footprint take the majority of their rule-1 answers; an even
   split leaves them as they were and counts as a tie.
3. Control — points sharing an identical coordinate take their majority. Since identical coordinates
   have identical nearest centroids, this control must read zero lift; it does.

## Results

| Rule                               | Exact              | Rate   | Lift     |
| ---------------------------------- | ------------------ | ------ | -------- |
| nearest centroid                   | 369,626 of 531,266 | 69.57% | —        |
| same-building majority             | 369,285 of 531,266 | 69.51% | −0.06 pp |
| same-coordinate majority (control) | 369,626 of 531,266 | 69.57% | 0.00 pp  |

Of the nearest-centroid misses, 159,445 (30.0%) are the wrong unit in the right outward district and
2,195 (0.4%) the wrong outward district. 19,747 points (3.7%) sit within a metre of equidistant from
two centroids. Distance to the assigned centroid: p50 32 m, p90 72 m, p99 278 m. 460,106 points
(86.6%) fall inside a footprint; 144,164 buildings hold 397,900 points; 16,370 points sit in buildings
whose vote tied. 1,272 points (0.24%) are farther than 500 m from every centroid.

Recall at k over the nearest centroids (531,175 points whose true centroid is in Code-Point Open; 91 are
not): 69.59% at 1, 84.33% at 2, 90.34% at 3, 93.44% at 4, 95.23% at 5. For a miss, the true centroid is
1.51× farther than the nearest at the median and 3.26× at p90.

Worst outward districts, all near the area mean: PO20 65.8% of 28,429; PO2 65.8% of 24,383;
PO6 66.1% of 24,077; PO4 66.3% of 24,445. Largest single confusion: `PO20 9BH` → `PO20 9BJ`, 644 points.

## Verdict against the pre-registered rules

- Null model 69.57% exact: below the 80% floor. No runtime surface is earned.
- Footprint lift −0.06 pp: below the 5 pp bar. The footprint input is dropped.

## Reading

Unit postcodes interleave at the scale of a street. A point's own centroid is beaten by a neighbour's
for three points in ten, and buildings do not help because a building almost never spans the decision
between two units: the whole building takes the same wrong neighbour. The 91 truth postcodes absent
from Code-Point Open are a coverage gap of the centroid source, not of the method.

## Consequences

1. The GB artifact is a sealed build of NSUL joined to Open UPRN's coordinates. The register is open;
   the reconstruction does not replace it.
2. Northern Ireland has no Open UPRN and no NSUL. The method as measured here would be wrong on about
   three points in ten; the NI run of the design record still measures internal consistency, with this
   expectation recorded first.
3. The runtime decoration step (F4) is not earned.

## Reproduce

`scratchpad/1975/f2-nearest-centroid.ts`, `scratchpad/1975/f3-same-building.ts`,
`scratchpad/1975/f2b-knn-recall.ts` (git-ignored scratch, each under 20 s). Inputs as above; the
footprint clip is `ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 -spat -1.5863 50.5662 -0.5857 50.9745
-spat_srs EPSG:4326` over `SU_Building.shp` and `SZ_Building.shp`.
