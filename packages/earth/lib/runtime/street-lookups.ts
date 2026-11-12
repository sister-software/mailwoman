// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The street tier's per-region extracts, opened by byte ranges for situs and interpolation reads.
 */

import { allKeyed } from "@mailwoman/core/promises"
import type { HTTPVFSAddressPointLookup, HTTPVFSInterpolator } from "@mailwoman/resolver-wof-wasm/httpvfs/street"
import { NATIONAL_STREET_SLUGS, streetExtractURL } from "mailwoman/browser-runtime/resources"

/**
 * One region's street lookups, opened together.
 *
 * A national (country) extract has no interpolation table.
 */
export interface StreetLookups {
	situs: HTTPVFSAddressPointLookup
	interp: HTTPVFSInterpolator | null
	/**
	 * Ends the range workers behind both lookups.
	 */
	close(): void
}

/**
 * The count of street extracts Earth holds open at once.
 *
 * Each extract holds one or two range workers.
 * Each worker keeps its own sqlite-wasm heap and a chunk cache of up to 64 MiB.
 *
 * Two covers a session that moves between neighboring states.
 * Raise it if switching regions shows repeated reopen fetches.
 */
export const OPEN_STREET_EXTRACT_LIMIT = 2

/**
 * Opens the situs extract for `slug`, and its interpolation extract when the region has one.
 *
 * When one of the pair fails to open, the other is closed before the error propagates,
 * so a retry doesn't leave an orphaned worker behind.
 */
export async function openStreetLookups(slug: string, sqliteRuntimeBaseURL: string): Promise<StreetLookups> {
	const {
		database: { openRangeDatabase },
		street: { HTTPVFSAddressPointLookup, HTTPVFSInterpolator },
	} = await allKeyed({
		database: import("@mailwoman/resolver-wof-wasm/httpvfs/database"),
		street: import("@mailwoman/resolver-wof-wasm/httpvfs/street"),
	})

	if (NATIONAL_STREET_SLUGS.has(slug)) {
		const situsDB = await openRangeDatabase(streetExtractURL(slug, "situs"), sqliteRuntimeBaseURL)

		return {
			situs: new HTTPVFSAddressPointLookup(situsDB, { streetLocale: slug as "fr" }),
			interp: null,
			close: () => situsDB.close?.(),
		}
	}

	const [situs, interp] = await Promise.allSettled([
		openRangeDatabase(streetExtractURL(slug, "situs"), sqliteRuntimeBaseURL),
		openRangeDatabase(streetExtractURL(slug, "interp"), sqliteRuntimeBaseURL),
	])

	if (situs.status === "rejected" || interp.status === "rejected") {
		if (situs.status === "fulfilled") {
			situs.value.close?.()
		}

		if (interp.status === "fulfilled") {
			interp.value.close?.()
		}

		throw situs.status === "rejected" ? situs.reason : (interp as PromiseRejectedResult).reason
	}

	return {
		situs: new HTTPVFSAddressPointLookup(situs.value),
		interp: new HTTPVFSInterpolator(interp.value),
		close: () => {
			situs.value.close?.()
			interp.value.close?.()
		},
	}
}
