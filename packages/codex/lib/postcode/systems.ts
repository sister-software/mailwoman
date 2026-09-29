/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This function checks a postcode string against every address system's pattern. It returns the systems
 *   the postcode could belong to. Each codex address system owns its postcode shape (`us` accepts
 *   `\d{5}(-\d{4})?`, `ca` accepts `A1A 1A1`, `jp` accepts `NNN-nnnn`, …); this is the single place
 *   that asks all of them at once and collects the matches.
 *
 *   It is the shared source of truth for "which systems can this shape be", consumed by the postcode
 *   anchor to narrow which systems' street vocabularies it checks. Callers depend on this pure
 *   function, never on each other.
 *
 *   This is a shape test rather than a gazetteer-membership test: a bare `68161` matches the US,
 *   German, French, Spanish and Italian 5-digit shapes, so it returns `["us", "de", "fr", "es", "it"]`
 *   and the shape alone cannot split the numeric-postcode systems. The anchor uses real gazetteer
 *   membership for the finer call.
 */

import { normalizeAuPostcode } from "#au/index"
import { normalizeCaPostalCode } from "#ca/index"
import { normalizePLZ } from "#de/index"
import { normalizeCodigoPostal } from "#es/index"
import { normalizeCodePostal } from "#fr/index"
import { normalizeUkPostcode } from "#gb/index"
import { normalizeCAP } from "#it/index"
import { normalizeJpPostalCode } from "#jp/index"
import { normalizeNZPostcode } from "#nz/index"
import { isZipCode } from "#us/index"

/**
 * A codex address-system code — the subpath under `@mailwoman/codex/<system>`.
 */
export type SystemCode = "us" | "de" | "fr" | "es" | "it" | "ca" | "gb" | "jp" | "au" | "nz"

/**
 * Per-system membership test: each entry returns true when the string is accepted by that
 * system's own postcode shape (after that system's normalization — so `D-68161` reaches `de`,
 * `1012 LM` reaches no system here since NL has no system yet, etc.).
 *
 * Ordered for a stable, alphabetical-ish result.
 */
const SYSTEM_ACCEPTS: ReadonlyArray<readonly [SystemCode, (s: string) => boolean]> = [
	["us", (s) => isZipCode(s)],
	["de", (s) => normalizePLZ(s) !== null],
	["fr", (s) => normalizeCodePostal(s) !== null],
	["es", (s) => normalizeCodigoPostal(s) !== null],
	["it", (s) => normalizeCAP(s) !== null],
	["ca", (s) => normalizeCaPostalCode(s) !== null],
	["gb", (s) => normalizeUkPostcode(s) !== null],
	["jp", (s) => normalizeJpPostalCode(s) !== null],
	["au", (s) => normalizeAuPostcode(s) !== null],
	["nz", (s) => normalizeNZPostcode(s) !== null],
]

/**
 * Every address system with a postcode shape, in {@link SYSTEM_ACCEPTS} order.
 *
 * It is the one list a consumer that needs the universe of systems should read,
 * so it cannot drift from the table.
 */
export const SYSTEM_CODES: readonly SystemCode[] = SYSTEM_ACCEPTS.map(([system]) => system)

/**
 * Every address system whose own postcode shape accepts `postcode`, empty
 * when none recognizes it (a bare `27`, a 7-digit run); O(number of systems),
 * run only on the few postcode-shaped spans an address contains.
 */
export function candidateSystemsForPostcode(postcode: string): SystemCode[] {
	if (typeof postcode !== "string" || !postcode.length) return []
	const out: SystemCode[] = []

	for (const [system, accepts] of SYSTEM_ACCEPTS) {
		if (accepts(postcode)) {
			out.push(system)
		}
	}

	return out
}

/**
 * Postcode shapes whose code is unit-grade — a delivery-walk or street-block unit,
 * categorically tighter than any locality centroid, so an exact hit on one may lead the
 * admin ladder instead of following the locality-first epoch convention.
 *
 * The convention exists because most postal systems are area-class: an FR 5-digit zone is coarser
 * than the commune it contains, so promoting it would trade a good answer for a worse one.
 * Membership here follows measured code granularity.
 *
 * NL PC6 (`1012 LG`) covers roughly eight addresses.
 * GB unit (`N7 0BT`) covers roughly fifteen addresses in OS Code-Point Open.
 *
 * A CA urban LDU (`M1J 1A8`) covers a block face.
 * Each area is finer than the locality containing it.
 *
 * A CA rural LDU is excluded.
 * Canada Post puts a `0` in the second position of a rural forward sortation area (`T0H 1M0`).
 *
 * A rural LDU serves a delivery route with similar granularity.
 * The `[1-9]` in the pattern below excludes those codes.
 *
 * A single pooled number would hide the difference between the two populations.
 *
 * Lives in codex (per-address-system postal reference) so the Node result assembly
 * (`mailwoman/geocode-core`) and the demo's pin ranking consume one tier definition.
 */
export const UNIT_GRADE_POSTCODE: ReadonlyArray<RegExp> = [
	/^\d{4}\s?[A-Z]{2}$/i,
	// Restated from `@mailwoman/codex/gb`'s UK_POSTCODE_PATTERN so this module stays dependency-free
	// within the package (the address-system modules import this, never the reverse).
	/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
	// Rural forward sortation areas carry a `0` in second position.
	// `[1-9]` excludes them.
	/^[A-Z][1-9][A-Z]\s?\d[A-Z]\d$/i,
]

/**
 * Strip everything but letters and digits, upper-cased: `N7 0BT` and `N70BT` are
 * the same code, while the stem `N7` is not.
 */
const alnum = (s: string): string => s.replaceAll(/[^\p{L}\p{N}]/gu, "").toUpperCase()

/**
 * Returns true when a resolved postcode exactly matches a unit-grade code.
 *
 * Both the parsed span and resolver result must contain the full code shape in {@link UNIT_GRADE_POSTCODE}.
 * The caller must also confirm that a coordinate is present.
 * The Node ladder and demo pin ranking share this check.
 */
export function isUnitGradePostcodeHit(parsed: string, resolverName: string | undefined): boolean {
	const value = parsed.trim()

	if (!value || !UNIT_GRADE_POSTCODE.some((re) => re.test(value))) return false

	return alnum(resolverName ?? "") === alnum(value)
}

/**
 * Address systems whose area-grade postal code is still finer than the locality containing it —
 * the third granularity tier, between {@link UNIT_GRADE_POSTCODE} and the locality-first default.
 *
 * Whether a postal zone is coarser than its locality depends on the country's administrative geography.
 * Postal code length does not predict it.
 *
 * FR and DE both use five-digit codes, but those codes fall on opposite sides of this comparison.
 * France has ~35,000 communes and one code postal often spans several, so the commune is finer.
 *
 * A German Gemeinde can be enormous (Berlin is one WOF locality), so the PLZ is finer by a wide margin.
 *
 * Japan's postcode 町域 is finer than its municipality.
 * A six-digit Singapore postcode names one building, so its point represents the address.
 *
 * Membership is earned by a full-panel measurement against the locality-first default.
 * The US is absent on purpose.
 *
 * Its rooftop cascade runs only for US addresses, so only rows it cannot place
 * reach an administrative decision.
 * Those rows skew rural, where a locality centroid sits close and a ZIP zone is wide.
 */
export const AREA_POSTCODE_FINER_THAN_LOCALITY: ReadonlySet<string> = new Set(["DE", "JP", "SG"])

/**
 * True when this country's area-grade postal code outranks its locality.
 *
 * An absent or unknown country gives false, so the locality-first convention is what an unscoped query gets.
 */
export function areaPostcodeLeadsLocality(country: string | undefined): boolean {
	return country !== undefined && AREA_POSTCODE_FINER_THAN_LOCALITY.has(country.trim().toUpperCase())
}
