/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Both consumers use this expansion to compare parsed region qualifiers with stored keys.
 *   Admin-coherence verdicts (`mailwoman/admin-coherence.ts`) fold a qualifier and the winner's ancestry
 *   to decide `confirmed` or `contradicted`. The candidate backend's admin-containment re-rank
 *   (`candidate-lookup.ts`) uses the same fold to find region-class rows. The shared function keeps
 *   both decisions aligned.
 *
 *   Lives here rather than in `mailwoman` because the dependency points this way. `mailwoman`
 *   depends on `@mailwoman/resolver-wof-sqlite` (which owns the fold and already depends on codex),
 *   never the reverse.
 */

import { matchSubdivision, matchSubdivisionIn } from "@mailwoman/codex/country"

import { normalizeLocalityForKey } from "#street/normalize"

/**
 * The ancestry placetypes that answer for a parsed `region` qualifier,
 * WOF's admin band between country and locality.
 *
 * The full band covers qualifiers at any grain, such as "Lancashire"
 * (a ceremonial county) or "Thüringen" (a Land).
 * A qualifier may confirm against any level the backend stored.
 *
 * `contradicted` requires every level in the band to miss.
 * Widening the band makes the check more conservative.
 */
export const REGION_CLASS_PLACETYPES: ReadonlySet<string> = new Set(["region", "macroregion", "county", "macrocounty"])

/**
 * County-style qualifier prefixes stripped to produce a comparison variant.
 *
 * Ireland writes `Co. Westmeath` where WOF stores `Westmeath`, so the prefix defeats the fold
 * and every Irish county qualifier would read `contradicted`.
 * The stripped form is added to the key set, never substituted.
 *
 * `County Durham` is a real name that also matches after prefix removal.
 * Set union can only widen confirmation, so the closure is monotone.
 *
 * `contradicted → confirmed` is the only movement it can cause.
 */
const COUNTY_QUALIFIER_PREFIXES = ["county", "co.", "co"] as const

/**
 * Trailing admin-qualifier words, the suffix sibling of the prefix above.
 *
 * `San José Province` (CR board row) folds against stored `San José` only with the word removed.
 *
 * Same monotone rule.
 * The stripped form joins the set, never replaces the original.
 */
const ADMIN_QUALIFIER_SUFFIXES = ["province", "prov.", "prov"] as const

function withoutPrefix(value: string, prefixes: readonly string[]): string {
	const folded = value.toLowerCase()

	for (const prefix of prefixes) {
		if (!folded.startsWith(prefix) || !/\s/u.test(value[prefix.length] ?? "")) continue

		let offset = prefix.length

		while (/\s/u.test(value[offset] ?? "")) {
			offset++
		}

		return value.slice(offset)
	}

	return value
}

function withoutSuffix(value: string, suffixes: readonly string[]): string {
	const folded = value.toLowerCase()

	for (const suffix of suffixes) {
		const offset = value.length - suffix.length

		if (offset <= 0 || !folded.endsWith(suffix) || !/\s/u.test(value[offset - 1] ?? "")) continue

		let end = offset

		while (end > 0 && /\s/u.test(value[end - 1] ?? "")) {
			end--
		}

		return value.slice(0, end)
	}

	return value
}

/**
 * The comparable keys a region string expands to: its own fold (the shared candidate.db `name_key`
 * normalizer, {@link normalizeLocalityForKey}, so build side and check side agree by construction).
 *
 * A county-prefix-stripped variant.
 * The codex subdivision expansions.
 *
 * The disjoint US and CA table always, plus the country-scoped table when the caller knows a country.
 * `WA` under AU is Western Australia, while under US it is Washington,
 * the collision that keeps AU out of the unscoped table.
 *
 * Every expansion lands the canonical name and code folds in the set, so `IL`
 * and `Illinois`, or `WA` and `Western Australia`, meet from either side.
 */
export function regionKeys(value: string, countryAlpha2?: string): Set<string> {
	const keys = new Set([normalizeLocalityForKey(value)])

	for (const stripped of [
		withoutPrefix(value, COUNTY_QUALIFIER_PREFIXES),
		withoutSuffix(value, ADMIN_QUALIFIER_SUFFIXES),
	]) {
		if (stripped !== value && stripped.trim()) {
			keys.add(normalizeLocalityForKey(stripped))
		}
	}

	const expansions = [matchSubdivision(value), countryAlpha2 ? matchSubdivisionIn(countryAlpha2, value) : null]

	for (const subdivision of expansions) {
		if (subdivision) {
			keys.add(normalizeLocalityForKey(subdivision.name))
			keys.add(normalizeLocalityForKey(subdivision.code))
		}
	}

	// The empty fold stays in the set on purpose.
	// The admin-coherence verdicts have always compared the empty key
	// (two empty-folding strings intersect → `confirmed`), and this move must not shift a verdict.
	// A consumer probing a table by key filters the empty string out itself.
	return keys
}

/**
 * The probe-side expansion for a region qualifier, {@link regionKeys} plus the
 * county-prefixed variant of every key.
 *
 * The verdict implementation intersects two {@link regionKeys} sets, so `Co. Donegal`
 * meets stored `County Donegal` at the shared stripped key `donegal`.
 * A table probe matches the stored fold verbatim in one direction.
 *
 * WOF stores Irish counties under `county donegal`.
 * The table has no bare `donegal` key.
 *
 * The qualifier probe missed every Irish county until this variant landed.
 *
 * Adding `county <key>` restores the two-sidedness for the one stored-form family with an evidenced case.
 * The union is monotone because a wider qualifier set can only find more bearers.
 *
 * Each bearer must still contain a candidate before anything moves.
 *
 * The suffix sibling (`<key> province`) is deliberately absent.
 * The board has no case for this stored form.
 * Add one before building a change for this suffix.
 */
export function regionQualifierProbeKeys(value: string, countryAlpha2?: string): Set<string> {
	const keys = regionKeys(value, countryAlpha2)
	// Snapshot before widening: the loop adds `county <key>` members that must not themselves be revisited.
	const bare = [...keys]

	for (const key of bare) {
		if (key && !key.startsWith("county ")) {
			keys.add(`county ${key}`)
		}
	}

	return keys
}
