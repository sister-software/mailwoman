/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where the camera goes when a feature is selected. The zoom is the inverse of the pipeline's declutter rule: a
 *   feature first appears at the zoom its diameter earns, and the camera lands one or two levels past that, so the
 *   selected label is on screen with its neighbors rather than alone.
 */

/**
 * Diameter thresholds in kilometres and the zoom a selection of that size lands at, largest first.
 */
const SELECTION_ZOOM_STEPS: ReadonlyArray<readonly [minDiameterKm: number, zoom: number]> = [
	[300, 3],
	[100, 5],
	[30, 7],
]

/**
 * The zoom for a feature smaller than every step, and for one whose diameter the source does not give.
 */
const SMALL_FEATURE_ZOOM = 9

/**
 * The zoom a selected feature is framed at, from its diameter in kilometres.
 */
export function zoomForDiameter(diameterKm: number | undefined): number {
	if (diameterKm === undefined) return SMALL_FEATURE_ZOOM

	for (const [minDiameterKm, zoom] of SELECTION_ZOOM_STEPS) {
		if (diameterKm >= minDiameterKm) return zoom
	}

	return SMALL_FEATURE_ZOOM
}

/**
 * Whether the viewer asked for reduced motion; a camera move then jumps instead of flying. Answers false where
 * `matchMedia` does not exist, so a test environment without a window gets the animated default.
 */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
}
