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
import { collectNodes, firstNodeWhere, slotNodes } from "@mailwoman/core/decoder"
import { decodePlusCode, isFullPlusCode, recoverNearestPlusCode } from "@mailwoman/spatial"

import { epistemicStatusFor } from "#geocode/epistemic-status"

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

	if (token) {
		evictCodeFromComponents(result, resolved, token)
	}

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
	result.epistemic_status = epistemicStatusFor("plus_code", result.lat)
	result.uncertainty_m = Math.max(1, Math.round(Math.hypot(latHalfM, lonHalfM)))
}

/**
 * The named component slots the parse can put a plus-code token into.
 */
const COMPONENT_SLOTS = [
	"locality",
	"region",
	"postcode",
	"house_number",
	"street",
	"venue",
	"dependent_locality",
	"unit",
] as const

/**
 * A plus code is a coordinate claim and never a component, whatever tag the parse gave it. Evict the token from every
 * slot it landed in and let the next span of that tag — grounded first, then text order, the same `slotNodes` order the
 * projections read — take the slot. `Simpson's Field, 5G8H+8F5, Douglas, Isle of Man IM2 4RE, Isle of Man` parses the
 * code as `postcode`; without this the row's postcode was the code and `IM2 4RE` was the dropped span. Runs whether or
 * not the code decodes: a short code with no reference is still not a postcode.
 */
function evictCodeFromComponents(result: GeocodeOutcomeLike, tree: AddressTree, token: string): void {
	const upper = token.toUpperCase()
	const isCode = (value: string): boolean => value.trim().toUpperCase() === upper
	const components = result.components as Partial<Record<string, string>>

	for (const node of collectNodes(tree.roots, (n) => isCode(n.value))) {
		const tag = node.tag
		const current = components[tag]

		const replacement =
			slotNodes(tree.roots)
				.find((n) => n.tag === tag && !isCode(n.value))
				?.value.trim() || null

		if (current !== undefined && isCode(current)) {
			if (replacement) {
				components[tag] = replacement
			} else {
				Reflect.deleteProperty(components, tag)
			}
		}

		if ((COMPONENT_SLOTS as readonly string[]).includes(tag)) {
			const slot = tag as (typeof COMPONENT_SLOTS)[number]

			if (result[slot] !== null && isCode(result[slot]!)) {
				result[slot] = replacement
			}
		}
	}
}
