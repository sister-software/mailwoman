/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical match key — a normalized, deterministic string derived from address components, distinct
 *   from the human-readable formatted string.
 *
 *   Lowercased, diacritic-stripped, punctuation-flattened, whitespace-collapsed, fields in a fixed canonical
 *   order, so two records for the same address that differ only in spelling, case or punctuation produce the
 *   same key. This version is pure normalization with no dictionary expansion, so the key is stable and
 *   explainable.
 */

import type { ComponentDict } from "#address/format"
import type { ComponentTag } from "#component"

/**
 * The address-identifying components, in canonical key order.
 *
 * Venue / attention are intentionally excluded.
 * Those carry organization identity, which the record layer keys separately.
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

/**
 * Options accepted by {@linkcode canonicalKey}.
 */
export interface CanonicalKeyOptions {
	/**
	 * Field separator in the emitted key.
	 *
	 * Default `"|"` — preserves field boundaries for blocking.
	 */
	separator?: string
}

/**
 * Options for {@linkcode foldForKey} — the two points where the formatter's address-token fold
 * and the record package's fragment fold legitimately differ.
 */
export interface FoldForKeyOptions {
	/**
	 * How connective punctuation folds.
	 *
	 * `"space"` turns `&`, `+`, and `/` into word boundaries (`"A&B"` → `"a b"`);
	 * `"and"` spells `&` and `+` out as the word `and` (`"AT&T"` → `"at and t"`),
	 * leaving `/` to the punctuation catch-all (still a word boundary).
	 */
	ampersand: "space" | "and"
	/**
	 * Intra-token deletion set.
	 *
	 * When true, periods join the apostrophes as intra-token noise and are deleted
	 * (`"S.A."` → `"sa"`), while a backtick falls to the punctuation catch-all.
	 * When false or omitted, backticks are deleted alongside the apostrophes
	 * and periods become word boundaries (`"S.A."` → `"s a"`).
	 */
	dropPeriods?: boolean
}

/**
 * The shared fold behind every match key: nfkd-decompose and strip combining marks (so `é` → `e`),
 * lowercase, delete intra-token punctuation, expand or flatten connective punctuation per
 * {@linkcode FoldForKeyOptions}, space every remaining non-alphanumeric, and collapse whitespace.
 *
 * Deterministic — the same input and options always yield the same output.
 */
export function foldForKey(input: string, options: FoldForKeyOptions): string {
	const folded = input
		.normalize("NFKD")
		.replaceAll(/[\u0300-\u036F]/g, "")
		.toLowerCase()
		// apostrophes are intra-word (possessives, "O'Brien") — delete so the token stays whole
		.replaceAll(options.dropPeriods ? /[.'’]/g : /['’`]/g, "")

	const connected =
		options.ampersand === "and"
			? folded.replaceAll("&", " and ").replaceAll("+", " and ")
			: folded.replaceAll(/[&+/]/g, " ")

	return (
		connected
			// everything else non-alphanumeric (keep spaces) is noise
			.replaceAll(/[^a-z0-9\s]/g, " ")
			.replaceAll(/\s+/g, " ")
			.trim()
	)
}

/**
 * Normalize a single token for matching: {@linkcode foldForKey} with connective
 * punctuation flattened to spaces (so `"A&B"` → `"a b"`, not `"ab"`).
 */
export function normalizeAddressToken(input: string): string {
	return foldForKey(input, { ampersand: "space" })
}

/**
 * Derive the canonical match key: each present, address-identifying field normalized
 * via {@linkcode normalizeAddressToken}, in fixed order, joined by the separator;
 * empty fields are skipped and an empty string is returned if none remains.
 */
export function canonicalKey(components: ComponentDict, opts: CanonicalKeyOptions = {}): string {
	const separator = opts.separator ?? "|"
	const parts: string[] = []

	for (const tag of KEY_FIELD_ORDER) {
		const value = components[tag]

		if (!value) continue
		const normalized = normalizeAddressToken(value)

		if (normalized) {
			parts.push(normalized)
		}
	}

	return parts.join(separator)
}
