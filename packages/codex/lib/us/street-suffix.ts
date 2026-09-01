/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28, Appendix C — Postal Service Standard Suffix Abbreviations.
 *
 *   The DATA lives in `./street-suffix.json` so non-TS consumers (the Python training loader's
 *   lexicon builder, audits) read the identical record — no hand-mirrored copies. Two keys:
 *
 *   - `variants` — verbatim USPS Pub-28: canonical suffix → every recognized variant in
 *     USPS-published order; the first variant is the preferred USPS abbreviation (e.g.
 *     `AVENUE → ["AVE", ...]` — `AVE` is what the post office prints).
 *   - `nameProneCanonicals` — OUR curation, not Pub-28: canonicals also observed as ordinary
 *     proper-name heads in street names (PARK, HILL, CREEK…), from golden v0.1.3 + the OA street
 *     pool. Shared by the golden relabel flags, the #1569 extract recipe, and (via the
 *     `gazetteer affix-relabel` v2 lexicon) the Python relabel pass, so the instrument and the
 *     training feed cannot drift onto different definitions of the ambiguous class.
 *
 *   This module remains the single TS home for the table: the synthesis-layer helpers
 *   (`US_STREET_SUFFIX_PREFERRED_ABBR`, `matchCase`, `matchTrailingSuffix` — used by
 *   `@mailwoman/corpus`) and the richer branded-type lookup (`StreetSuffix`,
 *   `lookupStreetSuffix`, `isStreetSuffix`) share the one underlying JSON record.
 * @see {@link https://pe.usps.com/text/pub28/28apc_002.htm USPS Street Suffix Abbreviations}
 */

import streetSuffixData from "./street-suffix.json" with { type: "json" }

/**
 * Canonical USPS street suffix → list of recognized variants. The first variant in each list is the preferred USPS
 * abbreviation. Keys + values are uppercase per the publication. Data: `./street-suffix.json`.
 */
export const US_STREET_SUFFIX_VARIANTS = streetSuffixData.variants

/**
 * Canonical USPS suffix (full word, uppercase per the publication).
 */
export type USStreetSuffix = keyof typeof US_STREET_SUFFIX_VARIANTS

/**
 * Pub-28 canonicals that are also common head nouns in street/place names ("Menlo PARK Road", "Blue HILL Rd") — the
 * ambiguous class behind #1569. Curated (golden v0.1.3 + OA street pool), NOT part of the USPS publication; see
 * `nameProneCanonicals` in `./street-suffix.json`.
 */
export const NAME_PRONE_US_SUFFIXES: ReadonlySet<USStreetSuffix> = new Set(
	streetSuffixData.nameProneCanonicals as USStreetSuffix[]
)

/**
 * Inverse lookup: every variant abbreviation OR full canonical word → its canonical key. Built once at module load,
 * lowercase-keyed for case-insensitive matching (`street` → `"STREET"`, `st` → `"STREET"`, `strt` → `"STREET"`, …).
 */
export const US_STREET_SUFFIX_LOOKUP: ReadonlyMap<string, USStreetSuffix> = (() => {
	const out = new Map<string, USStreetSuffix>()

	for (const canonical of Object.keys(US_STREET_SUFFIX_VARIANTS) as USStreetSuffix[]) {
		out.set(canonical.toLowerCase(), canonical)

		for (const variant of US_STREET_SUFFIX_VARIANTS[canonical]) {
			// Don't overwrite — first canonical that claims a variant wins (matches USPS Pub-28's
			// ordering). E.g. "WALK" and "WALKS" both list "WALK" as a variant; "WALK" wins because it
			// sorts first in `Object.keys`.
			if (!out.has(variant.toLowerCase())) {
				out.set(variant.toLowerCase(), canonical)
			}
		}
	}

	return out
})()

/**
 * Preferred USPS abbreviation per canonical (`AVENUE → "AVE"`, `STREET → "ST"`).
 */
export const US_STREET_SUFFIX_PREFERRED_ABBR: Readonly<Record<USStreetSuffix, string>> = Object.fromEntries(
	// Every Pub-28 canonical carries >= 1 variant (the preferred abbreviation is first); the JSON
	// import types values as string[], so assert the head's presence.
	(Object.keys(US_STREET_SUFFIX_VARIANTS) as USStreetSuffix[]).map((k) => [k, US_STREET_SUFFIX_VARIANTS[k][0]!])
) as Readonly<Record<USStreetSuffix, string>>

/**
 * Apply `target`'s letters in the same case-pattern as `reference`. Three patterns covered:
 *
 * - All-uppercase reference (`"AVE"`) → uppercase target (`"AVENUE"`).
 * - All-lowercase reference (`"ave"`) → lowercase target (`"avenue"`).
 * - Anything else (`"Ave"`, `"aVe"`) → title-case target (`"Avenue"`).
 */
export function matchCase(target: string, reference: string): string {
	if (!reference) return target

	if (reference === reference.toUpperCase()) return target.toUpperCase()

	if (reference === reference.toLowerCase()) return target.toLowerCase()

	return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase()
}

/**
 * If the last whitespace-separated word of `street` is a known USPS suffix variant, return the canonical key and the
 * matched word. Returns null if the trailing word isn't a known suffix.
 */
export function matchTrailingSuffix(street: string): { canonical: USStreetSuffix; matched: string } | null {
	const trimmed = street.trim()

	if (!trimmed) return null
	const parts = trimmed.split(/\s+/)
	const last = parts.at(-1)!
	const canonical = US_STREET_SUFFIX_LOOKUP.get(last.toLowerCase())

	if (!canonical) return null

	return { canonical, matched: last }
}

/**
 * The USPS suffix record, under its original isp-nexus name. Aliases {@link US_STREET_SUFFIX_VARIANTS}.
 */
export const StreetSuffixAbbreviationRecord = US_STREET_SUFFIX_VARIANTS

export type StreetSuffixAbbreviationRecord = typeof US_STREET_SUFFIX_VARIANTS

/**
 * A canonical USPS street suffix, i.e. "STREET", "AVENUE", "BOULEVARD". Aliases {@link USStreetSuffix}.
 */
export type StreetSuffix = USStreetSuffix

/**
 * A standardized USPS street suffix abbreviation (the preferred form), i.e. "ST", "AVE", "BLVD".
 */
export type USPSStandardSuffixAbbreviation = StreetSuffixAbbreviationRecord[StreetSuffix][0]

/**
 * Any USPS-recognized suffix variant or abbreviation.
 */
export type StreetSuffixAbbreviation = StreetSuffixAbbreviationRecord[StreetSuffix][number]

/**
 * Result of a successful USPS street suffix lookup.
 */
export interface StreetSuffixMatch<S extends StreetSuffix = StreetSuffix> {
	/**
	 * The matched canonical USPS street suffix, i.e. "STREET", "AVENUE".
	 */
	suffix: S
	/**
	 * The preferred USPS street suffix abbreviation, i.e. "ST", "AVE".
	 */
	abbreviation: StreetSuffixAbbreviationRecord[S][0]
}

/**
 * Look up a USPS street suffix (by canonical word, abbreviation, or any variant) and its preferred abbreviation.
 */
export function lookupStreetSuffix<S extends StreetSuffix>(suffix: S): StreetSuffixMatch<S>
export function lookupStreetSuffix(input: string | null | undefined): StreetSuffixMatch | null

export function lookupStreetSuffix(input: string | null | undefined): StreetSuffixMatch | null {
	if (!input || typeof input !== "string") return null
	const suffix = US_STREET_SUFFIX_LOOKUP.get(input.trim().toLowerCase())

	if (!suffix) return null

	return { suffix, abbreviation: US_STREET_SUFFIX_VARIANTS[suffix][0]! }
}

/**
 * Type-predicate: is the input a canonical USPS street suffix (uppercase full word, e.g. "STREET")?
 */
export function isStreetSuffix(input: unknown): input is StreetSuffix {
	return typeof input === "string" && Object.hasOwn(US_STREET_SUFFIX_VARIANTS, input)
}

/**
 * True when a token is any USPS street suffix or abbreviation (case-insensitive) — `"St"`, `"BLVD"`, `"trail"`.
 */
export function isStreetSuffixToken(input: unknown): boolean {
	return typeof input === "string" && US_STREET_SUFFIX_LOOKUP.has(input.trim().toLowerCase())
}
