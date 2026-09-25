/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetches the body's build manifest, which lists the archives a build read, their digests and the
 *   nomenclature snapshot date.
 */

import { type PlanetaryBuildManifest, PlanetaryBuildManifestSchema } from "@mailwoman/astrogeology/schema/manifest"
import { useEffect, useState } from "react"

/**
 * The loading state of the build manifest.
 */
export type BuildManifestState =
	| { status: "loading" }
	| { status: "ready"; manifest: PlanetaryBuildManifest }
	| { status: "failed" }

/**
 * Fetches and validates the build manifest at `manifestURL`.
 */
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
