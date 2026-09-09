/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attribution from the pipeline's manifest, not from a string in the app: the manifest names the sources a build
 *   read and the nomenclature snapshot date, so the line changes when the archives do and never drifts from them.
 */

import type { PlanetaryBuildManifest } from "@mailwoman/astrogeology/schema/manifest"
import { MapFooter } from "@mailwoman/react/map/MapFooter"

import type { PlanetaryMapConfig } from "#bodies/config"
import { useBuildManifest } from "#panels/useBuildManifest"

export interface AttributionProps {
	config: PlanetaryMapConfig
}

/**
 * One line per source the manifest names, in the manifest's order, then the renderer.
 */
function creditLines(manifest: PlanetaryBuildManifest, config: PlanetaryMapConfig): string[] {
	const lines: string[] = []

	for (const source of manifest.sources) {
		if (source.id.endsWith("-nomenclature")) {
			lines.push(
				`USGS Astrogeology / IAU WGPSN — nomenclature${source.snapshot ? `, snapshot ${source.snapshot}` : ""}`
			)
		} else if (source.id.endsWith("-dem")) {
			lines.push(`${config.terrainCredit} — terrain`)
		}
	}

	lines.push("MapLibre")

	return lines
}

export function Attribution({ config }: AttributionProps) {
	const state = useBuildManifest(config.artifacts.manifestURL)

	// Before the manifest answers, the credit still names both sources: it is a licence obligation that cannot wait
	// on a fetch, and the manifest only ever refines the snapshot date it carries.
	const lines =
		state.status === "ready"
			? creditLines(state.manifest, config)
			: ["USGS Astrogeology / IAU WGPSN — nomenclature", `${config.terrainCredit} — terrain`, "MapLibre"]

	return (
		<div className="attribution" data-manifest={state.status}>
			<MapFooter identity={<strong>{config.displayName}</strong>} attribution={lines} />
		</div>
	)
}
