/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   POIExplorer — the docs-site wrapper around `@mailwoman/react`'s `POIExplorer`. The intent path
 *   (classify → subject → OverpassQL) lives entirely in the package and is self-contained. This file
 *   supplies only the ONE docs-specific concern: the live poi.db search, which needs the site's staged
 *   sql.js-httpvfs assets and the byte-ranged published layer. It's injected as a `runLiveSearch`
 *   function that dynamically imports `../../shared/poi-httpvfs.ts` on first use, so the httpvfs/worker
 *   machinery never enters the package's browser graph and the intent-only common case pays nothing.
 *
 *   Usage in MDX (unchanged):
 *
 *   ```mdx
 *   import { POIExplorer } from "@site/src/components/POIExplorer/POIExplorer"
 *
 *   <POIExplorer />
 *   ```
 */

import { POIExplorer as ReactPOIExplorer } from "@mailwoman/react"
import type { POILiveSearch } from "@mailwoman/react"
import { useCallback } from "react"

import "@mailwoman/react/styles.css"

import { useSiteConfig } from "../../hooks/site.ts"

export interface POIExplorerProps {
	/** Query to pre-fill in the input. */
	defaultText?: string
}

export function POIExplorer({ defaultText }: POIExplorerProps) {
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`

	// The live poi.db probe: resolve the anchor to a center, then k-ring search the published layer.
	// Preserves the tester's two failure modes — anchor unplaceable vs layer unreachable.
	const runLiveSearch = useCallback<POILiveSearch>(
		async ({ categoryID, overtureCategoryIDs, anchor }) => {
			const { loadPOIWorker, resolveAnchorCenter, searchPOICategory } = await import("../../shared/poi-httpvfs.ts")

			const center = await resolveAnchorCenter(sqljsBaseURL, anchor)

			if (!center) return { status: "unplaced", anchor }

			try {
				const worker = await loadPOIWorker(sqljsBaseURL)
				const hits = await searchPOICategory(worker, {
					categoryID,
					categoryIDs: overtureCategoryIDs,
					center: { lat: center.lat, lon: center.lon },
				})

				return { status: "success", hits, centerName: center.name }
			} catch {
				// Any failure past anchor resolution (byte-range fetch, worker init, a still-propagating R2
				// upload) reads as the layer being unreachable — never a silent zero-result list.
				return { status: "unavailable" }
			}
		},
		[sqljsBaseURL]
	)

	return <ReactPOIExplorer defaultText={defaultText} runLiveSearch={runLiveSearch} />
}
