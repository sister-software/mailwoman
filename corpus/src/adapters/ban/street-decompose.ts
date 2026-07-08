/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decompose a French street name into Stage 3 components. French convention puts the street type as
 *   a leading word: "Rue de Rivoli", "Avenue des Champs-Élysées", "Bd Voltaire".
 *
 *   The street type becomes street_prefix in our schema. The remaining tokens form the street name.
 *
 *   Examples: "Rue de Rivoli" → { prefix: "Rue", street: "de Rivoli" } "Avenue des Champs-Élysées" →
 *   { prefix: "Avenue", street: "des Champs-Élysées" } "Boulevard Voltaire" → { prefix:
 *   "Boulevard", street: "Voltaire" }
 *
 *   Sources street types from `core/data/libpostal/dictionaries/fr/street_types.txt`.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { resourceDictionaryPathBuilder } from "@mailwoman/core/utils"

function loadDictionary(filename: string): Set<string> {
	const candidates = [
		String(resourceDictionaryPathBuilder("libpostal", "fr", filename)),
		String(resourceDictionaryPathBuilder("libpostal", "fr", filename)),
		resolve(process.cwd(), "core/data/libpostal/dictionaries/fr", filename),
	]

	for (const path of candidates) {
		try {
			const text = readFileSync(path, "utf8")
			const set = new Set<string>()

			for (const line of text.split("\n")) {
				const trimmed = line.trim()

				if (!trimmed || trimmed.startsWith("#")) continue

				for (const form of trimmed.split("|")) {
					const f = form.trim().toLowerCase()

					if (f) {
						set.add(f)
					}
				}
			}

			return set
		} catch {
			// try next
		}
	}
	throw new Error(`Could not load FR libpostal dictionary: ${filename}`)
}

const STREET_TYPES_FR = loadDictionary("street_types.txt")

export interface DecomposedFrStreet {
	prefix: string | null
	street: string
}

/**
 * Decompose a French street name into prefix (leading type word) and street name.
 *
 * If the first 1-2 tokens match a known street type (allowing for multi-word like "ancien chemin"), they become the
 * prefix. Returns `{ prefix: null, street: original }` if no match.
 */
export function decomposeFrStreet(fullname: string): DecomposedFrStreet {
	const trimmed = fullname.trim()

	if (!trimmed) return { prefix: null, street: "" }

	const tokens = trimmed.split(/\s+/)

	if (tokens.length < 2) return { prefix: null, street: trimmed }

	const norm = (s: string) => s.toLowerCase().replace(/[.,;]$/, "")

	// Try 2-word prefix first (e.g. "ancien chemin")
	if (tokens.length >= 3) {
		const twoWord = norm(tokens[0]!) + " " + norm(tokens[1]!)

		if (STREET_TYPES_FR.has(twoWord)) {
			return { prefix: tokens.slice(0, 2).join(" "), street: tokens.slice(2).join(" ") }
		}
	}

	// Then try 1-word prefix
	const first = norm(tokens[0]!)

	if (STREET_TYPES_FR.has(first)) {
		return { prefix: tokens[0]!, street: tokens.slice(1).join(" ") }
	}

	return { prefix: null, street: trimmed }
}
