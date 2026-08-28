/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Turn a named administrative region into the H3 cell set a POI coverage claim may be keyed to.
 *
 *   `bboxCoverageCells` (build-poi.ts) polyfills a rectangle, which is right for a Geofabrik extract's
 *   rectangular clip and wrong for a region: a region extract is clipped to a polygon, so a rectangle
 *   polyfilled over it claims survey across whatever the rectangle overhangs. The interior-cell helpers
 *   answer the narrower question, and they answer conservatively, because the cells they return are the
 *   ones a completeness claim will be written to.
 *
 *   THE FUNCTIONS THEMSELVES LIVE IN `@mailwoman/spatial`, and are re-exported here so the POI pipeline's
 *   call sites keep reading the same. They moved because a second layer needed them — a flood-zone layer
 *   writes `designated` coverage over England by the same interior test — and two copies of a
 *   conservative containment rule is two places for it to stop being conservative. Nothing in them is
 *   POI-specific; they are geometry plus h3-js, which is what `@mailwoman/spatial` is.
 */

export { geometryBBox, interiorCoverageCells, interiorCoverageCellSet, regionCoverageCells } from "@mailwoman/spatial"
