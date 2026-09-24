/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Build a country-surface lexicon for the country soft-feed channel (#1104).
 *
 * This channel is a dictionary-style signal (not a grammar rule). It helps the
 * model spot country phrases like "United States of America" that can otherwise
 * be misread as street-like text.
 *
 * We reuse the gazetteer's phrase matcher and only change the vocabulary and
 * emitted feature. Each matched piece gets two bits:
 * - `country_surface` (bit 1): part of a known country surface.
 * - `country_ambiguous` (bit 2): a risky surface (for example, a US region
 *   homograph like "Georgia"/"IN", or common words like "America").
 *
 * Data source: `@mailwoman/codex` (`COUNTRY_SURFACE_FORMS` + `ISO2_TO_NAME`).
 *
 * Output: `data/gazetteer/country-surface-lexicon-v1.json`
 * Regenerate: `node packages/mailwoman/lib/dev-tools/codex/country/surface-lexicon.ts`
 */

import { COUNTRY_SURFACE_FORMS, ISO2_TO_NAME } from "@mailwoman/codex/country"
import { wordNorm, wordNormLower } from "@mailwoman/codex/normalize"
import { US_STATE_ABBREVIATIONS, US_STATE_NAMES } from "@mailwoman/codex/us/state"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { dirname } from "path-ts"

/**
 * Max ambiguous entries to print before truncating.
 */
const MAX_LISTED_AMBIGUOUS = 12

/**
 * Max letters for treating a token as a short code.
 */
const MAX_ABBREVIATION_LETTERS = 3

const BIT = { country_surface: 1, country_ambiguous: 2 }
const SLOTS = ["country_surface", "country_ambiguous"]

/**
 * Output path written by this script.
 */
const OUTPUT = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

/**
 * Shared normalization rule for entries and scanned tokens.
 *
 * For each whitespace word: strip non-letter/digit chars at the edges, keep internal
 * punctuation (like "u.s.a" or "timor-leste"), then rejoin.
 */
/**
 * Short alphabetic code (<= 3 letters after punctuation removal).
 * These are matched with exact uppercase keys.
 */
const isShortCode = (s: string): boolean => {
	const letters = s.replaceAll(/[^\p{L}]/gu, "")

	return letters.length > 0 && letters.length <= MAX_ABBREVIATION_LETTERS && /^[\p{L}.\s]+$/u.test(s)
}

// Single-word country names that also match US regions are ambiguous.
// Derived from codex US state tables.
const usStateNames = new Set(US_STATE_NAMES.map((n) => n.toLowerCase()))
const usStateAbbrevs = new Set<string>(US_STATE_ABBREVIATIONS as readonly string[])

/**
 * Curated single-token country surfaces that are common words.
 *
 * A surface in this set keeps its `country_surface` bit and also carries `country_ambiguous`.
 */
const COMMON_WORD_AMBIGUOUS = new Set(["america", "england", "britain", "turkey", "chad", "jordan", "jersey", "guinea"])

const isAmbiguousName = (lowerKey: string): boolean => usStateNames.has(lowerKey) || COMMON_WORD_AMBIGUOUS.has(lowerKey)

// surface -> bits, split across two matcher maps.
const entries = new Map<string, number>() // lowercase key
const codeEntries = new Map<string, number>() // exact-uppercase key
let maxNgram = 1

function add(surface: string): void {
	const s = surface.trim()

	if (!s) return

	if (isShortCode(s)) {
		const key = wordNorm(s).toUpperCase()

		if (!key) return
		// If a code is also a US state abbreviation, mark as ambiguous.
		const bits = BIT.country_surface | (usStateAbbrevs.has(key) ? BIT.country_ambiguous : 0)
		codeEntries.set(key, (codeEntries.get(key) ?? 0) | bits)

		return
	}

	const key = wordNormLower(s)

	if (!key) return
	const words = key.split(" ")
	maxNgram = Math.max(maxNgram, words.length)
	// Multi-word phrases are treated as unambiguous.
	// Single tokens use homograph/common-word ambiguity rules.
	const ambiguous = words.length === 1 && isAmbiguousName(key)
	const bits = BIT.country_surface | (ambiguous ? BIT.country_ambiguous : 0)
	entries.set(key, (entries.get(key) ?? 0) | bits)
}

// Add curated forms first, then canonical English names from ISO2_TO_NAME.
for (const forms of Object.values(COUNTRY_SURFACE_FORMS)) {
	for (const f of forms) {
		add(f)
	}
}

for (const [, name] of ISO2_TO_NAME) {
	add(name)
}

const ambiguousEntries = [...entries, ...codeEntries].filter(([, b]) => b & BIT.country_ambiguous).map(([k]) => k)

const lexicon = {
	version: 1,
	generated_by:
		"packages/mailwoman/lib/dev-tools/codex/country/surface-lexicon.ts (source: @mailwoman/codex COUNTRY_SURFACE_FORMS + ISO2_TO_NAME)",
	feature_dim: SLOTS.length,
	slots: SLOTS,
	bits: BIT,
	max_ngram: maxNgram,
	rules: {
		word_norm:
			"per whitespace-word: strip leading/trailing chars that are not Unicode letters/digits " +
			"(keep internal: 'timor-leste', 'u.s.a'); rejoin single-spaced. Applied to BOTH entry keys and scanned tokens.",
		entries:
			"case-insensitive; key = word_norm lowercased. country_surface always set; country_ambiguous set for single-token homographs (US region) or curated common-word names.",
		code_entries:
			"case-SENSITIVE exact: word_norm(token) == key (keys uppercase; 'in' the word ≠ 'IN' India). n-gram length 1. country_ambiguous set when the code is also a US-state abbreviation.",
		scan: "longest-first n-gram over whitespace words, left to right, non-overlapping (shared with the gazetteer matcher)",
		feature:
			"emitted per-piece row = [country_surface, country_ambiguous] (the raw bits); confidence = 1.0 where country_surface fires.",
	},
	entries: Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b))),
	code_entries: Object.fromEntries([...codeEntries].toSorted(([a], [b]) => a.localeCompare(b))),
}

await makeDirectories(dirname(OUTPUT))
await writeLocalJSONFile(lexicon, OUTPUT)

process.stderr.write(
	`wrote ${OUTPUT}: ${entries.size} entries + ${codeEntries.size} code_entries, ` +
		`max_ngram=${maxNgram}, ${ambiguousEntries.length} ambiguous: ${ambiguousEntries.slice(0, MAX_LISTED_AMBIGUOUS).join(", ")}${ambiguousEntries.length > MAX_LISTED_AMBIGUOUS ? ", …" : ""}\n`
)
