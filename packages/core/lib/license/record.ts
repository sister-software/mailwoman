/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A license as four separate facts, where one string used to carry all of them.
 *
 *   A corpus row's `license` column holds whichever of these the writer had to hand. Measured over
 *   `v0.7.0-de-holdout` on 2026-09-26: 71 distinct values across 703,835,753 rows, of which 4 are SPDX
 *   identifiers covering 75,582,634 rows and 66 are prose covering 628,203,119, plus 50,000 rows at
 *   `null`. `Public Domain` labels 478,632,849 rows and `Licence Ouverte 2.0` labels 145,193,536, and
 *   neither is an SPDX identifier where this repository's own are `LicenseRef-USGov-Public-Domain` and
 *   `etalab-2.0`.
 *
 *   The recurring failures all came from reading one of these facts out of a field holding another. A
 *   share-alike filter written as `/^ODbL/` cannot see 120,000 rows whose text reads "Synthetic —
 *   OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) …". A rights audit over
 *   the column reads sentences where it expects identifiers. An obligations lookup keyed on
 *   `etalab-2.0` finds no entry for `Licence Ouverte 2.0` and would report no obligation if its caller
 *   ignored `unrecognized`.
 *
 *   So: the grant is an expression, the credit owed is attribution text, what the row was built from is
 *   provenance, and what a user must do is obligations. This separates them and keeps the raw value, so
 *   a reading can be revisited against what the writer actually wrote.
 *
 *   **A value this cannot resolve reads `unresolved`, and that is a finding rather than a default.**
 *   `unresolved` means the obligations are unknown, which is different from knowing there are none. A
 *   caller deciding whether to publish or to train has to treat the two differently, and the whole
 *   reason this type exists is that a bare string let them be confused.
 */

import { LicenseObligation, summarizeLicense } from "#license/obligations"

/**
 * Whether a license value has been mapped to an expression whose obligations are recorded.
 *
 * This states what reading the string achieved.
 * `@mailwoman/corpus/source-register` exports a separate `LicenseReviewState`
 * recording whether a person has read a source's terms and elected them,
 * which is a different question about a different subject.
 */
export const LicenseResolution = {
	/**
	 * The expression is an SPDX identifier or a `LicenseRef` this repository defines,
	 * and `KNOWN_OBLIGATIONS` records its obligations.
	 */
	Resolved: "resolved",
	/**
	 * No expression was determinable from the value.
	 * The obligations are unknown.
	 */
	Unresolved: "unresolved",
} as const

/**
 * One of the {@link LicenseResolution} values.
 */
export type LicenseResolution = (typeof LicenseResolution)[keyof typeof LicenseResolution]

/**
 * A license as the four facts a caller asks about separately.
 */
export interface LicenseRecord {
	/**
	 * The value as written, preserved so a reading can be checked against its source.
	 */
	raw: string
	/**
	 * The SPDX expression the grant resolves to, or `null` where the value states none.
	 */
	expression: string | null
	/**
	 * The credit the grant requires, where the value carries it.
	 */
	attribution: string | null
	/**
	 * Licence identifiers the raw text mentions, whether or not each is the grant on the row.
	 *
	 * A row rendered from an attested record can name the upstream register's licence in
	 * its provenance prose while the grant on the row is something else.
	 * These are what the text mentions, and reading them as the grant is the
	 * mistake this field exists to make visible.
	 */
	mentions: string[]
	/**
	 * The obligations of {@link LicenseRecord.expression}, empty where the resolution is `unresolved`.
	 */
	obligations: LicenseObligation[]
	resolution: LicenseResolution
}

/**
 * Values this repository writes that are not SPDX identifiers, and the expression each one means.
 *
 * Every entry is a value measured in a built corpus or a layer manifest.
 * A value absent from this map and from SPDX resolves to `unresolved` rather than to a guess.
 */
const EXPRESSION_ALIASES: ReadonlyMap<string, string> = new Map([
	// 478,632,849 corpus rows. US federal works carry no copyright under 17 U.S.C. § 105, and SPDX has
	// no identifier for that, which is why the `LicenseRef` exists.
	["Public Domain", "LicenseRef-USGov-Public-Domain"],
	["public domain", "LicenseRef-USGov-Public-Domain"],
	// 145,193,536 corpus rows.
	// BAN's attribution-only half, which the `ban` adapter elects.
	["Licence Ouverte 2.0", "etalab-2.0"],
	["Licence Ouverte 2.0 (Etalab)", "etalab-2.0"],
])

/**
 * Licence identifiers worth recognizing inside prose, with the spelling each one appears under.
 *
 * Ordered longest-first so `CC-BY-SA` is found before `CC-BY`.
 */
const MENTIONABLE: ReadonlyArray<readonly [pattern: RegExp, identifier: string]> = [
	[/Open Database Licen[cs]e|\bODbL\b/i, "ODbL-1.0"],
	[/\bODC-By\b/i, "ODC-By-1.0"],
	[/\bCC-?BY-?SA\b/i, "CC-BY-SA-4.0"],
	[/\bCC0\b/i, "CC0-1.0"],
	[/\bCC-?BY\b(?!-?SA)/i, "CC-BY-4.0"],
	[/\bCDLA-Permissive-2\.0\b/i, "CDLA-Permissive-2.0"],
	[/\bOGL\b|Open Government Licen[cs]e/i, "OGL-UK-3.0"],
	[/Licence Ouverte/i, "etalab-2.0"],
]

/**
 * Reads a license column value as four separate facts.
 *
 * A value that resolves to an expression whose obligations are recorded reads `resolved`.
 * Everything else reads `unresolved` with empty obligations, including a value
 * whose prose mentions a licence.
 *
 * A sentence mentioning ODbL does not establish that ODbL is the grant on the row.
 */
export function readLicenseRecord(raw: string | null | undefined): LicenseRecord {
	const text = raw ?? ""
	const mentions: string[] = []

	for (const [pattern, identifier] of MENTIONABLE) {
		if (pattern.test(text) && !mentions.includes(identifier)) {
			mentions.push(identifier)
		}
	}

	const aliased = EXPRESSION_ALIASES.get(text.trim())
	const candidate = aliased ?? text.trim()
	const summary = candidate ? summarizeLicense(candidate) : undefined

	if (summary && summary.identifiers.length && !summary.unrecognized.length) {
		return {
			raw: text,
			expression: candidate,
			attribution: null,
			mentions,
			obligations: summary.obligations,
			resolution: LicenseResolution.Resolved,
		}
	}

	return {
		raw: text,
		expression: null,
		attribution: null,
		mentions,
		obligations: [],
		resolution: LicenseResolution.Unresolved,
	}
}

/**
 * Whether a record establishes a share-alike obligation on the rows it labels.
 *
 * True only for a resolved expression whose obligations include it.
 * A record mentioning ODbL in prose is reported by {@link mentionsShareAlike} instead,
 * because those are different claims and a release decision needs to tell them apart.
 */
export function carriesShareAlike(record: LicenseRecord): boolean {
	return record.obligations.includes(LicenseObligation.ShareAlike)
}

/**
 * Whether a record's text mentions a share-alike licence without establishing it as the grant.
 *
 * This is the case `/^ODbL/` over the raw column could never see: a row whose license reads
 * "Synthetic — OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) …"
 * mentions a share-alike licence in its provenance while its own expression is unresolved.
 */
export function mentionsShareAlike(record: LicenseRecord): boolean {
	return (
		!carriesShareAlike(record) &&
		record.mentions.some((identifier) => identifier === "ODbL-1.0" || identifier === "CC-BY-SA-4.0")
	)
}
