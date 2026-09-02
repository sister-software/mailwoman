/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode FORMAT → country evidence, pure and platform-free — the #928 unforgeable singles and the
 *   #1589 bare-context implied set. Lifted out of `mailwoman/geocode-core` so `@mailwoman/resolver`
 *   (which runs in the browser via the demo cascade) can derive the implied set itself instead of
 *   depending on a CLI-side caller to thread it — the 2026-08-11 staged-repoint e2e caught exactly
 *   that gap (`100 00` resolved in Node and not in the browser, same artifact). `geocode-core`
 *   re-exports everything here, so its consumers and tests are unmoved.
 */

/**
 * #928: distinctive postcode FORMATS that unambiguously indicate a country — a stronger country signal than the
 * language-based coarse placer, which conflates GB/US (both carry English street patterns) and mis-routes GB addresses
 * to US namesakes (`London E4 9AZ` → London, Ohio) at 0.94–0.96 confidence. The format is unforgeable across these
 * countries: the GB pattern (letters-first) never matches a US ZIP or an NL `\d{4} [A-Z]{2}` code. Extend ONLY with
 * formats validated as non-overlapping. Feeds the `postcodeCountryPrior` lever (conditional, default-off pending its
 * check).
 */
export const POSTCODE_FORMAT_COUNTRY: ReadonlyArray<{ readonly re: RegExp; readonly country: string }> = [
	// GB `E4 9AZ` — letters-first, ends `\d[A-Z]{2}`. Never matches a US ZIP / NL / FR / CA code.
	{ re: /^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i, country: "GB" },
	// CA `K2P 1L4` — `A#A #A#`, ends `\d[A-Z]\d` (distinct from GB's `\d[A-Z]{2}`). The placer conflates CA
	// with US (English) / FR (Québec) at 0.9–1.0 confidence, same failure as GB; the format is unambiguous.
	{ re: /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i, country: "CA" },
	// IE Eircode `D02 AF30` — routing key (letter + 2 digits, or the D6W special) + a 4-alnum unique part.
	// The 4-char unique part is what separates it from GB's 3-char `\d[A-Z]{2}` inward (no real-code
	// overlap; Belfast `BT1 5GS` stays GB — Northern Ireland uses GB postcodes). The placer mis-routes IE
	// 5/5 (Cork→US 0.99, Drogheda→US 1.00) — the same conflation class as GB/CA.
	{ re: /^(?:[A-Z]\d{2}|D6W)\s?[A-Z\d]{4}$/i, country: "IE" },
	// NL PC6 is DELIBERATELY ABSENT: `\d{4} [A-Z]{2}` is forgeable in parse context — a US
	// house-number + directional fragment (`1234 NE`, `8990 SW`) matches it exactly, and this table
	// feeds recognizeBarePostcode, which must never touch a street name. NL lives in
	// countriesFromPostcodeFormat instead, whose consumers gate on a bare-postcode TREE.
]

/**
 * The country a parsed postcode's FORMAT implies, or null. See {@link POSTCODE_FORMAT_COUNTRY}.
 */
export function countryFromPostcodeFormat(postcode: string | undefined): string | null {
	const p = postcode?.trim()

	if (!p) return null

	for (const { re, country } of POSTCODE_FORMAT_COUNTRY) if (re.test(p)) return country

	return null
}

/**
 * Spaced `NNN NN` — the CZ/SK/SE/GR shared postcode space (#1589's `100 00`). Unlike the
 * {@link POSTCODE_FORMAT_COUNTRY} singles, this shape implies a SET: no single country owns it, so it can gate a
 * locale-inferred scope but never name one country outright.
 */
const SHARED_NNN_NN = /^\d{3} \d{2}$/

/**
 * NL PC6 (`1012 LG`) — digits-first then exactly two letters. NL-unique as a POSTCODE shape (GB/CA/IE are
 * letters-first; the digit-only families carry no letters), but too forgeable for {@link POSTCODE_FORMAT_COUNTRY}: a US
 * house-number + directional fragment (`1234 NE`) matches it, so it must never feed recognizeBarePostcode. It belongs
 * only here, where every consumer checks on a tree that IS a bare postcode.
 */
const NL_PC6 = /^\d{4}\s?[A-Z]{2}$/i

/**
 * EVERY country a parsed postcode's FORMAT is consistent with — the singles table, the NL PC6 shape, and the shared
 * `NNN NN` family. Empty when the shape implies nothing (a bare 5-digit reads US/FR/DE and more; that family stays with
 * the locale prior on purpose — the `75008` contract).
 *
 * Unlike {@link countryFromPostcodeFormat}, this is NOT an unforgeable-in-any-context claim: consumers (the resolver's
 * implied-set probe, the CLI's withheld-scope guard) apply it only to a tree that is a bare postcode, where the
 * street-fragment collision the singles table must exclude cannot arise.
 */
export function countriesFromPostcodeFormat(postcode: string | undefined): readonly string[] {
	const p = postcode?.trim()

	if (!p) return []

	const single = countryFromPostcodeFormat(p)

	if (single) return [single]

	if (NL_PC6.test(p)) return ["NL"]

	if (SHARED_NNN_NN.test(p)) return ["CZ", "SK", "SE", "GR"]

	return []
}
