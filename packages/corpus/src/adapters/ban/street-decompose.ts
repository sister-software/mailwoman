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

import { resourceDictionaryPath } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"

/**
 * Tokens a BAN street needs before a type/article/name decomposition is attempted.
 */
const MIN_TOKENS_FOR_DECOMPOSE = 3

function loadDictionary(filename: string): Set<string> {
	// `resourceDictionaryPath` already resolves both layouts — `core/data/...` from source and from the
	// packaged `out/` tree. The candidate list this replaced named it TWICE and then guessed a third path
	// off `process.cwd()`, and swallowed every error while probing, so a corrupt dictionary reported as a
	// missing one.
	const text = readFileSync(resourceDictionaryPath("libpostal", "fr", filename), "utf8")
	const set = new Set<string>()

	// The largest libpostal dictionary is 8.4 KB, and this runs once per process at module load.
	for (const line of TextSpliterator.from(text)) {
		const trimmed = line.trim()

		if (!trimmed || trimmed.startsWith("#")) continue

		// libpostal format: canonical|abbr|abbr|... — index all forms
		for (const form of trimmed.split("|")) {
			const f = form.trim().toLowerCase()

			if (f) {
				set.add(f)
			}
		}
	}

	return set
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
	if (tokens.length >= MIN_TOKENS_FOR_DECOMPOSE) {
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
