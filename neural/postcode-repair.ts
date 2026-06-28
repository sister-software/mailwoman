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
 *   deterministic decoder-side correction, the "lowest risk" lever in the v0.7 plan (vs. #36's soft
 *   FST shallow-fusion or #41's char-level encoder).
 *
 *   PRECISION GUARDS (so we never regress the countries already passing):
 *
 *   - Alphanumeric shapes (GB/CA/NL/DE-prefixed) are high-confidence "this IS a postcode" patterns →
 *       eligible to ADD a span where the model emitted none, but only over non-structural labels
 *       (never over house_number/street/etc.).
 *   - Numeric shapes (\d{5}, ZIP+4, JP, PT, PL) are ambiguous (a bare 5-digit could be a house number)
 *       → SNAP-only: they expand/clip an EXISTING postcode span, never create one from scratch.
 *   - Smear cleanup is LOCAL: only postcode tokens immediately flanking a snapped span are cleared. We
 *       never globally clear unmatched postcode tokens — that would regress shapes we don't
 *       pattern-match (AU 4-digit, IN 6-digit, …).
 */

import type { DecoderToken } from "@mailwoman/core/decoder"

/** A detected postcode-shaped substring with its char range and confidence class. */
export interface PostcodeMatch {
	start: number
	end: number
	/** "alnum" shapes may ADD; "numeric" shapes may only SNAP an existing span. */
	kind: "alnum" | "numeric"
	/** Pattern priority (lower = more specific, wins overlap resolution). */
	priority: number
}

/**
 * Per-country postcode shape patterns, ordered most-specific → least. Alphanumeric patterns require uppercase letters
 * (postcodes are conventionally uppercase, and the eval data has them uppercase) — this keeps them from matching
 * ordinary lowercase prose.
 */
export const POSTCODE_PATTERNS: Array<{ label: string; kind: "alnum" | "numeric"; re: RegExp }> = [
	// --- Alphanumeric (eligible to ADD) ---
	// GB: outward + space + inward, e.g. SW1A 1AA, EH8 9YL, W1J 9PN, IP13 6SU, B12 8QX
	{ label: "GB", kind: "alnum", re: /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g },
	// CA: A1A 1A1 (space optional), e.g. M5V 2T6, H2X 2T6, H3B 1A3
	{ label: "CA", kind: "alnum", re: /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g },
	// DE-prefixed: D-68161
	{ label: "DE", kind: "alnum", re: /\bD-\d{5}\b/g },
	// NL: 1234 AB / 1234AB — space optional (glued is common). The US "2737 CA" (ZIP+4 tail +
	// state) collision is resolved by longest-match-wins below, which lets the ZIP+4 claim it.
	{ label: "NL", kind: "alnum", re: /\b\d{4}\s?[A-Z]{2}\b/g },
	// --- Numeric (SNAP-only) ---
	{ label: "ZIP4", kind: "numeric", re: /\b\d{5}-\d{4}\b/g }, // US ZIP+4
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

function isPostcodeLabel(label: string): boolean {
	return label === "B-postcode" || label === "I-postcode"
}

/** Extract the bare tag from a BIO label ("B-locality" → "locality", "O" → null). */
function tagOf(label: string): string | null {
	return label === "O" ? null : label.slice(2)
}

/** Collect non-overlapping postcode matches, preferring more-specific (earlier) patterns. */
export function collectMatches(text: string): PostcodeMatch[] {
	const candidates: PostcodeMatch[] = []
	POSTCODE_PATTERNS.forEach((pat, priority) => {
		pat.re.lastIndex = 0

		for (let m = pat.re.exec(text); m; m = pat.re.exec(text)) {
			candidates.push({ start: m.index, end: m.index + m[0].length, kind: pat.kind, priority })
		}
	})
	// Greedy longest-match-wins: accept by (length desc, then priority asc); reject anything
	// overlapping an accepted match. Longest-first lets a US ZIP+4 ("94610-2737") claim its span
	// before the shorter NL-shaped false positive in its tail ("2737 CA") can.
	candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.priority - b.priority)
	const accepted: PostcodeMatch[] = []

	for (const c of candidates) {
		if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue
		accepted.push(c)
	}

	return accepted
}

export interface RepairResult {
	tokens: DecoderToken[]
	/** Number of token labels changed — for telemetry / logging. */
	changed: number
}

/**
 * Repair postcode label spans in a decoded token sequence using per-country regexes. Returns a NEW token array (inputs
 * are not mutated) plus a change count.
 */
export function repairPostcodeLabels(text: string, input: readonly DecoderToken[]): RepairResult {
	const matches = collectMatches(text)
	const tokens = input.map((t) => ({ ...t }))

	if (matches.length === 0) return { tokens, changed: 0 }

	let changed = 0
	const setLabel = (i: number, label: DecoderToken["label"]): void => {
		if (tokens[i]!.label !== label) {
			tokens[i]!.label = label
			changed++
		}
	}

	for (const m of matches) {
		// Tokens whose char span intersects the match.
		const overlap: number[] = []

		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!

			if (t.start < m.end && m.start < t.end) overlap.push(i)
		}

		if (overlap.length === 0) continue

		const hasPostcode = overlap.some((i) => isPostcodeLabel(tokens[i]!.label))

		if (!hasPostcode) {
			// ADD path — only for high-confidence alphanumeric shapes, only over safe labels.
			if (m.kind !== "alnum") continue
			const safe = overlap.every((i) => {
				const tag = tagOf(tokens[i]!.label)

				return tag === null || ADD_OVER_TAGS.has(tag)
			})

			if (!safe) continue
		}

		// SNAP/ADD: relabel the matched run as a single postcode span.
		overlap.forEach((i, k) => setLabel(i, k === 0 ? POSTCODE_B : POSTCODE_I))

		// Leading smear clip: postcode tokens immediately BEFORE the snapped run are noise (e.g. a
		// house-number digit the model over-labeled) — clear to O as before.
		for (let j = overlap[0]! - 1; j >= 0 && isPostcodeLabel(tokens[j]!.label); j--) setLabel(j, OUTSIDE)

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

		for (let j = overlap[overlap.length - 1]! + 1; j < tokens.length && isPostcodeLabel(tokens[j]!.label); j++) {
			trailing.push(j)
		}

		if (trailing.length > 0) {
			const after = trailing[trailing.length - 1]! + 1
			const connectsToCity = after < tokens.length && tagOf(tokens[after]!.label) === "locality"

			if (connectsToCity) {
				trailing.forEach((j, k) => setLabel(j, k === 0 ? LOCALITY_B : LOCALITY_I))

				if (tokens[after]!.label === "B-locality") setLabel(after, LOCALITY_I)
			} else {
				for (const j of trailing) setLabel(j, OUTSIDE)
			}
		}
	}

	return { tokens, changed }
}

// repairLeadingHouseNumber (#723) was removed 2026-06-24. It RELABELLED a leading 5-digit postcode →
// house_number under conventions=auto (US) — an OVERRIDE that contradicted the model's own label,
// which the project's repair discipline forbids (a repair may add spans on O-tokens or snap
// boundaries, never re-classify a token from one entity to another). Net on the US golden set it was
// −302 postcode / +16 house_number; an anchor-ablation probe showed the model is 100% correct on the
// target slice once the binary postcode anchor (which fires on a leading number that is a valid ZIP
// elsewhere) is removed. The disambiguation is being absorbed model-side: a region-congruence anchor
// upgrade + augmented postcode-leading shards. See the 2026-06-24 postmortem + DeepSeek consult 019ef789.
