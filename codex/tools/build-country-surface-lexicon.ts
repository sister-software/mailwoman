/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build the COUNTRY-SURFACE LEXICON for the country-lexicon soft-feed channel (#1104). This is the
 *   third atlas channel, a sibling of the postcode anchor (#239/#240) and the gazetteer anchor
 *   (#464): a per-token multi-hot clue the neural GRAMMAR conditions on but never obeys. Country is a
 *   CLOSED, ENUMERABLE class (~250 surfaces) — atlas, not grammar — so a dictionary phrase-lookup
 *   recovers the WOF-admin / resolver hierarchy case ("United States of America, Wyoming, <locality>")
 *   the learned tagger reads as a leading STREET. Pelias handled the same class the same way
 *   (`WhosOnFirstClassifier extends PhraseClassifier`); this is the model-first analogue.
 *
 *   WHY A DEDICATED LEXICON (not just the gazetteer's `country` slot): the gazetteer already carries
 *   these surfaces in slot 0, and the shipped model already consumes them — yet the WOF-admin case
 *   still fails (model-card #1104: golden country recall 82.0% vs 88.6%). The country bit is one of a
 *   5-hot vector sharing ONE learned projection with region/po_box/cedex/homograph, and it is ZEROED
 *   adjacent to a postcode by `suppress_gazetteer_near_postcode` (exactly where a trailing "…12345
 *   USA" sits). A dedicated channel de-entangles the country signal (its own projection + confidence
 *   weight) and is immune to that suppression. See
 *   docs/superpowers/plans/2026-07-14-country-lexicon-channel.md.
 *
 *   The matcher REUSES the gazetteer's phrase-scan (longest-first n-gram over whitespace words,
 *   case-insensitive `entries` + uppercase-exact `code_entries`, char→piece projection) — one tested
 *   algorithm, two vocabularies. Only the vocabulary + the emitted feature differ. The emitted
 *   feature is 2-dim per piece: `[country_surface, country_ambiguous]`.
 *
 *   - `country_surface` (bit 1): the piece is part of a recognized country surface phrase.
 *   - `country_ambiguous` (bit 2): the SURFACE is a homograph (also a US region) or a common-word
 *     name ("Georgia", "America", "England", "IN") — a SOFT version of Pelias's hard blacklist. The
 *     model learns to trust `surface & !ambiguous` (unambiguous long/code forms) strongly and
 *     `surface & ambiguous` weakly, using context — model-first, never a hard drop, so recall on
 *     "Republic of Georgia" is preserved.
 *
 *   Source of truth: `@mailwoman/codex` (COUNTRY_SURFACE_FORMS + ISO2_TO_NAME) — the SAME data the
 *   corpus-python bridge `country-surfaces.json` is generated from (export-country-surfaces.ts), so
 *   the channel and the corpus shard synthesizer cannot diverge on what a country surface IS.
 *
 *   Output: data/gazetteer/country-surface-lexicon-v1.json (small, committed, provenance-tracked).
 *   Regenerate: `node codex/tools/build-country-surface-lexicon.ts`
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { COUNTRY_SURFACE_FORMS, ISO2_TO_NAME } from "../country/country.ts"
import { US_STATE_ABBREVIATIONS, US_STATE_NAMES } from "../us/state.ts"

const BIT = { country_surface: 1, country_ambiguous: 2 }
const SLOTS = ["country_surface", "country_ambiguous"]

// Committed output path (a codex-derived artifact, like export-country-surfaces.ts — no argv, so the
// no-process-globals lint policy holds; codex stays zero-runtime-dep).
const OUTPUT = resolve(import.meta.dirname, "../../data/gazetteer/country-surface-lexicon-v1.json")

/**
 * THE shared word-normalization rule (identical to build-gazetteer-anchor-lexicon.mjs and mirrored in
 * gazetteer_char_paint on both sides): per whitespace-word, strip LEADING/TRAILING characters that are not Unicode
 * letters or digits (keep internal ones: "u.s.a", "timor-leste"), rejoin single-spaced. Entry keys and scanned tokens
 * both pass through it, so "U.S.A." ≡ "u.s.a".
 */
const wordNorm = (s: string): string =>
	s
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean)
		.join(" ")

const norm = (s: string): string => wordNorm(s).toLowerCase()

/** Short alphabetic code (≤3 letters once punctuation is dropped) → exact-uppercase matching. */
const isShortCode = (s: string): boolean => {
	const letters = s.replace(/[^\p{L}]/gu, "")

	return letters.length > 0 && letters.length <= 3 && /^[\p{L}.\s]+$/u.test(s)
}

// Homograph set: a single-word country surface that is ALSO a US region (name or abbreviation) reads
// ambiguously (Georgia the country vs the state, IN = India vs Indiana). Computed from codex so it
// tracks the US region table, never hand-maintained.
const usStateNames = new Set(US_STATE_NAMES.map((n) => n.toLowerCase()))
const usStateAbbrevs = new Set<string>(US_STATE_ABBREVIATIONS as readonly string[])

// Curated common-word country surfaces — single tokens that appear far more often as ordinary
// street/venue/locality words than as a trailing country. A SOFT flag (the model still decides), the
// model-first analogue of Pelias's blacklist (north/south/east/west/street/city/king). Tunable.
const COMMON_WORD_AMBIGUOUS = new Set(["america", "england", "britain", "turkey", "chad", "jordan", "jersey", "guinea"])

const isAmbiguousName = (lowerKey: string): boolean => usStateNames.has(lowerKey) || COMMON_WORD_AMBIGUOUS.has(lowerKey)

// surface → bits, split across the two match-rule maps (mirrors the gazetteer builder).
const entries = new Map<string, number>() // lowercase key
const codeEntries = new Map<string, number>() // exact-uppercase key
let maxNgram = 1

function add(surface: string): void {
	const s = surface.trim()

	if (!s) return

	if (isShortCode(s)) {
		const key = wordNorm(s).toUpperCase()

		if (!key) return
		// A code that collides with a US-state abbreviation (CA/IN/AL/CO/…) is a homograph → ambiguous.
		const bits = BIT.country_surface | (usStateAbbrevs.has(key) ? BIT.country_ambiguous : 0)
		codeEntries.set(key, (codeEntries.get(key) ?? 0) | bits)

		return
	}
	const key = norm(s)

	if (!key) return
	const words = key.split(" ")
	maxNgram = Math.max(maxNgram, words.length)
	// Multi-word phrases are unambiguous by construction; single tokens consult the homograph +
	// common-word rule.
	const ambiguous = words.length === 1 && isAmbiguousName(key)
	const bits = BIT.country_surface | (ambiguous ? BIT.country_ambiguous : 0)
	entries.set(key, (entries.get(key) ?? 0) | bits)
}

// Curated rich surface forms first (US/GB/DE/… endonyms + abbreviations), then the canonical English
// name for every remaining ISO 3166-1 alpha-2 — exactly the merge country-surfaces.json performs.
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
		"codex/tools/build-country-surface-lexicon.ts (source: @mailwoman/codex COUNTRY_SURFACE_FORMS + ISO2_TO_NAME)",
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
	entries: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b))),
	code_entries: Object.fromEntries([...codeEntries].sort(([a], [b]) => a.localeCompare(b))),
}

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, JSON.stringify(lexicon, null, 1) + "\n")
process.stderr.write(
	`wrote ${OUTPUT}: ${entries.size} entries + ${codeEntries.size} code_entries, ` +
		`max_ngram=${maxNgram}, ${ambiguousEntries.length} ambiguous: ${ambiguousEntries.slice(0, 12).join(", ")}${ambiguousEntries.length > 12 ? ", …" : ""}\n`
)
