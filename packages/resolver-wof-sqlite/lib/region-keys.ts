/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The comparable-key expansion for a parsed REGION qualifier — one function, both consumers (the
 *   #861 rule). The admin-coherence verdicts (`mailwoman/admin-coherence.ts`) fold a qualifier and a
 *   winner-ancestry name through this to decide `confirmed`/`contradicted`; the candidate backend's
 *   admin-containment re-rank (#1717 stage 2, `candidate-lookup.ts`) folds the same qualifier through
 *   it to find the qualifier's own region-class rows in the candidate table. A check that says
 *   `contradicted` and a re-rank that cannot find the qualifier would otherwise be two readings of
 *   one string that silently disagree — the exact drift the shared-function rule exists to prevent.
 *
 *   Lives HERE rather than in `mailwoman` because the dependency points this way: `mailwoman`
 *   depends on `@mailwoman/resolver-wof-sqlite` (which owns the fold and already depends on codex),
 *   never the reverse.
 */

import { matchSubdivision, matchSubdivisionIn } from "@mailwoman/codex/country"

import { normalizeLocalityForKey } from "#street/normalize"

/**
 * The ancestry placetypes that answer for a parsed `region` qualifier — WOF's admin band between country and locality.
 * Deliberately the whole band: a qualifier stated at any grain ("Lancashire", a ceremonial county; "Thüringen", a Land)
 * may confirm against whichever level the backend stored, and `contradicted` requires the entire band to miss, so
 * widening the band only ever makes the check more conservative.
 */
export const REGION_CLASS_PLACETYPES: ReadonlySet<string> = new Set(["region", "macroregion", "county", "macrocounty"])

/**
 * County-style qualifier prefixes stripped to produce a comparison VARIANT. Ireland writes `Co. Westmeath` where WOF
 * stores `Westmeath`, so the prefix defeats the fold and every Irish county qualifier read `contradicted` on the first
 * board census (2026-08-17, five rows). The stripped form is ADDED to the key set, never substituted — `County Durham`
 * is a real name whose stripped variant simply also matches, and a set union can only widen confirmation, so the
 * closure is monotone: `contradicted → confirmed` is the only movement it can cause.
 */
const COUNTY_QUALIFIER_PREFIXES = ["county", "co.", "co"] as const

/**
 * Trailing admin-qualifier words, the suffix sibling of the prefix above: `San José Province` (CR board row) folds
 * against stored `San José` only with the word removed. Same monotone rule — the stripped form joins the set, never
 * replaces the original.
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
 * The comparable keys a region string expands to: its own fold (the shared candidate.db `name_key` normalizer,
 * {@link normalizeLocalityForKey} — build side and check side agree by construction); a county-prefix-stripped variant;
 * the codex subdivision expansions — the disjoint US+CA table always, plus the COUNTRY-SCOPED table when the caller
 * knows a country (`WA` under AU is Western Australia; under US, Washington — the collision that keeps AU out of the
 * unscoped table). Every expansion lands the canonical name and code folds in the set, so `IL`/`Illinois` and
 * `WA`/`Western Australia` meet from either side.
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

	// The empty fold stays IN the set on purpose — the admin-coherence verdicts have always compared
	// the empty key (two empty-folding strings intersect → `confirmed`), and this move must not shift
	// a verdict. A consumer probing a table by key filters the empty string out itself.
	return keys
}

/**
 * The PROBE-side expansion for a region qualifier — {@link regionKeys} plus the county-PREFIXED variant of every key.
 *
 * The verdict implementation intersects two {@link regionKeys} SETS, so `Co. Donegal` meets stored `County Donegal` at
 * the shared stripped key `donegal`. A table probe is one-sided: it matches the STORED fold verbatim, and WOF stores
 * Irish counties under `county donegal` with no bare `donegal` key (measured on the shipped candidate.db — the
 * qualifier probe missed every Irish county until this variant landed). Adding `county <key>` restores the
 * two-sidedness for the one stored-form family with an evidenced case; the union is monotone (a wider qualifier set can
 * only find more BEARERS, each of which must still genuinely contain a candidate before anything moves). The suffix
 * sibling (`<key> province`) is deliberately absent — no stored-form case has been evidenced, and a change without a
 * board does not get built.
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
