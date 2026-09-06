/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `zoning_area.rings` — the blob layout and the point test that reads it.
 *
 *   THE CODE ITSELF LIVES IN `@mailwoman/spatial`, re-exported here so this package's call sites and its
 *   `@mailwoman/zoning/rings` subpath keep reading the same. Nothing in it is zoning-specific: it is byte
 *   layout plus spherical geometry, and a second copy of the alignment arithmetic or of the signed-area
 *   reading is a second place for either to stop being right. Both failure modes are silent — a mis-read blob
 *   answers a containment question wrongly, and a hole-blind area reading answers "inside" for every point in
 *   a hole.
 *
 *   WHAT IS NOT SHARED IS {@linkcode resolveRingRoles}, and the reason is that it is a fact about THIS
 *   PUBLISHER rather than about geometry: the service encodes hole roles by ring ORIENTATION, clockwise
 *   exterior, which is the inverse of RFC 7946's convention. `ring-roles.ts` carries it with the measurement
 *   that establishes it.
 */

export { resolveRingRoles, type ResolvedRingRoles } from "#ring-roles"
