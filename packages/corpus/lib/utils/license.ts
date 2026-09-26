/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Corpus licensing — the single source of truth for the training-data license policy.
 *
 * Exclusion is a deliberate act rather than a silent default: the build includes every row an adapter
 * yields (stamping its `license`), and a build that needs a clean license set — e.g. the proprietary
 * `@mailwoman/neural-weights-*` weights, which must not inherit a share-alike obligation — excludes
 * kinds via `buildCorpus({ excludeLicenses })` (`--exclude-licenses` / `--exclude-share-alike`), so
 * no source is dropped on a license string unless the operator named it.
 *
 * Tiers: A = PD/CC0 (allowed); B = CC-BY / Licence Ouverte (allowed with attribution, which the model
 * card must carry); C = share-alike (ODbL, CC-BY-SA, CC-SA), excluded for a proprietary-weights build
 * via `--exclude-share-alike`.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"

/**
 * Licenses that require share-alike / create a copyleft obligation on derived works (Tier C);
 * `--exclude-share-alike` expands to this and `allowShareAlike: false` adapters also use it.
 */
export const SHARE_ALIKE_PATTERN = /^ODbL|^Open Database License|^CC-BY-SA|^CC-SA/i

/**
 * Compile a `--exclude-licenses` spec (comma-separated, e.g. `"ODbL,CC-BY-SA"`) into anchored,
 * case-insensitive prefix patterns, so `CC-BY-SA` catches `CC-BY-SA-3.0`; the spec is a literal
 * license prefix rather than a user-supplied regex, and regex metacharacters are escaped.
 */
export function compileLicenseExcludes(spec: string): RegExp[] {
	return extractDelimited(spec).map((s) => new RegExp("^" + escapeRegExp(s), "i"))
}

/**
 * True iff `license` matches any of the exclude `patterns`; empty patterns never exclude.
 */
export function licenseExcluded(license: string | undefined, patterns: readonly RegExp[]): boolean {
	const l = license ?? ""

	return patterns.some((p) => p.test(l))
}
