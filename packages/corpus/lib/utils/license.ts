/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus licensing — the training-data license policy, read from a row's obligations rather than from
 *   the shape of its license string.
 *
 *   Exclusion is a deliberate act rather than a silent default: the build includes every row an adapter
 *   yields (stamping its `license`), and a build that needs a license set carrying no share-alike
 *   obligation asks for {@linkcode LicensePolicy.ShareAlikeFree}, so no source is dropped unless the
 *   operator selected the policy.
 *
 *   The refusal reads `readLicenseRecord`, which resolves a value to an SPDX expression and looks up
 *   that expression's obligations. An anchored prefix match over the raw column cannot do this. Measured
 *   over `v0.7.0-de-holdout` on 2026-09-26, the column holds 71 distinct values across 703,835,753 rows,
 *   of which 4 are SPDX identifiers and 66 are prose. A row whose license reads "OpenStreetMap venue +
 *   sub-venue names (ODbL, © OpenStreetMap contributors) …" is share-alike-derived and starts with
 *   neither `ODbL` nor `CC-BY-SA`, so `/^ODbL/` admitted it.
 *
 *   Three refusal classes exist because they are different claims. A value that resolves to an
 *   expression carrying share-alike states the obligation. A value whose prose mentions a share-alike
 *   license while resolving to no expression is share-alike-derived without stating its own grant. A
 *   value that resolves to no expression has unknown obligations. Unknown obligations differ from an empty
 *   obligation set. Of these rows, 628,203,119 contain prose this repository writes about its own renderings. The
 *   third class is therefore reported rather than refused under {@linkcode LicensePolicy.ShareAlikeFree},
 *   and {@linkcode LicensePolicy.ResolvedOnly} refuses it for a caller that needs every grant stated.
 */

import { carriesShareAlike, mentionsShareAlike, readLicenseRecord } from "@mailwoman/core/license/record"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"

/**
 * Which rows a corpus build admits on the evidence of their license values.
 */
export const LicensePolicy = {
	/**
	 * Admit every row an adapter yields, whatever its license value states.
	 * The policy a measurement runs under.
	 */
	All: "all",
	/**
	 * Refuse a row whose license imposes a share-alike obligation.
	 *
	 * Also refuse a row whose license text mentions a share-alike license while stating no grant of its own.
	 *
	 * A row whose license resolves to no expression and mentions no share-alike license is admitted
	 * and counted, because its obligations are unknown rather than known to include share-alike.
	 */
	ShareAlikeFree: "share-alike-free",
	/**
	 * Apply all refusals from {@linkcode LicensePolicy.ShareAlikeFree}.
	 * Also refuse a row whose license resolves to no expression.
	 *
	 * Measured over `v0.7.0-de-holdout`, this refuses 628,203,119 of 703,835,753 rows,
	 * so a caller asking for it is asking for the subset whose grant is stated as an identifier.
	 */
	ResolvedOnly: "resolved-only",
} as const

/**
 * One of the {@linkcode LicensePolicy} values.
 */
export type LicensePolicy = (typeof LicensePolicy)[keyof typeof LicensePolicy]

/**
 * Why a row's license value kept it out of the corpus, counted separately per class
 * because the classes rest on different evidence.
 */
export const LicenseRefusalKind = {
	/**
	 * The operator supplied this license prefix in `--exclude-licenses`.
	 */
	OperatorExcluded: "operator-excluded",
	/**
	 * The value resolves to an expression whose recorded obligations include share-alike.
	 */
	ShareAlikeCarried: "share-alike-carried",
	/**
	 * The value's text mentions a share-alike license while resolving to no expression of its own.
	 */
	ShareAlikeMentioned: "share-alike-mentioned",
	/**
	 * The value resolves to no expression, so its obligations are unknown.
	 */
	Unresolved: "unresolved",
} as const

/**
 * One of the {@linkcode LicenseRefusalKind} values.
 */
export type LicenseRefusalKind = (typeof LicenseRefusalKind)[keyof typeof LicenseRefusalKind]

/**
 * What a license value means for a build, decided once per distinct value.
 */
export interface LicenseVerdict {
	/**
	 * Why the row was refused, or `null` when the policy admits it.
	 */
	refusal: LicenseRefusalKind | null
	/**
	 * Whether the value resolves to an expression whose obligations are recorded.
	 *
	 * An admitted row reading `false` here entered with unknown obligations.
	 */
	resolved: boolean
	/**
	 * Whether the value's text mentions a share-alike license, whether or not it was refused for it.
	 */
	mentionsShareAlike: boolean
}

/**
 * Compile an `--exclude-licenses` spec (comma-separated, e.g. `"ODbL,CC-BY-SA"`) into anchored,
 * case-insensitive prefix patterns, so `CC-BY-SA` catches `CC-BY-SA-3.0`.
 *
 * The spec is a literal license prefix the operator typed.
 * Regex metacharacters are escaped.
 *
 * This is the one place a prefix match is the right reading, because the operator
 * is naming a spelling rather than asking about an obligation.
 */
export function compileLicenseExcludes(spec: string): RegExp[] {
	return extractDelimited(spec).map((s) => new RegExp("^" + escapeRegExp(s), "i"))
}

/**
 * True when `license` matches any of the operator's exclude `patterns`; empty patterns never exclude.
 */
export function licenseExcluded(license: string | null, patterns: readonly RegExp[]): boolean {
	const l = license ?? ""

	return patterns.some((p) => p.test(l))
}

/**
 * Reads one license value against a policy.
 *
 * This resolves an expression and runs the mention patterns on every call.
 * A corpus build asks about hundreds of millions of rows holding tens of distinct values,
 * so a row loop calls {@linkcode createLicenseVerdictCache} instead.
 */
export function licenseVerdict(
	license: string | null,
	policy: LicensePolicy,
	excluded: readonly RegExp[] = []
): LicenseVerdict {
	const record = readLicenseRecord(license)
	const resolved = record.expression !== null
	const mentions = mentionsShareAlike(record)

	const verdict = (refusal: LicenseRefusalKind | null): LicenseVerdict => ({
		refusal,
		resolved,
		mentionsShareAlike: mentions || carriesShareAlike(record),
	})

	if (licenseExcluded(license, excluded)) return verdict(LicenseRefusalKind.OperatorExcluded)

	if (policy === LicensePolicy.All) return verdict(null)

	if (carriesShareAlike(record)) return verdict(LicenseRefusalKind.ShareAlikeCarried)

	if (mentions) return verdict(LicenseRefusalKind.ShareAlikeMentioned)

	if (!resolved && policy === LicensePolicy.ResolvedOnly) return verdict(LicenseRefusalKind.Unresolved)

	return verdict(null)
}

/**
 * One license value in a built corpus that a share-alike-free reading refuses, with its row count.
 */
export interface ShareAlikeFinding {
	/**
	 * The value exactly as the corpus stores it.
	 */
	license: string
	/**
	 * Rows the built manifest counts under this value.
	 */
	rows: number
	kind: LicenseRefusalKind
}

/**
 * Every license value in a built corpus's license set that imposes or mentions share-alike.
 *
 * Takes the `licenses` map recorded by `BuildCorpusManifest`.
 * The map counts the rows adapters yielded.
 *
 * A caller about to move or publish a corpus reads this rather than its own list of source ids,
 * because the obligation is a property of the license value on the row.
 *
 * Ordered by row count, most rows first.
 */
export function shareAlikeFindings(licenses: Readonly<Record<string, number>>): ShareAlikeFinding[] {
	const findings: ShareAlikeFinding[] = []

	for (const [license, rows] of Object.entries(licenses)) {
		const { refusal } = licenseVerdict(license, LicensePolicy.ShareAlikeFree)

		if (refusal) {
			findings.push({ license, rows, kind: refusal })
		}
	}

	return findings.toSorted((a, b) => b.rows - a.rows)
}

/**
 * A license reading memoized per distinct raw value, for a loop over corpus rows.
 */
export interface LicenseVerdictCache {
	/**
	 * The verdict for this value under the policy this cache was built with.
	 */
	read(license: string | null): LicenseVerdict
	/**
	 * Every distinct value refused so far, with the class it was refused under,
	 * so a build that dropped rows reports which values caused each drop.
	 */
	refusedValues(): Map<string, LicenseRefusalKind>
}

/**
 * Builds a cache that reads each distinct license value once.
 *
 * The corpus holds tens of distinct values over hundreds of millions of rows,
 * so the memo turns one expression resolution per row into one per value.
 */
export function createLicenseVerdictCache(
	policy: LicensePolicy,
	excluded: readonly RegExp[] = []
): LicenseVerdictCache {
	const verdicts = new Map<string, LicenseVerdict>()
	const refused = new Map<string, LicenseRefusalKind>()

	return {
		read(license) {
			const key = license ?? ""
			const cached = verdicts.get(key)

			if (cached) return cached

			const verdict = licenseVerdict(license, policy, excluded)

			verdicts.set(key, verdict)

			if (verdict.refusal) {
				refused.set(key, verdict.refusal)
			}

			return verdict
		},
		refusedValues() {
			return new Map(refused)
		},
	}
}
