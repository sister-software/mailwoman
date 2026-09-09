/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Attribution from the pipeline's manifest, not from a string in the app: the manifest names the sources a build
 *   read and the nomenclature snapshot date, so the line changes when the archives do and never drifts from them.
 */

import { type PlanetaryBuildManifest, PlanetaryBuildManifestSchema } from "@mailwoman/astrogeology/schema/manifest"
import { MapFooter } from "@mailwoman/react/map/MapFooter"
import { useEffect, useState } from "react"

import type { PlanetaryMapConfig } from "#bodies/config"

export interface AttributionProps {
	config: PlanetaryMapConfig
}

type ManifestState =
	| { status: "loading" }
	| { status: "ready"; manifest: PlanetaryBuildManifest }
	| { status: "failed" }

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
	const [state, setState] = useState<ManifestState>({ status: "loading" })

	useEffect(() => {
		let cancelled = false

		fetch(config.artifacts.manifestURL)
			.then(async (response) => {
				if (!response.ok) throw new Error(`${config.artifacts.manifestURL}: ${response.status}`)

				return PlanetaryBuildManifestSchema.parse(await response.json())
			})
			.then(
				(manifest) => {
					if (!cancelled) {
						setState({ status: "ready", manifest })
					}
				},
				() => {
					if (!cancelled) {
						setState({ status: "failed" })
					}
				}
			)

		return () => {
			cancelled = true
		}
	}, [config.artifacts.manifestURL])

	const lines =
		state.status === "ready"
			? creditLines(state.manifest, config)
			: ["USGS Astrogeology / IAU WGPSN — nomenclature", `${config.terrainCredit} — terrain`, "MapLibre"]

	return (
		<div className="attribution" data-manifest={state.status}>
			<MapFooter identity={<strong>{config.title.replace("Mailwoman ", "")}</strong>} attribution={lines} />
		</div>
	)
}
