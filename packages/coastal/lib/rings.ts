/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `coastal_zone_area.rings` — the blob layout and the point test that reads it.
 *
 *   THE CODE ITSELF LIVES IN `@mailwoman/spatial`, and is re-exported here so this package's call sites and
 *   its `@mailwoman/coastal/rings` subpath keep reading the same. Nothing in it is coastal-specific: it is
 *   byte layout plus spherical geometry, which is what `@mailwoman/spatial` is, and a second copy of the
 *   alignment arithmetic or of the signed-area reading is a second place for either to stop being right.
 *   Both failure modes are silent — a mis-read blob answers a containment question wrongly, and a hole-blind
 *   area reading answers "inside" for every point in a hole.
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
