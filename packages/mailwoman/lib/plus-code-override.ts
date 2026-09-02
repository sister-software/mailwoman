/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The plus-code (Open Location Code) result override — the LAST step of a geocode, after every
 *   resolve tier. See {@link applyPlusCodeOverride} for the contract; the decoder itself lives in
 *   `@mailwoman/spatial` (pure arithmetic, officially-vectored).
 */

import type { GeocodeOutcomeLike } from "@mailwoman/api"
import type { AddressTree } from "@mailwoman/core/decoder"
import { firstNodeWhere } from "@mailwoman/core/decoder"
import { decodePlusCode, isFullPlusCode, recoverNearestPlusCode } from "@mailwoman/spatial"

/**
 * A plus-code token anywhere in the input: `VFQ6+92P` (short) or `764MVFQ6+92P` (full). The digit alphabet excludes
 * every vowel-like letter, so an ordinary word cannot match; the boundary guard keeps the token from being split out of
 * a longer alphanumeric run.
 */
const PLUS_CODE_TOKEN = /(?:^|[\s,])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3})(?=[\s,]|$)/i

/**
 * Plus-code override: when the query carries an Open Location Code, the code IS the user's most precise claim — Google
 * prints these on every place card, and in sparse-addressing countries they are the address (the Nicaraguan board
 * rows). A FULL code decodes directly; a SHORT code recovers against the coordinate the rest of the address resolved to
 * (the locality/admin answer — which is why this runs LAST, after every resolve tier). The parse typically mislabels
 * the code (`street: "VFQ6+92P"`), which does not matter here: the override replaces the coordinate claim, tier
 * `plus_code`, uncertainty priced at the decoded cell's half-diagonal. A short code with no resolved reference stays an
 * abstention — a cell modulo 20° is not an answer.
 */
export function applyPlusCodeOverride(result: GeocodeOutcomeLike, input: string, resolved: AddressTree): void {
	const token = PLUS_CODE_TOKEN.exec(input)?.[1]

	if (!token) return
	const upper = token.toUpperCase()

	// The short-code reference must be LOCALITY-grade: recovery needs a point within half a
	// prefix-resolution (0.5 degrees for the common 4-digit short form) of the true cell, and the
	// blended result coordinate can be poisoned by a ZIP-lookalike postcode ('Managua 11001'
	// answered a Floral Park NY point) or a coarse admin centroid (Ulaanbaatar's reference arrived
	// ~2 degrees off) — both measured recovering into the wrong degree cell with perfect fractions.
	// The resolved locality NODE is the reference the code was shortened against.
	const referenceNode = firstNodeWhere(
		resolved.roots,
		(n) => (n.tag === "locality" || n.tag === "dependent_locality") && n.lat != null && n.lon != null
	)

	let reference: { lat: number; lon: number } | null = referenceNode
		? { lat: referenceNode.lat!, lon: referenceNode.lon! }
		: null

	if (!reference && result.lat != null && result.lon != null) {
		reference = { lat: result.lat, lon: result.lon }
	}

	const cell = isFullPlusCode(upper)
		? decodePlusCode(upper)
		: reference
			? recoverNearestPlusCode(upper, reference.lat, reference.lon)
			: null

	if (!cell) return

	const latHalfM = (cell.latSpanDeg / 2) * 111_320
	const lonHalfM = (cell.lonSpanDeg / 2) * 111_320 * Math.cos((cell.lat * Math.PI) / 180)

	result.lat = cell.lat
	result.lon = cell.lon
	result.resolution_tier = "plus_code"
	result.uncertainty_m = Math.max(1, Math.round(Math.hypot(latHalfM, lonHalfM)))
}
