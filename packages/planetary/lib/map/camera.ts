/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the camera goes when a feature is selected. The zoom is the inverse of the pipeline's declutter rule: a
 *   feature first appears at the zoom its diameter earns. The camera lands one or two levels past that so the
 *   selected label is on screen with its neighbors rather than by itself.
 */

/**
 * Diameter thresholds in kilometers and the zoom a selection of that size lands at, largest first.
 */
const SELECTION_ZOOM_STEPS: ReadonlyArray<readonly [minDiameterKm: number, zoom: number]> = [
	[300, 3],
	[100, 5],
	[30, 7],
]

/**
 * The zoom for a feature smaller than every step or one whose diameter the source does not give.
 */
const SMALL_FEATURE_ZOOM = 9

/**
 * How far past the terrain archive's deepest zoom the camera may go.
 *
 * One level of over-zoom is a sharp enough upsample to read as terrain.
 * An unclamped small-feature frame reached three levels past a zoom-6 archive,
 * is a grey blur with the tile boundaries showing.
 */
const OVERZOOM_ALLOWANCE = 1

/**
 * The zoom a selected feature is framed at, from its diameter in kilometers.
 *
 * `maxTerrainZoom` is the deepest zoom the body's terrain archive includes.
 * Read it from the live source rather than pinning it here because the two bodies publish different depths.
 *
 * A constant would drift when either is rebuilt.
 * Omit it and the framing is unclamped.
 */
export function framingZoom(diameterKm: number | undefined, maxTerrainZoom?: number): number {
	const unclamped = framingZoomForDiameter(diameterKm)

	if (maxTerrainZoom === undefined) return unclamped

	return Math.min(unclamped, maxTerrainZoom + OVERZOOM_ALLOWANCE)
}

function framingZoomForDiameter(diameterKm: number | undefined): number {
	if (diameterKm === undefined) return SMALL_FEATURE_ZOOM

	for (const [minDiameterKm, zoom] of SELECTION_ZOOM_STEPS) {
		if (diameterKm >= minDiameterKm) return zoom
	}

	return SMALL_FEATURE_ZOOM
}

/**
 * Whether the viewer asked for reduced motion.
 * A camera move then jumps instead of flying.
 *
 * Answers false where `matchMedia` does not exist, so a test environment without
 * a window gets the animated default.
 */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}
