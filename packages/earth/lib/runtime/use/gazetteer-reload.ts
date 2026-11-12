// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Reopening the gazetteer by itself, as the Developer sheet's "Reload gazetteer" does,
 *   while the loaded classifier stays in place.
 */

import type { ReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { openGazetteerLookup } from "mailwoman/browser-runtime/load-assets"
import { useCallback } from "react"

/**
 * Returns a function that reopens the gazetteer and swaps it into the live bundle through
 * `updateAssets`, or `null` when the selected release ships no gazetteer.
 *
 * A failed reopen leaves `lookup` null and records the reason in `gazetteerError`.
 */
export function useGazetteerReload(
	releaseHasGazetteer: boolean,
	sqliteRuntimeBaseURL: string,
	updateAssets: (update: (assets: ReleaseAssets) => ReleaseAssets) => void
): (() => Promise<void>) | null {
	const reload = useCallback(async (): Promise<void> => {
		try {
			const lookup = await openGazetteerLookup(sqliteRuntimeBaseURL)

			updateAssets((assets) => ({ ...assets, lookup, gazetteerError: null }))
		} catch (error) {
			const gazetteerError = error instanceof Error ? error.message : String(error)

			updateAssets((assets) => ({ ...assets, lookup: null, gazetteerError }))
		}
	}, [sqliteRuntimeBaseURL, updateAssets])

	return releaseHasGazetteer ? reload : null
}
