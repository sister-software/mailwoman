/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A license as four separate facts, where one string used to combine them.
 *
 *   A corpus row's `license` column holds whichever of these the writer had to hand. Measured over
 *   `v0.7.0-de-holdout` on 2026-09-26: 71 distinct values across 703,835,753 rows, of which 4 are SPDX
 *   identifiers covering 75,582,634 rows and 66 are prose covering 628,203,119, plus 50,000 rows at
 *   `null`. `Public Domain` labels 478,632,849 rows. `Licence Ouverte 2.0` labels 145,193,536 rows.
 *   Neither label is an SPDX identifier. This repository uses `LicenseRef-USGov-Public-Domain` and
 *   `etalab-2.0` for those values.
 *
 *   The recurring failures all came from reading one of these facts out of a field holding another. A
 *   share-alike filter written as `/^ODbL/` cannot see 120,000 rows whose text reads "Synthetic —
 *   OpenStreetMap venue + sub-venue names (ODbL, © OpenStreetMap contributors) …". A rights audit over
 *   the column reads sentences where it expects identifiers. An obligations lookup keyed on
 *   `etalab-2.0` finds no entry for `Licence Ouverte 2.0` and would report no obligation if its caller
 *   ignored `unrecognized`.
 *
 *   Store each fact in its own field: the grant is an expression, credit owed is attribution text,
 *   source material is provenance and user duties are obligations. The raw value remains available
 *   for later review against what the writer recorded.
 *
 *   **A value this cannot resolve reads `unresolved`, and that is a finding rather than a default.**
 *   `unresolved` means the obligations are unknown. That differs from knowing there are none.
 *   A caller deciding whether to publish or train must distinguish those cases. This type exists
 *   because a bare string made them easy to confuse.
 */

import { LicenseObligation, summarizeLicense } from "#license/obligations"

/**
 * Whether a license value has been mapped to an expression whose obligations are recorded.
 *
 * This states what reading the string achieved.
 * `@mailwoman/corpus/source-register` exports a separate `LicenseReviewState`.
 *
 * It records whether a person read and accepted a source's terms.
 * That state answers a different question about a different subject.
 */
export const LicenseResolution = {
	/**
	 * The expression is an SPDX identifier or a `LicenseRef` this repository defines.
	 * `KNOWN_OBLIGATIONS` records the expression's obligations.
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
	 * The credit the grant requires, recorded as a value.
	 */
	attribution: string | null
	/**
	 * Licence identifiers the raw text mentions, whether or not each is the grant on the row.
	 *
	 * A row rendered from an attested record can mention the upstream register's licence
	 * in its provenance prose while the row records a different grant.
	 * This field records those mentions separately so callers do not treat them as the grant.
	 */
	mentions: string[]
	/**
	 * The obligations of {@link LicenseRecord.expression}, empty where the resolution is `unresolved`.
	 */
	obligations: LicenseObligation[]
	resolution: LicenseResolution
}

/**
 * Repository-specific license values and the SPDX expression each one represents.
 *
 * Every entry is a value measured in a built corpus or a layer manifest.
 * A value absent from this map and from SPDX resolves to `unresolved` rather than to a guess.
 */
const EXPRESSION_ALIASES: ReadonlyMap<string, string> = new Map([
	// These values appear on 478,632,849 corpus rows. U.S. federal works have no copyright under
	// 17 U.S.C. § 105. SPDX has no identifier for that status, so this repository defines a `LicenseRef`.
	["Public Domain", "LicenseRef-USGov-Public-Domain"],
	["public domain", "LicenseRef-USGov-Public-Domain"],
	// 145,193,536 corpus rows.
	// The `ban` adapter maps BAN's attribution-only license to this expression.
	["Licence Ouverte 2.0", "etalab-2.0"],
	["Licence Ouverte 2.0 (Etalab)", "etalab-2.0"],
	// The `meta.license` value in `postalcode-ni-osm.db`, measured 2026-09-27.
	["Open Database License (ODbL) 1.0", "ODbL-1.0"],
	// The `meta.license` value in `postalcode-gb-codepoint.db`, measured 2026-09-27.
	// Its `meta.attribution` names Ordnance Survey Crown copyright and Royal Mail copyright.
	["Open Government Licence v3.0", "OGL-UK-3.0"],
	["Open Government Licence v.3.0", "OGL-UK-3.0"],
	// The `meta.license` value in `postalcode-geonames-tail.db`, measured 2026-09-27.
	// GB rows in that database also list OGL-UK-3.0.
	// Its `meta.license_gb` field states this value.
	// The builder's manifest records it too.
	["CC-BY 4.0 (GeoNames) — attribution required on redistribution", "CC-BY-4.0"],
	// The `meta.license` value in `postcode-locality-intl.db`, measured 2026-09-27.
	// The admin gazetteer's manifest reads Who's On First as `LicenseRef-WhosOnFirst-Mixed`.
	// The locality builder wrote this alias value.
	// This mapping preserves the builder's claim.
	["CC-BY 4.0 (Who's On First) — attribution required on redistribution", "CC-BY-4.0"],
	// The `database_meta.license` values in `localities-cz-districts.db`
	// and `localities-nz-linz.db`, measured 2026-09-27.
	["CC-BY-4.0, attribution GeoNames", "CC-BY-4.0"],
	["CC-BY-4.0, attribution Land Information New Zealand", "CC-BY-4.0"],
	// INEGI's own terms document mentions no Creative Commons license.
	// Retrieved 2026-09-27, retained at internal/strategy/rights-receipts/mx-gb-2026-09-27/.
	["Términos de Libre Uso de la Información del INEGI", "LicenseRef-INEGI-Terms"],
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

/**
 * Returns the attribution entries a model card records, from whichever field holds them.
 *
 * Published cards include the list under `training.data_attribution` or under a top-level
 * `attribution`, and a published card cannot change, so both spellings have to be read.
 * The first candidate holding at least one string wins.
 * Candidates that are not arrays of strings are skipped.
 *
 * The caller passes the field values rather than a card, because the card's own
 * shape belongs to the package that reads the file.
 *
 * @param candidates The card fields to try, in preference order.
 */
export function attributionEntries(...candidates: readonly unknown[]): string[] {
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue

		const entries = candidate.filter((entry): entry is string => typeof entry === "string")

		if (entries.length) return entries
	}

	return []
}

/**
 * Words whose presence in a parenthetical marks it as a license statement.
 *
 * Looser than {@link readLicenseRecord}'s own mention patterns on purpose.
 * Those answer which licence a string cites and resolve it to an identifier.
 *
 * This answers whether a parenthetical is a licence statement at all, so it accepts a bare family word
 * and a spelling of the word "license" in three languages, neither of which identifies a grant.
 */
const LICENSE_FAMILY_WORDS =
	/\b(?:CC0|CC-BY|CC|ODbL|ODC-By|PDDL|OGL|OGDL|KOGL|CDLA|Etalab|MIT|Apache|Licence|License|Lizenz)\b/iu

/**
 * Returns the license an attribution entry states in a parenthetical, verbatim.
 *
 * `LINZ-derived OpenAddresses NZ (CC-BY 4.0): …` yields `CC-BY 4.0`.
 * The text is returned as written rather than resolved to an identifier, because a
 * caller reporting on a published card has to quote the card's recorded value.
 *
 * Returns `null` when no parenthetical holds a license.
 * Some entries state their terms outside a parenthetical, so `null` describes what this
 * reader found rather than establishing that the entry states no license.
 * The caller keeps the verbatim entry beside the result.
 */
export function licenseNamedIn(entry: string): string | null {
	// An entry often opens with a parenthetical belonging to the dataset's own name,
	// such as "OpenAddresses PL — GUGiK / PRG (public, BDOT-derived)", so every
	// parenthetical is read rather than the first.
	for (const match of entry.matchAll(/\(([^()]{1,120})\)/gu)) {
		const inner = match[1]!.trim()

		// A parenthetical states a license when it includes a version number or a license family word.
		if (/\d/u.test(inner) || LICENSE_FAMILY_WORDS.test(inner)) return inner
	}

	return null
}
