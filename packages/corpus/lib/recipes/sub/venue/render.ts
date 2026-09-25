/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Renders labelled pieces into sub-venue rows in a sampled case register and a per-country address order.
 */

import { layoutForCountry } from "@mailwoman/codex/address-layouts"
import { type ComponentDict, renderAddress } from "@mailwoman/codex/address-render"
import type { ComponentTag } from "@mailwoman/codex/component"
import { isPresent } from "@mailwoman/core/objects"

import type { LocaleBaseTuple } from "#surfaces/locale"

/**
 * One labelled piece of a row.
 *
 * Pieces inside a group are joined with a space, and groups are joined with the register's separator.
 */
export interface Piece {
	text: string
	tag?: ComponentTag
}

/**
 * A run of pieces that share one comma segment.
 */
export type Group = Piece[]

/**
 * The case and punctuation style of a rendered row.
 *
 * Users often type addresses in lowercase, so every recipe output includes lowercase rows.
 */
export const Register = {
	Canonical: "canonical",
	CommaFree: "comma-free",
	Lower: "lower",
	Upper: "upper",
} as const

/**
 * One of the {@link Register} values.
 */
export type Register = (typeof Register)[keyof typeof Register]

// The cutoffs are cumulative: 45% canonical, 20% comma-free, 25% lower and 10% upper.
const CANONICAL_REGISTER_CUTOFF = 0.45
const COMMA_FREE_REGISTER_CUTOFF = 0.65
const LOWER_REGISTER_CUTOFF = 0.9

/**
 * Samples a register with the fixed shares above.
 */
export function sampleRegister(random: () => number): Register {
	const r = random()

	if (r < CANONICAL_REGISTER_CUTOFF) return Register.Canonical

	if (r < COMMA_FREE_REGISTER_CUTOFF) return Register.CommaFree

	if (r < LOWER_REGISTER_CUTOFF) return Register.Lower

	return Register.Upper
}

/**
 * Joins groups into `raw` and `components`.
 *
 * The register's case change applies to both so that alignment still finds every component value in `raw`.
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
 * Layout connectors that end a group.
 */
const GROUP_BREAK = new Set([", ", "\n"])

/**
 * Returns the street and locality groups for a country in the order of its codex address layout.
 *
 * The function splits the rendered layout at comma and line-break connectors.
 * It returns an empty list when codex has no Latin-script layout for the country.
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
