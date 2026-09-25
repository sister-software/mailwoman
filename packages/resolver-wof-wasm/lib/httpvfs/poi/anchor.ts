/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us"

import { loadHTTPVFSDatabase, WOFCandidateTableLookup } from "#httpvfs/resolver"

type CandidateHTTPVFSWorker = Awaited<ReturnType<typeof loadHTTPVFSDatabase>>

let candidateWorkerPromise: Promise<CandidateHTTPVFSWorker> | undefined

function loadCandidateWorker(gazetteerURL: string, sqljsBaseURL: string): Promise<CandidateHTTPVFSWorker> {
	if (!candidateWorkerPromise) {
		candidateWorkerPromise = loadHTTPVFSDatabase(gazetteerURL, sqljsBaseURL).catch((error: unknown) => {
			candidateWorkerPromise = undefined
			throw error
		})
	}

	return candidateWorkerPromise
}

/**
 * Describes the locality that {@link resolveAnchorCenter} placed an anchor at, by its centroid and name.
 */
export interface AnchorCenter {
	lat: number
	lon: number

	/**
	 * The resolved locality's canonical name, so a UI can show what the anchor text resolved to.
	 */
	name: string
}

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
 * Resolves an anchor such as "Springfield, IL" to a locality center point using
 * only the admin candidate gazetteer.
 *
 * A region qualifier, after a comma or as a trailing US state code,
 * limits the search to that region's bounding box.
 *
 * @returns `null` when no place resolves.
 */
export async function resolveAnchorCenter(
	gazetteerURL: string,
	sqljsBaseURL: string,
	anchorText: string
): Promise<AnchorCenter | null> {
	const trimmed = anchorText.trim()

	if (!trimmed) return null

	const worker = await loadCandidateWorker(gazetteerURL, sqljsBaseURL)
	const lookup = new WOFCandidateTableLookup(worker)

	const { localityText, regionText } = splitAnchor(trimmed)

	let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined

	if (regionText) {
		const regionHits = await lookup.findPlace({ text: regionText, placetype: "region", limit: 1 })

		bbox = regionHits[0]?.bbox
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
