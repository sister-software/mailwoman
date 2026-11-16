// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The plus-code (Open Location Code) result override — the last step of a geocode,
 *   after every resolve tier.
 *
 *   See {@link applyPlusCodeOverride} for the interface.
 *   The decoder itself lives in `@mailwoman/spatial` (pure arithmetic, officially-vectored),
 *   and the token is found by the `spatial` family of `@mailwoman/recognize`,
 *   which owns the alphabet, the separator and the digit counts.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { collectNodes, firstNodeWhere, slotNodes } from "@mailwoman/core/decoder"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { createRecognizer } from "@mailwoman/recognize"
import { SpatialKind, spatial } from "@mailwoman/recognize/spatial"
import type { Validated } from "@mailwoman/recognize/types"
import { cellRadiusMeters, decodePlusCode, recoverNearestPlusCode } from "@mailwoman/spatial"

import { epistemicStatusFor } from "#geocode/epistemic-status"

/**
 * The recognizer the override reads a geocode input with.
 *
 * It composes the `spatial` family only and doesn't share the pipeline's recognizer
 * (`computeQueryShape`, which composes `structure` and the postcode formats).
 * The override reads only plus codes, and the pipeline's recognizer reads none.
 *
 * A recognizer searches only its own families, so adding `spatial` to the pipeline's
 * would make every parse pay for a search that no parse reads.
 * Both recognizers share the one engine instance, so this one adds the family's
 * artifact and no second engine.
 */
const recognizer = createRecognizer([spatial])

/**
 * A plus-code token is the first plus code the override finds in an input.
 *
 * `code` is the upper-cased token.
 * `decodable` holds the validated payload.
 *
 * It is `null` for a token the validator rejected for an odd count of digits before the separator.
 */
interface PlusCodeToken {
	readonly code: string
	readonly decodable:
		| { readonly full: true; readonly code: Validated.FullPlusCode }
		| { readonly full: false; readonly code: Validated.ShortPlusCode }
		| null
}

/**
 * The first plus-code token anywhere in the input, in text order.
 *
 * The override reads rejected candidates as well as validated ones, on purpose.
 * A token with 3, 5 or 7 digits before the `+` is rejected with `invalid_prefix_length`.
 *
 * It has no cell to decode.
 * It is still a plus code and not a component, so it leaves the parse.
 *
 * Every other rejection code marks a text that isn't a plus code.
 * The grammar admits two to eight digits before the separator and two or three
 * after it, so the validator can reject only the prefix length.
 *
 * The engine bounds a token by any character other than a letter, a digit or a connector.
 * A token such as `(VFQ6+92P)` is found where white space or a comma was once required.
 */
function findPlusCodeToken(input: string): PlusCodeToken | null {
	for (const recognition of recognizer.recognize(input).recognitions) {
		if (recognition.kind !== SpatialKind.PlusCodeToken) continue

		const { validation } = recognition
		const code = recognition.text.toUpperCase()

		if (validation.status === "validated") {
			const { full_code, short_code } = validation.payload

			if (full_code != null) return { code, decodable: { full: true, code: full_code } }

			if (short_code != null) return { code, decodable: { full: false, code: short_code } }

			throw new RangeError("a validated plus code holds neither a full code nor a short code")
		}

		if (validation.status === "rejected" && validation.rejection.code === "invalid_prefix_length") {
			return { code, decodable: null }
		}
	}

	return null
}

/**
 * Plus-code override: when the query contains an Open Location Code,
 * the code is the user's most precise claim.
 *
 * Google prints these on every place card.
 * They serve as addresses in sparse-addressing countries, including the Nicaraguan board rows.
 *
 * A full code decodes directly.
 * A short code recovers against the coordinate the rest of the address resolved to
 * (the locality/admin answer — which is why this runs last, after every resolve tier).
 *
 * The parse typically mislabels the code (`street: "VFQ6+92P"`), which is
 * irrelevant here: the override replaces the coordinate claim, tier `plus_code`,
 * uncertainty priced at the decoded cell's half-diagonal.
 *
 * A short code with no resolved reference stays an abstention.
 * A cell modulo 20° isn't an answer.
 */
export function applyPlusCodeOverride(result: GeocodeResult, input: string, resolved: AddressTree): void {
	const token = findPlusCodeToken(input)

	if (!token) return

	evictCodeFromComponents(result, resolved, token.code)

	// A token the validator rejected is evicted above and has no cell to decode.
	if (!token.decodable) return

	// The short-code reference must be locality-grade: recovery needs a point within half a
	// prefix-resolution (0.5 degrees for the common 4-digit short form) of the true cell.
	// The blended result coordinate can be poisoned by a ZIP-lookalike postcode
	// ('Managua 11001' answered a Floral Park NY point) or a coarse admin centroid
	// (Ulaanbaatar's reference arrived ~2 degrees off) — both measured recovering
	// into the wrong degree cell with perfect fractions.
	// The resolved locality node is the reference the code was shortened against.
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

	const { decodable } = token

	const cell = decodable.full
		? decodePlusCode(decodable.code)
		: reference
			? recoverNearestPlusCode(decodable.code, reference.lat, reference.lon)
			: null

	if (!cell) return

	result.lat = cell.lat
	result.lon = cell.lon
	result.resolution_tier = "plus_code"
	result.epistemic_status = epistemicStatusFor("plus_code", result.lat)
	result.coordinate_source = null
	result.uncertainty_m = cellRadiusMeters(cell)
}

/**
 * The component slots the parse can use for a plus-code token.
 */
const COMPONENT_SLOTS = new Set([
	"locality",
	"region",
	"postcode",
	"house_number",
	"street",
	"venue",
	"dependent_locality",
	"unit",
] as const)

type ComponentSlot = typeof COMPONENT_SLOTS extends Set<infer T> ? T : never

/**
 * A plus code is a coordinate claim and never a component, whatever tag the parse gave it.
 *
 * Evict the token from every slot it landed in and let the next span of that tag
 * take the slot, in the same `slotNodes` order the projections read: grounded first,
 * then text order for an administrative rung and label confidence for every other tag.
 * `Simpson's Field, 5G8H+8F5, Douglas, Isle of Man IM2 4RE, Isle of Man` parses the code as
 * `postcode`; without this the row's postcode was the code and `IM2 4RE` was the dropped span.
 *
 * Runs whether or not the code decodes: a short code with no reference is still not a postcode.
 */
function evictCodeFromComponents(result: GeocodeResult, tree: AddressTree, token: string): void {
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

		if (current && isCode(current)) {
			if (replacement) {
				components[tag] = replacement
			} else {
				Reflect.deleteProperty(components, tag)
			}
		}

		if (COMPONENT_SLOTS.has(tag as ComponentSlot)) {
			const slot = tag as ComponentSlot

			if (result[slot] && isCode(result[slot]!)) {
				result[slot] = replacement
			}
		}
	}
}
