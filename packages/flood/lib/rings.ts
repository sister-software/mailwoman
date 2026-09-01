/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `flood_zone_area.rings` — the blob layout and the point test that reads it.
 *
 *   THE CODE ITSELF LIVES IN `@mailwoman/spatial`, and is re-exported here so this package's call sites and
 *   its `@mailwoman/flood/rings` subpath keep reading the same. It moved because a second polygon layer
 *   needed it — `@mailwoman/soil` stores an authority's unsimplified rings in exactly this shape — and two
 *   copies of the alignment arithmetic or of the signed-area reading is two places for either to stop being
 *   right. Both failure modes are silent: a mis-read blob answers a containment question wrongly, and a
 *   hole-blind area reading answers "inside" for every point in a hole.
 *
 *   Nothing in it is flood-specific. It is byte layout plus spherical geometry, which is what
 *   `@mailwoman/spatial` is.
 */

export {
	decodeRings,
	encodeRings,
	pointInEncodedRings,
	RING_BLOB_VERSION,
	ringAreaReadings,
	ringSignedAreaM2,
	type DecodedRings,
} from "@mailwoman/spatial"
