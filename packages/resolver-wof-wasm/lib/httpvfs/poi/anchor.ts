/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us"
import type { NamedLatLon } from "@mailwoman/spatial"

import type { RangeDatabase } from "#httpvfs/database"
import { WOFCandidateTableLookup } from "#httpvfs/resolver"

function splitAnchor(text: string): { localityText: string; regionText?: string } {
	const commaIndex = text.indexOf(",")

	if (commaIndex !== -1) {
		return { localityText: text.slice(0, commaIndex).trim(), regionText: text.slice(commaIndex + 1).trim() }
	}

	const lastSpace = text.lastIndexOf(" ")

	if (lastSpace > 0) {
		const trailingToken = text.slice(lastSpace + 1).trim()

		if (isUSStateAbbreviation(trailingToken)) {
			return { localityText: text.slice(0, lastSpace).trim(), regionText: trailingToken }
		}
	}

	return { localityText: text }
}

/**
 * Resolves an anchor such as "Springfield, IL" to a locality center using
 * only the admin candidate gazetteer.
 * The caller opens that database with `openRangeDatabase`.
 *
 * @returns The locality's centroid and canonical name, so a UI can show what the
 * anchor text resolved to, or `null` when no place resolves.
 */
export async function resolveAnchorCenter(
	candidateDatabase: RangeDatabase,
	anchorText: string
): Promise<NamedLatLon | null> {
	const trimmed = anchorText.trim()

	if (!trimmed) return null

	const lookup = new WOFCandidateTableLookup(candidateDatabase)

	const { localityText, regionText } = splitAnchor(trimmed)

	let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null = null

	if (regionText) {
		const regionHits = await lookup.findPlace({ text: regionText, placetype: "region", limit: 1 })

		bbox = regionHits[0]?.bbox ?? null
	}

	if (!localityText) return null

	const localityHits = await lookup.findPlace({
		text: localityText,
		placetype: ["locality"],
		...(bbox ? { bbox } : {}),
		limit: 1,
	})

	const hit = localityHits[0]

	if (!hit) return null

	return { lat: hit.lat, lon: hit.lon, name: hit.name }
}
