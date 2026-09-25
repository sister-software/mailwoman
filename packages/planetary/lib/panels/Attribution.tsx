/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds the map credits from the build manifest, so they list the sources and the nomenclature
 *   snapshot date that the build actually used.
 */

import type { PlanetaryBuildManifest } from "@mailwoman/astrogeology/schema/manifest"
import { AppIdentity } from "@mailwoman/react/map/AppIdentity"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import { commitURL } from "@mailwoman/site-kit/build-info"

import type { PlanetaryMapConfig } from "#bodies/config"
import { useBuildManifest } from "#panels/useBuildManifest"

/**
 * Props for {@link Attribution}.
 */
export interface AttributionProps {
	config: PlanetaryMapConfig
}

/**
 * Returns one credit line per manifest source in manifest order, followed by the renderer.
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

/**
 * Renders the map footer with source credits from the build manifest.
 */
export function Attribution({ config }: AttributionProps) {
	const state = useBuildManifest(config.artifacts.manifestURL)

	// The licences require the credits even before the manifest loads, so a fallback
	// lists both sources without the snapshot date.
	const lines =
		state.status === "ready"
			? creditLines(state.manifest, config)
			: ["USGS Astrogeology / IAU WGPSN — nomenclature", `${config.terrainCredit} — terrain`, "MapLibre"]

	return (
		<div className="attribution" data-manifest={state.status}>
			<MapFooter
				identity={<AppIdentity name={config.displayName} docsURL="https://mailwoman.ai/docs" commitHref={commitURL} />}
				attribution={lines}
			/>
		</div>
	)
}
