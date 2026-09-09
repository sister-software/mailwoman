/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What this globe is made of: the archives the build read, with their snapshot dates and sizes, and the build's own
 *   version.
 *
 *   The footer strip carries one line of credit because that is a licence obligation and has to be visible without
 *   asking. This sheet is the rest of the same manifest — a reader who wants to know which DEM, from when, at what
 *   size, asks for it here instead of reading the pipeline's source.
 */

import type { ReactNode } from "react"

import type { PlanetaryMapConfig } from "#bodies/config"
import { useBuildManifest } from "#panels/useBuildManifest"

const BYTES_PER_MEBIBYTE = 1024 * 1024

export interface BodyAboutProps {
	config: PlanetaryMapConfig
}

/**
 * A source's name as a reader would say it, from the id the pipeline gave it.
 */
function sourceTitle(id: string): string {
	if (id.endsWith("-nomenclature")) return "Nomenclature — USGS Astrogeology / IAU WGPSN"

	if (id.endsWith("-dem")) return "Terrain — digital elevation model"

	return id
}

export function BodyAbout({ config }: BodyAboutProps): ReactNode {
	const state = useBuildManifest(config.artifacts.manifestURL)
	const bodyName = config.title.replace("Mailwoman ", "")

	return (
		<>
			<p className="mw-map-sheet__hint">
				A globe of {bodyName} rendered from published elevation and the IAU's approved feature names. Search a name, or
				click a label, to frame the feature it belongs to.
			</p>

			<div className="mw-map-sheet__row">
				<span className="mw-map-sheet__label">Build</span>
				<code>{config.artifacts.version}</code>
			</div>

			{state.status === "ready" ? (
				state.manifest.sources.map((source) => (
					<div key={source.id} className="mw-map-sheet__row">
						<span className="mw-map-sheet__label">{sourceTitle(source.id)}</span>
						<p className="mw-map-sheet__hint">
							{source.snapshot ? `Snapshot ${source.snapshot}. ` : ""}
							{Math.round(source.bytes / BYTES_PER_MEBIBYTE).toLocaleString()} MiB.
						</p>
					</div>
				))
			) : (
				<div className="mw-map-sheet__row">
					<p className="mw-map-sheet__hint">
						{state.status === "loading"
							? "Reading the build manifest…"
							: "The build manifest could not be read, so the sources below the credit line are unavailable."}
					</p>
				</div>
			)}

			<div className="mw-map-sheet__row">
				<span className="mw-map-sheet__label">Coordinates</span>
				<p className="mw-map-sheet__hint">
					Reported {config.latitudeType}, east-positive — the convention the archives carry.
				</p>
			</div>
		</>
	)
}
