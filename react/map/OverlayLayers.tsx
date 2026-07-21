/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `<OverlayLayers>` — renders the host-supplied {@link OverlaySpec}s (coverage "fog of war",
 *   race-dots, …) as declarative `<Source>` + `<Layer>`s. This replaces the demo's imperative
 *   `map.addSource` / `map.addLayer` overlay loops (and their `isStyleLoaded()` / `styledata` gates):
 *   the host composes the specs, the package renders them, react-map-gl owns the add/remove lifecycle.
 *
 *   Each overlay's `visible` flag flips the layers' `visibility` layout property — the declarative seam a
 *   layer-toggle control drives in a later phase. NODE-IMPORT SAFETY: imports `react-map-gl/maplibre` —
 *   reachable only via `@mailwoman/react/map`.
 */

import { Fragment, type ReactNode } from "react"
import { Layer, Source } from "react-map-gl/maplibre"

import type { OverlaySpec } from "./types.ts"

export interface OverlayLayersProps {
	/** The overlays to render, in draw order (first is drawn first / lowest). */
	overlays?: OverlaySpec[]
}

/** Render each overlay as one `<Source>` and its `<Layer>`s, honoring the `visible` flag via `visibility`. */
export function OverlayLayers({ overlays }: OverlayLayersProps): ReactNode {
	if (!overlays || overlays.length === 0) return null

	return (
		<>
			{overlays.map((overlay) => {
				const visibility = overlay.visible === false ? "none" : "visible"

				return (
					<Fragment key={overlay.id}>
						<Source id={overlay.id} {...overlay.source} />
						{overlay.layers.map((layer) => (
							<Layer key={layer.id} {...layer} layout={{ ...layer.layout, visibility }} />
						))}
					</Fragment>
				)
			})}
		</>
	)
}
