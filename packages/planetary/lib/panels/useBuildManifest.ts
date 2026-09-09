/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The body's build manifest, fetched once and read by everything that reports provenance.
 *
 *   The manifest names the archives a build read, their digests and the nomenclature snapshot date, so both the
 *   footer credit and the About sheet change when the archives do. They share this hook rather than a fetch each: two
 *   requests for one document would also be two chances to disagree about what the build used.
 */

import { type PlanetaryBuildManifest, PlanetaryBuildManifestSchema } from "@mailwoman/astrogeology/schema/manifest"
import { useEffect, useState } from "react"

export type BuildManifestState =
	| { status: "loading" }
	| { status: "ready"; manifest: PlanetaryBuildManifest }
	| { status: "failed" }

export function useBuildManifest(manifestURL: string): BuildManifestState {
	const [state, setState] = useState<BuildManifestState>({ status: "loading" })

	useEffect(() => {
		let cancelled = false

		fetch(manifestURL)
			.then(async (response) => {
				if (!response.ok) throw new Error(`${manifestURL}: ${response.status}`)

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
	}, [manifestURL])

	return state
}
