/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Resolves a textual locality anchor to a POI-search center.
 */

import { isUSStateAbbreviation } from "@mailwoman/codex/us"

import { loadHTTPVFSDatabase, WOFCandidateTableLookup } from "#httpvfs/resolver"

type CandidateHTTPVFSWorker = Awaited<ReturnType<typeof loadHTTPVFSDatabase>>

// MARK: Anchor → center resolution (no neural runtime)

let candidateWorkerPromise: Promise<CandidateHTTPVFSWorker> | undefined

/**
 * Lazily open (once, shared across calls) the ADMIN CANDIDATE gazetteer worker used only for anchor→center resolution.
 * Independent of the POI-layer worker — a separate byte-ranged DB, the same one `/demo`'s cascade resolves localities
 * against ({@link WOFCandidateTableLookup}).
 */
function loadCandidateWorker(gazetteerURL: string, sqljsBaseURL: string): Promise<CandidateHTTPVFSWorker> {
	if (!candidateWorkerPromise) {
		candidateWorkerPromise = loadHTTPVFSDatabase(gazetteerURL, sqljsBaseURL).catch((error: unknown) => {
			candidateWorkerPromise = undefined
			throw error
		})
	}

	return candidateWorkerPromise
}

export interface AnchorCenter {
	lat: number
	lon: number
	/**
	 * The resolved place's canonical name — surfaced so the UI can show what "Springfield" resolved to.
	 */
	name: string
}

/**
 * Split an anchor string into a locality + an optional region qualifier, WITHOUT a neural parse. Two forms: a comma
 * ("Springfield, IL") splits there; otherwise a trailing US state abbreviation token ("Springfield IL" — the common
 * comma-less form) splits on whitespace. Anything else is treated as a bare locality name — no disambiguation region,
 * population-first candidate ranking wins (which is exactly the ambiguity a query like "Springfield" alone has: this
 * tester makes no claim to resolve it "correctly", only consistently with the `/demo` cascade's default).
 */
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
 * Resolve an anchor string ("Springfield", "Springfield, IL", or "Springfield IL") to a center point against the admin
 * candidate gazetteer — no neural runtime, no full-address parse. When a region qualifier splits off (see
 * {@link splitAnchor}) it's resolved FIRST (for its bbox), then the locality lookup is point-in-bbox-constrained by it,
 * the same disambiguation the `/demo` cascade uses. Returns `null` when nothing resolves — callers show "couldn't place
 * '<anchor>'" rather than silently defaulting to zero results.
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
