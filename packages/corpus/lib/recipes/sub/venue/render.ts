/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file How the sub-venue recipe turns labelled pieces into a line: the register it samples, the join that keeps
 *   `raw` and `components` in step, and the per-country address order it takes from codex.
 */

import { layoutForCountry } from "@mailwoman/codex/address-layouts"
import { type ComponentDict, renderAddress } from "@mailwoman/codex/address-render"
import type { ComponentTag } from "@mailwoman/codex/component"
import { isPresent } from "@mailwoman/core/objects"

import type { LocaleBaseTuple } from "#synthesizers/locale"

/**
 * One labelled piece of the line.
 *
 * Pieces inside a group are space-joined. groups are joined by the register's separator.
 */
export interface Piece {
	text: string
	tag?: ComponentTag
}

export type Group = Piece[]

/**
 * Surface register.
 *
 * Every eval in this repo gets a lowercase leg because lowercase is the register users type —
 * Google Maps taught them — so every recipe output has to carry one.
 */
export const Register = {
	Canonical: "canonical",
	CommaFree: "comma-free",
	Lower: "lower",
	Upper: "upper",
} as const

export type Register = (typeof Register)[keyof typeof Register]

// Registers: 45% canonical, 20% comma-free, 25% lower, 10% upper.
const CANONICAL_REGISTER_CUTOFF = 0.45
const COMMA_FREE_REGISTER_CUTOFF = 0.65
const LOWER_REGISTER_CUTOFF = 0.9

export function sampleRegister(random: () => number): Register {
	const r = random()

	if (r < CANONICAL_REGISTER_CUTOFF) return Register.Canonical

	if (r < COMMA_FREE_REGISTER_CUTOFF) return Register.CommaFree

	if (r < LOWER_REGISTER_CUTOFF) return Register.Lower

	return Register.Upper
}

/**
 * Join groups into `raw` + `components`, applying the register to both so alignment still finds every value.
 */
export function renderGroups(
	groups: Group[],
	register: Register
): { raw: string; components: Partial<Record<ComponentTag, string>> } {
	const fold = (text: string): string => {
		if (register === Register.Lower) return text.toLowerCase()

		if (register === Register.Upper) return text.toUpperCase()

		return text
	}

	const separator = register === Register.CommaFree ? " " : ", "

	const raw = groups
		.map((group) => group.map((piece) => fold(piece.text)).join(" "))
		.filter(isPresent)
		.join(separator)

	const components: Partial<Record<ComponentTag, string>> = {}

	for (const group of groups) {
		for (const piece of group) {
			if (piece.tag && !components[piece.tag]) {
				components[piece.tag] = fold(piece.text)
			}
		}
	}

	return { raw, components }
}

/**
 * A layout connector that ends a comma segment. {@link renderGroups} joins pieces inside a group with
 * a space and groups with `", "`, which is the same division a layout draws with these two connectors.
 */
const GROUP_BREAK = new Set([", ", "\n"])

/**
 * The street + tail groups for a country, in that country's own order, taken from that country's layout.
 *
 * The orders were restated here once — US and GB anglophone, everything else
 * postcode-then-locality — and the `else` caught Japan, Korea and Taiwan along with France.
 * `@mailwoman/codex` holds the order per country as data and `renderAddress` evaluates it,
 * returning a tagged piece per component with the connectors between them, so the groups
 * this recipe needs are that piece list cut at its comma and line breaks.
 *
 * Answers an empty list when no layout names the country: 55 of the 252 shipped records carry no
 * usable skeleton, and a row for one of those is absent rather than written in an order nobody uses.
 */
export function addressGroups(country: string, tuple: LocaleBaseTuple, withStreet: boolean): Group[] {
	const components: ComponentDict = {}
	const street = tuple.street.trim()
	const houseNumber = tuple.house_number?.trim()

	if (withStreet && street) {
		components.street = street

		if (houseNumber) {
			components.house_number = houseNumber
		}
	}

	const locality = tuple.locality.trim()
	const postcode = tuple.postcode?.trim()
	const region = tuple.region?.trim()

	if (locality) {
		components.locality = locality
	}

	if (postcode) {
		components.postcode = postcode
	}

	if (region) {
		components.region = region
	}

	const layout = layoutForCountry(country, "latin")

	if (!layout) return []

	const groups: Group[] = []
	let current: Group = []

	for (const piece of renderAddress(layout, components).pieces) {
		if (piece.tag === null) {
			if (GROUP_BREAK.has(piece.text) && current.length) {
				groups.push(current)
				current = []
			}

			continue
		}

		current.push({ text: piece.text, tag: piece.tag })
	}

	if (current.length) {
		groups.push(current)
	}

	return groups
}
