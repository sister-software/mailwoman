/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode regex repair pass — v0.7 task #35 ("postcode regex pre-pass").
 *
 *   The 2026-05-29 postcode diagnostic showed the neural model fragments alphanumeric postcodes at
 *   the SentencePiece layer (GB/CA/NL at 0%, US 80.5%, FR 70.1%). Three failure modes were visible
 *   in the data:
 *
 *   1. Total miss — "London SW1A 1AA" → (no postcode label)
 *   2. Truncation — "M5V 2T6" → "2T6"; "B12 8QX" → "B12"
 *   3. Char-drift — "75008" → "5008"; "62701" → "2701" (and smear: "1200-030 Lisboa" → "200-030 Lis")
 *
 *   This pass runs AFTER the model's per-token BIO labels are decoded but BEFORE `buildAddressTree`.
 *   It detects postcode-shaped substrings with per-country regexes and repairs the label sequence
 *   so the postcode span matches the detected shape. The model is untouched — this is a
 *   deterministic decoder-side correction, the "lowest risk" change in the v0.7 plan (vs. #36's soft
 *   FST shallow-fusion or #41's char-level encoder).
 *
 *   PRECISION GUARDS (so we never regress the countries already passing):
 *
 *   - Alphanumeric shapes (GB/CA/NL/DE-prefixed) are high-confidence "this IS a postcode" patterns →
 *       eligible to ADD a span where the model emitted none, but only over non-structural labels
 *       (never over house_number/street/etc.).
 *   - Numeric shapes (\d{5}, ZIP+4, BR, JP, PT, PL) are ambiguous (a bare 5-digit could be a house number)
 *       → SNAP-only: they expand/clip an EXISTING postcode span, never create one from scratch.
 *   - A DESIGNATED shape carries the writing system's own postal marker: `〒506-0025` is a postcode by Japan Post's
 *       convention, and no house number is ever written behind 〒. It may overwrite any label, structural ones
 *       included — the one override the discipline below allows, because the mark, not the digit shape, decides. The
 *       span excludes the mark: the resolver keys `506-0025`, and the character model was trained to leave 〒 outside.
 *   - Smear cleanup is LOCAL: only postcode tokens immediately flanking a snapped span are cleared. We
 *       never globally clear unmatched postcode tokens — that would regress shapes we don't
 *       pattern-match (AU 4-digit, IN 6-digit, …).
 *
 *   A MISSING shape is not neutral for a HYPHENATED postcode. The local smear cleanup is local to a
 *   MATCH, and an unlisted compound shape still matches at its numeric head: `NUM5` claims the five
 *   digits of an unlisted `NNNNN-NNN`, snaps the span down to them, and clips the suffix the model
 *   correctly labeled. That is how BR CEPs were truncated for the pass's whole life (#35, diagnosed
 *   2026-08-10) while the unhyphenated shapes above degraded gracefully. Before concluding a hyphenated
 *   postcode is a model failure, re-parse it with `postcodeRepair: false`.
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

import {
	collectMatchesFor,
	createLabelSetter,
	isAddSafe,
	isTagLabel,
	type RepairResult,
	type SpanMatch,
	tagOf,
	tokenIndicesOverlapping,
} from "#span/repair"

export type { RepairResult } from "#span/repair"

/**
 * A detected postcode-shaped substring with its char range and confidence class.
 */
export interface PostcodeMatch extends SpanMatch {
	/**
	 * "alnum" shapes may ADD over container labels; "numeric" shapes may only SNAP an existing span; a "designated" shape
	 * (the digits behind a postal marker) may overwrite any label.
	 */
	kind: "alnum" | "numeric" | "designated"
}

/**
 * Per-country postcode shape patterns, ordered most-specific → least. Alphanumeric patterns require uppercase letters
 * (postcodes are conventionally uppercase, and the eval data has them uppercase) — this keeps them from matching
 * ordinary lowercase prose.
 */
export const POSTCODE_PATTERNS: Array<{ label: string; kind: "alnum" | "numeric" | "designated"; re: RegExp }> = [
	// --- Designated by a postal marker (may overwrite any label) ---
	// JP: the digits behind 〒, optionally spaced (〒506-0025, 〒 100-0001). The character path keeps the mark in the
	// text (`NormalizeOpts.postalMark`), and on a venue-led line the model has read the digits as a house number.
	{ label: "JP-marked", kind: "designated", re: /(?<=〒\s?)\d{3}-\d{4}\b/gu },
	// --- Alphanumeric (eligible to ADD) ---
	// GB: outward + space + inward, e.g. SW1A 1AA, EH8 9YL, W1J 9PN, IP13 6SU, B12 8QX
	{ label: "GB", kind: "alnum", re: /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g },
	// CA: A1A 1A1 (space optional), e.g. M5V 2T6, H2X 2T6, H3B 1A3
	{ label: "CA", kind: "alnum", re: /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g },
	// IE Eircode: routing key (letter + 2 digits, or the D6W special) + a 4-alnum unique part, e.g.
	// D02 AF30, T12 X70A, F91 Y5CY. Space REQUIRED (glued Eircodes are rare and a 7-alnum blob is too
	// forgeable for the ADD path). No GB collision: a letter+2-digit GB outward always has a 3-char
	// inward (B12 8QX), never 4. The 2026-07-06 IE diagnostic showed the model fragments Eircodes
	// (F91 Y5CY → postcode "91") — same class the GB/CA/NL patterns above were added for.
	{ label: "IE", kind: "alnum", re: /\b(?:[A-Z]\d{2}|D6W)\s+[A-Z\d]{4}\b/g },
	// DE-prefixed: D-68161
	{ label: "DE", kind: "alnum", re: /\bD-\d{5}\b/g },
	// NL: 1234 AB / 1234AB — space optional (glued is common). The US "2737 CA" (ZIP+4 tail +
	// state) collision is resolved by longest-match-wins below, which lets the ZIP+4 claim it.
	{ label: "NL", kind: "alnum", re: /\b\d{4}\s?[A-Z]{2}\b/g },
	// --- Numeric (SNAP-only) ---
	{ label: "ZIP4", kind: "numeric", re: /\b\d{5}-\d{4}\b/g }, // US ZIP+4
	// BR CEP: NNNNN-NNN (70390-100, 95090-020). Without it the generic NUM5 below matched the five-digit
	// head of a CEP, snapped the span to it, and the trailing-smear clip DISCARDED the sector suffix — so
	// the repair pass truncated a parse the model had got right (measured 2026-08-10 on both BR
	// world-structures rows: repair OFF "95090-020", repair ON "95090"). The trailing `\b` keeps it off a
	// ZIP+4's first nine characters ("94610-2737" has a digit after "273"), and longest-match-wins in
	// `selectNonOverlappingMatches` settles the rest. SNAP-only like every numeric shape, so it can never
	// invent a postcode over a hyphenated house number.
	{ label: "BR", kind: "numeric", re: /\b\d{5}-\d{3}\b/g },
	{ label: "JP", kind: "numeric", re: /\b\d{3}-\d{4}\b/g }, // 100-0001
	{ label: "PT", kind: "numeric", re: /\b\d{4}-\d{3}\b/g }, // 3060-187
	{ label: "PL", kind: "numeric", re: /\b\d{2}-\d{3}\b/g }, // 47-400
	{ label: "NUM5", kind: "numeric", re: /\b\d{5}\b/g }, // US/FR/DE/ES 5-digit
]

/**
 * Labels a postcode span is allowed to overwrite when the model emitted no postcode at all (ADD path). These are the
 * geographic-container tags postcodes get confused with per the diagnostic ("often labeled as locality or O").
 * Structural tags (house_number, street*, unit, po_box, venue, …) are intentionally absent so we never clobber a
 * confidently-labeled street/number with a false postcode.
 */
const ADD_OVER_TAGS = new Set<string>(["locality", "dependent_locality", "region", "subregion", "country"])

const POSTCODE_B = "B-postcode" as DecoderToken["label"]
const POSTCODE_I = "I-postcode" as DecoderToken["label"]
const LOCALITY_B = "B-locality" as DecoderToken["label"]
const LOCALITY_I = "I-locality" as DecoderToken["label"]
const OUTSIDE = "O" as DecoderToken["label"]

/**
 * Collect non-overlapping postcode matches, preferring more-specific (earlier) patterns.
 */
export function collectMatches(text: string): PostcodeMatch[] {
	return collectMatchesFor(POSTCODE_PATTERNS, text).map(({ start, end, priority, pattern }) => ({
		start,
		end,
		kind: pattern.kind,
		priority,
	}))
}

/**
 * Repair postcode label spans in a decoded token sequence using per-country regexes. Returns a NEW token array (inputs
 * are not mutated) plus a change count.
 */
export function repairPostcodeLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const matches = collectMatches(text)
	const tokens = input.map((t) => ({ ...t }))

	if (!matches.length) return { tokens, changed: 0 }

	const { setLabel, changeCount } = createLabelSetter(tokens)

	for (const m of matches) {
		const overlap = tokenIndicesOverlapping(tokens, m.start, m.end)

		if (!overlap.length) continue

		const hasPostcode = overlap.some((i) => isTagLabel(tokens[i]!.label, "postcode"))

		if (!hasPostcode) {
			// ADD path — a designated shape over any label; an alphanumeric shape only over safe labels; a numeric shape
			// never.
			if (m.kind === "numeric") continue

			if (m.kind === "alnum" && !isAddSafe(tokens, overlap, ADD_OVER_TAGS)) continue
		}

		// SNAP/ADD: relabel the matched run as a single postcode span.
		overlap.forEach((i, k) => setLabel(i, k === 0 ? POSTCODE_B : POSTCODE_I))

		// Leading smear clip: postcode tokens immediately BEFORE the snapped run are noise (e.g. a
		// house-number digit the model over-labeled) — clear to O as before.
		for (let j = overlap[0]! - 1; j >= 0 && isTagLabel(tokens[j]!.label, "postcode"); j--) {
			setLabel(j, OUTSIDE)
		}

		// Trailing smear: the model over-extended the postcode to the RIGHT. In postcode-before-city
		// locales (DE/FR/ES/IT, "08523 Plauen") this swallows the leading characters of the city, which
		// the historical clip-to-O then DISCARDED ("08523 Pl|auen Vogtl" → postcode "08523" + O +
		// locality "auen Vogtl", dropping the "Pl"). When the smear connects to a following locality run,
		// hand those characters BACK to the city — reassign them to locality and demote the city's
		// leading B so the prefix + city form ONE span ("Pl"+"auen"+"Vogtl" → "Plauen Vogtl"). A
		// standalone neighbour with no following locality (a country, "Paris 75008 France") keeps the
		// historical clip-to-O. This is the decoder-side repair for the cross-tag postcode→city
		// absorption diagnosed in the PR3 Pilot A postmortem (+36pp DE exact-locality, no-op on US,
		// where the postcode sits at the end with nothing to trim).
		const trailing: number[] = []

		for (let j = overlap.at(-1)! + 1; j < tokens.length && isTagLabel(tokens[j]!.label, "postcode"); j++) {
			trailing.push(j)
		}

		if (trailing.length) {
			const after = trailing.at(-1)! + 1
			const connectsToCity = after < tokens.length && tagOf(tokens[after]!.label) === "locality"

			if (connectsToCity) {
				trailing.forEach((j, k) => setLabel(j, k === 0 ? LOCALITY_B : LOCALITY_I))

				if (tokens[after]!.label === "B-locality") {
					setLabel(after, LOCALITY_I)
				}
			} else {
				for (const j of trailing) {
					setLabel(j, OUTSIDE)
				}
			}
		}
	}

	return { tokens, changed: changeCount() }
}

// repairLeadingHouseNumber (#723) was removed 2026-06-24. It RELABELLED a leading 5-digit postcode →
// house_number under conventions=auto (US) — an OVERRIDE that contradicted the model's own label,
// which the project's repair discipline forbids (a repair may add spans on O-tokens or snap
// boundaries, never re-classify a token from one entity to another). Net on the US golden set it was
// −302 postcode / +16 house_number; an anchor-ablation probe showed the model is 100% correct on the
// target slice once the binary postcode anchor (which fires on a leading number that is a valid ZIP
// elsewhere) is removed. The disambiguation is being absorbed model-side: a region-congruence anchor
// upgrade + augmented postcode-leading extracts. See the 2026-06-24 postmortem + DeepSeek consult 019ef789.
