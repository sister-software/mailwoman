/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Reads address context and derives street-side negatives for the sub-venue recipe.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { mulberry32 as makeMulberry32 } from "@mailwoman/core/utils"
import type { PathBuilderLike } from "path-ts"

import { readTuples as readLocaleTuples, type LocalePart } from "#international/recipes/locale"
import { readTuples as readSliceTuples } from "#recipes/scaffold"
import type { LocaleBaseTuple } from "#synthesizers/locale"

//#region Address context

/**
 * DE + ES address context. Both read through {@link readLocaleTuples}, the `locale` recipe's own streaming + reservoir
 * reader, so the CSV handling (quoted fields, CRLF, city-noise cleaning, the DE per-part region fallback) has exactly
 * one implementation.
 *
 * DE reads `europe.zip`'s two members rather than `oa-cache/de__*.zip`: the cached per-state zips the `locale` recipe
 * names are not materialized on this host, and the archive members are byte-identical to OA's current run (verified in
 * `corpus/AGENTS.md`'s "a file's mtime is not its data's vintage" note).
 */
const CONTEXT_PARTS: Readonly<Record<string, readonly LocalePart[]>> = {
	DE: [
		{ zip: dataRootPath("openaddresses", "europe.zip"), csv: "de/berlin.csv", region: "Berlin" },
		{ zip: dataRootPath("openaddresses", "europe.zip"), csv: "de/sn/statewide.csv", region: "Sachsen" },
	],
	ES: [{ path: dataRootPath("openaddresses", "extracted", "es", "countrywide.csv") }],
}

/**
 * Load the address skeletons every leg renders onto: GB / US / FR from the house-venue v3 tuples (the same 176,519 real
 * rows the `synth-house-venue` slice is built from, so the two slices' address halves are drawn from one pool), DE and
 * ES streamed out of OpenAddresses.
 */
export async function loadContextTuples(
	tuplesPath: PathBuilderLike,
	seed: number
): Promise<Map<string, LocaleBaseTuple[]>> {
	const byCountry = new Map<string, LocaleBaseTuple[]>()

	for await (const tuple of readSliceTuples(tuplesPath)) {
		const country = String(tuple.country ?? "")

		if (!country || !tuple.locality || !tuple.street) continue

		const mapped: LocaleBaseTuple = {
			house_number: String(tuple.houseNumber ?? tuple.house_number ?? ""),
			street: String(tuple.street),
			locality: String(tuple.locality),
			region: String(tuple.region ?? ""),
			postcode: String(tuple.postcode ?? ""),
		}

		const list = byCountry.get(country)

		if (list) {
			list.push(mapped)
		} else {
			byCountry.set(country, [mapped])
		}
	}

	for (const [country, parts] of Object.entries(CONTEXT_PARTS)) {
		if (byCountry.has(country)) continue
		const pooled: LocaleBaseTuple[] = []

		for (const [index, part] of parts.entries()) {
			// A dedicated stream PRNG, seeded per part, so the input sample is reproducible without
			// perturbing the emit loop's draws (the `locale` recipe's rule, kept).
			const streamRandom = makeMulberry32(seed + index)

			for (const tuple of await readLocaleTuples(part, streamRandom)) {
				pooled.push(tuple)
			}
		}

		byCountry.set(country, pooled)
	}

	return byCountry
}

/**
 * The street-side confound classes, mined from the leg's OWN address tuples.
 *
 * Real streets, not invented ones. The 176,519-row context pool carries 195 GB `hall` streets, 114 GB `gate` streets,
 * 134 distinct GB `-gate` single tokens and a two-figure `<modifier> <designator>` population in both GB and US — small
 * absolute numbers, but every one of them a street somebody lives on, which is the property an invented list cannot
 * have.
 */
export interface StreetNegatives {
	designator: LocaleBaseTuple[]
	modifierDesignator: LocaleBaseTuple[]
	gateSuffix: LocaleBaseTuple[]
}

/**
 * Shortest token that can carry a `-gate` street suffix and still be a NAME rather than the bare word: `gate` itself is
 * four characters, so the class starts at five (`Highgate`, `Moorgate`, `Stonegate`).
 */
const MIN_GATE_SUFFIX_TOKEN_LENGTH = 5

export function buildStreetNegatives(
	context: readonly LocaleBaseTuple[],
	designatorPhrases: readonly string[],
	modifiers: readonly string[],
	country: string
): StreetNegatives {
	const designatorSet = new Set(designatorPhrases)
	const modifierSet = new Set(modifiers)
	const designator: LocaleBaseTuple[] = []
	const modifierDesignator: LocaleBaseTuple[] = []
	const gateSuffix: LocaleBaseTuple[] = []

	for (const tuple of context) {
		const tokens = tuple.street.toLowerCase().match(/[\p{L}]+/gu) ?? []
		let isDesignator = false
		let isPair = false

		for (const [index, token] of tokens.entries()) {
			if (designatorSet.has(token)) {
				isDesignator = true
			}

			if (index + 1 < tokens.length && modifierSet.has(token) && designatorSet.has(tokens[index + 1]!)) {
				isPair = true
			}

			if (country === "GB" && token.length >= MIN_GATE_SUFFIX_TOKEN_LENGTH && token.endsWith("gate")) {
				gateSuffix.push(tuple)
			}
		}

		if (isPair) {
			modifierDesignator.push(tuple)
		} else if (isDesignator) {
			designator.push(tuple)
		}
	}

	return { designator, modifierDesignator, gateSuffix }
}

//#endregion
