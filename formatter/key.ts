/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical match key — a normalized, deterministic string derived from address components,
 *   distinct from the human-readable formatted string.
 *
 *   Where `format.ts` produces something for a person to read, this produces something for a
 *   _machine_ to collide on: lowercased, diacritic-stripped, punctuation-flattened, whitespace-
 *   collapsed, fields in a fixed canonical order. Two records for the same address that differ only
 *   in spelling, case, or punctuation produce the same key — which is exactly what the matcher's
 *   blocking stage wants as one cheap, high-precision candidate signal (alongside geographic
 *   proximity, which carries the real weight — see the geocode-first record-matching concept doc).
 *
 *   Deliberately NOT done yet (follow-ups, all gated on `@mailwoman/codex`): expanding street
 *   suffixes (`Ave` → `avenue`) and directionals (`N` → `north`) to a canonical form, and
 *   USPS-style standardization. This first cut is pure normalization with no dictionary expansion,
 *   so the key is stable and explainable; expansion is an additive refinement, not a rewrite.
 */

import type { ComponentTag } from "@mailwoman/core/types"

import type { ComponentDict } from "./format.js"

/**
 * The address-identifying components, in canonical key order. Venue / attention are intentionally excluded — those
 * carry organization identity, which the record layer keys separately.
 */
const KEY_FIELD_ORDER = [
	"po_box",
	"house_number",
	"street_prefix",
	"street_prefix_particle",
	"street",
	"street_suffix",
	"intersection_a",
	"intersection_b",
	"unit",
	"dependent_locality",
	"locality",
	"subregion",
	"region",
	"postcode",
	"country",
] as const satisfies readonly ComponentTag[]

/** Options accepted by {@linkcode canonicalKey}. */
export interface CanonicalKeyOptions {
	/** Field separator in the emitted key. Default `"|"` — preserves field boundaries for blocking. */
	separator?: string
}

/**
 * Normalize a single token for matching: Unicode-decompose and strip combining marks (so `é` → `e`), lowercase, replace
 * `&`/`+`/`/` with spaces, drop every non-alphanumeric character, and collapse whitespace. Deterministic and
 * reversible-free — the same input always yields the same output.
 */
export function normalizeAddressToken(input: string): string {
	return (
		input
			.normalize("NFKD")
			// strip combining marks (U+0300–U+036F) left by NFKD decomposition, so "é" → "e"
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			// apostrophes are intra-word (possessives, "O'Brien") — delete so the token stays whole
			.replace(/['’`]/g, "")
			// connective punctuation becomes a space rather than vanishing (so "A&B" → "a b", not "ab")
			.replace(/[&+/]/g, " ")
			// everything else non-alphanumeric (keep spaces) is noise
			.replace(/[^a-z0-9\s]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	)
}

/**
 * Derive the canonical match key from an address component dict: each present, address-identifying field normalized via
 * {@linkcode normalizeAddressToken}, in fixed order, joined by the separator. Empty / whitespace-only fields are
 * skipped. Returns an empty string if nothing identifying remains.
 */
export function canonicalKey(components: ComponentDict, opts: CanonicalKeyOptions = {}): string {
	const separator = opts.separator ?? "|"
	const parts: string[] = []

	for (const tag of KEY_FIELD_ORDER) {
		const value = components[tag]

		if (!value) continue
		const normalized = normalizeAddressToken(value)

		if (normalized) parts.push(normalized)
	}

	return parts.join(separator)
}
