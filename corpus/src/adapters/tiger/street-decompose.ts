/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Decompose a US street name into Stage 3 components: street_prefix, street, street_suffix.
 *
 *   Sources directionals and street types from the curated libpostal/en dictionaries
 *   (`core/data/libpostal/dictionaries/en/{directionals,street_types}.txt`). These are the same
 *   dictionaries the runtime classifiers (StreetPrefixClassifier, StreetSuffixClassifier) use, so
 *   corpus labels and runtime classifications agree on the vocabulary.
 *
 *   Examples: "N Main St" → { prefix: "N", street: "Main", suffix: "St" } "Pennsylvania Avenue NW" →
 *   { prefix: null, street: "Pennsylvania", suffix: "Avenue NW" } "Salmon St" → { prefix: null,
 *   street: "Salmon", suffix: "St" } "SE Hawthorne Blvd" → { prefix: "SE", street: "Hawthorne",
 *   suffix: "Blvd" }
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const moduleDir = dirname(fileURLToPath(import.meta.url))

function loadDictionary(filename: string): Set<string> {
	// Resolve via the @mailwoman/core data directory.
	const candidates = [
		resolve(moduleDir, "../../../../core/data/libpostal/dictionaries/en", filename),
		resolve(moduleDir, "../../../../../core/data/libpostal/dictionaries/en", filename),
		resolve(process.cwd(), "core/data/libpostal/dictionaries/en", filename),
	]

	for (const path of candidates) {
		try {
			const text = readFileSync(path, "utf8")
			const set = new Set<string>()

			for (const line of text.split("\n")) {
				const trimmed = line.trim()

				if (!trimmed || trimmed.startsWith("#")) continue

				// libpostal format: canonical|abbr|abbr|... — index all forms
				for (const form of trimmed.split("|")) {
					const f = form.trim().toLowerCase()

					if (f) set.add(f)
				}
			}

			return set
		} catch {
			// try next candidate
		}
	}
	throw new Error(`Could not load libpostal dictionary: ${filename}`)
}

const DIRECTIONALS = loadDictionary("directionals.txt")
const STREET_TYPES = loadDictionary("street_types.txt")

export interface DecomposedStreet {
	prefix: string | null
	street: string
	suffix: string | null
}

/**
 * Decompose a US street name into prefix/name/suffix components.
 *
 * Conservative — only emits prefix/suffix when there's a clear directional or street-type keyword. Returns the original
 * as `street` if nothing matches.
 */
export function decomposeStreet(fullname: string): DecomposedStreet {
	const trimmed = fullname.trim()

	if (!trimmed) return { prefix: null, street: "", suffix: null }

	const tokens = trimmed.split(/\s+/)

	if (tokens.length === 1) return { prefix: null, street: trimmed, suffix: null }

	const norm = (s: string) => s.toLowerCase().replace(/\.$/, "")

	let prefix: string | null = null
	let suffix: string | null = null
	let startIdx = 0
	let endIdx = tokens.length

	// Leading directional prefix
	if (DIRECTIONALS.has(norm(tokens[0]!)) && tokens.length >= 2) {
		prefix = tokens[0]!
		startIdx = 1
	}

	// Trailing post-directional combined with street type (e.g. "Pennsylvania Ave NW")
	const last = norm(tokens[endIdx - 1]!)
	const secondLast = endIdx >= 2 ? norm(tokens[endIdx - 2]!) : ""

	if (DIRECTIONALS.has(last) && STREET_TYPES.has(secondLast)) {
		suffix = tokens.slice(endIdx - 2, endIdx).join(" ")
		endIdx -= 2
	} else if (STREET_TYPES.has(last) && endIdx - startIdx >= 2) {
		suffix = tokens[endIdx - 1]!
		endIdx -= 1
	} else if (DIRECTIONALS.has(last) && endIdx - startIdx >= 2) {
		// Post-directional without type
		suffix = tokens[endIdx - 1]!
		endIdx -= 1
	}

	const street = tokens.slice(startIdx, endIdx).join(" ").trim()

	if (!street) {
		return { prefix: null, street: trimmed, suffix: null }
	}

	return { prefix, street, suffix }
}
