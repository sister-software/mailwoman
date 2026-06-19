/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Corpus licensing — the single source of truth for the training-data license policy (#26).
 *
 *   Posture (operator, 2026-06-19): **exclusion is a deliberate act, not a silent default.** The
 *   build INCLUDES every row an adapter yields (stamping its `license`); a build that needs a clean
 *   license set — e.g. the proprietary `@mailwoman/neural-weights-*` weights, which must not
 *   inherit a share-alike obligation — PURPOSELY excludes kinds via `buildCorpus({ excludeLicenses
 *   })` (CLI `--exclude-licenses` / `--exclude-share-alike`). Nothing is dropped on a license
 *   string unless the operator named it. This avoids the trap of silently dropping allowed data
 *   mis-stamped with a conservative license (e.g. BAN, which is dual-licensed Licence Ouverte OR
 *   ODbL — we elect Licence Ouverte; a default-deny on the old `ODbL` stamp would have wrongly
 *   dropped 48M allowed rows).
 *
 *   Tier reference (#26): A = PD/CC0 (allowed); B = CC-BY / Licence Ouverte (allowed WITH attribution
 *   — the model card must carry it); C = share-alike (ODbL, CC-BY-SA, CC-SA) — exclude for a
 *   proprietary-weights build via `--exclude-share-alike`.
 */

/**
 * Licenses that require share-alike / create a copyleft obligation on derived works (Tier C). The
 * `--exclude-share-alike` convenience expands to this; `allowShareAlike: false` adapters also use
 * it.
 */
export const SHARE_ALIKE_PATTERN = /^ODbL|^Open Database License|^CC-BY-SA|^CC-SA/i

/**
 * Compile a `--exclude-licenses` spec (comma-separated, e.g. `"ODbL,CC-BY-SA"`) into anchored,
 * case-insensitive prefix patterns. Each entry matches a license string that STARTS with it, so
 * `CC-BY-SA` catches `CC-BY-SA-3.0`, `CC-BY-SA-4.0`, etc. Regex metacharacters are escaped — the
 * spec is a literal license prefix, not a user-supplied regex.
 */
export function compileLicenseExcludes(spec: string): RegExp[] {
	return spec
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => new RegExp("^" + s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))
}

/** True iff `license` matches any of the exclude `patterns` (empty patterns → never excluded). */
export function licenseExcluded(license: string | undefined, patterns: readonly RegExp[]): boolean {
	const l = license ?? ""
	return patterns.some((p) => p.test(l))
}
