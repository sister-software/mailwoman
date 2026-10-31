/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-country street span convention: whether a country's labels write the street type and
 *   directional as their own `street_prefix` / `street_suffix` spans or keep the whole street in one
 *   `street` span.
 *
 *   `docs/engineering/reference/SCHEMA.mdx` makes the split canonical for the US, where the USPS Pub 28
 *   Appendix C table in `#us/street/suffix` defines it. Every other country keeps the street whole. The
 *   corpus adapters emit that form outside the US, and golden v0.1.3's `MANIFEST.json` declares the same
 *   table in `convention.street_convention` (`{ US: "split", "*": "folded" }`).
 */

/**
 * `split` labels `street_prefix`, `street` and `street_suffix` as separate spans.
 *
 * `whole` labels the street, type and directionals included, as one `street` span.
 */
export type StreetSpanConvention = "split" | "whole"

/**
 * The countries whose labels split the street, keyed by ISO 3166-1 alpha-2 code.
 * A country absent from the table keeps the street whole.
 */
const SPLIT_STREET_COUNTRIES: ReadonlySet<string> = new Set(["US"])

/**
 * Returns the street span convention of `countryCode`'s labels.
 *
 * A missing country code reads as `whole`, the convention of every country outside the table.
 */
export function streetSpanConventionFor(countryCode: string | null): StreetSpanConvention {
	return countryCode && SPLIT_STREET_COUNTRIES.has(countryCode.toUpperCase()) ? "split" : "whole"
}
