/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Admin-match predicates — does a resolved place count as the row's expected locality or region?
 *
 *   OpenAddresses carries no WOF id, so the match is by NAME, and each side writes the name its own way: a USPS abbrev
 *   against a canonical state name, a district-qualified gold locality against WOF's bare one. Every allowance here is
 *   provenance-first (the place's OWN recorded names and ancestry) so it can only ADD credit to an already-correct
 *   place — never launder a wrong one.
 */

import { lookupGermanState } from "@mailwoman/codex/de"
import { lookupFrenchRegion } from "@mailwoman/codex/fr"
import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import type { Resolved } from "./tree-hits.ts"

/**
 * Shortest token distinctive enough to carry matching weight; shorter ones are articles and directionals.
 */
const MIN_DISTINCTIVE_TOKEN_LENGTH = 4

/**
 * Shortest qualifier still meaningful when comparing an address's trailing parts.
 */
const MIN_QUALIFIER_LENGTH = 3

const norm = (s: string | undefined): string => (s ?? "").toLowerCase().trim()

/**
 * Aggressive name normalization for gazetteer-alias locality matching. Lowercases, strips diacritics + punctuation,
 * expands the universal US place abbreviations (St→Saint, Mt→Mount, Ft→Fort, Ste→Sainte), and de-spaces "Mc X" → "McX".
 * Deliberately does NOT strip civic suffixes (City/Town/Township/Village): in New England "Barre City" and "Barre Town"
 * are DISTINCT municipalities, so collapsing them would over-credit genuine wrong-place misses. Pair with the WOF
 * altname set (a place's own recorded variants) rather than loosening here.
 */
const ABBR: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount", ft: "fort" }

const normName = (s: string | undefined): string => {
	if (!s) return ""

	const x = s
		.toLowerCase()
		.normalize("NFD")
		.replaceAll(/[\u0300-\u036F]/g, "") // drop diacritics
		.replaceAll(/[^a-z0-9]+/g, " ") // punctuation/hyphens → space (Butte-Silver Bow → butte silver bow)
		.trim()

	const toks = x
		.split(" ")
		.filter((token) => token.length > 0)
		.map((t) => ABBR[t] ?? t)

	return toks
		.join(" ")
		.replaceAll(/\bmc (\w)/g, "mc$1")
		.replaceAll(/\s+/g, " ")
		.trim()
}

/**
 * Resolved region names are the gazetteer's CANONICAL full names ("California", "District of Columbia"); OA's
 * expected.region is the USPS abbreviation ("CA", "DC"). Map full name → abbrev so region-match compares
 * like-for-like.
 *
 * Derived from `@mailwoman/codex/us`, the same place the German and French lookups above come from — the table this
 * replaced was embedded because the codex "has no exports map", which has not been true for some time. It carried 52 of
 * the codex's 56 entries, agreeing on every one; the four it lacked are Guam, the US Virgin Islands, the Northern
 * Marianas and American Samoa, whose rows could not match on region at all.
 */
const STATE_NAME_TO_ABBR: Record<string, string> = Object.fromEntries(
	Object.entries(US_STATE_BY_ABBREVIATION).map(([abbreviation, name]) => [norm(name), abbreviation])
)

/**
 * True if the resolved region matches the expected one, comparing like-for-like across the surface forms each side
 * uses. Three paths, tried in order:
 *
 * 1. Verbatim — both already the same string (US `Berlin`==`Berlin`, or two identical abbrevs).
 * 2. US — the resolver returns a state's CANONICAL full name (`California`) while OA's expected is the USPS abbrev (`CA`);
 *    map full name → abbrev so they compare.
 * 3. DE — the resolver returns WOF's ENGLISH exonym (`Saxony`) while OA's expected is the German name (`Sachsen`);
 *    `lookupGermanState` folds code / German name / English name → one ISO 3166-2:DE code on BOTH sides. Strict:
 *    distinct states (Bavaria vs Saxony) still miss, so this corrects the cross-language mismatch without loosening a
 *    genuine wrong-region.
 * 4. FR — `lookupFrenchRegion` folds an ISO 3166-2:FR code or a région name (accents optional) to one code on both sides,
 *    the same diacritic-insensitive fix for `Île-de-France` vs `Ile-de-France`.
 *
 * The code spaces don't overlap on real inputs (a USPS abbrev is never a German or French region name, and the
 * German/French names are disjoint), so trying all of them is safe regardless of the row's country.
 */
export function regionMatches(resolvedName: string | undefined, expected: string | undefined): boolean {
	if (!resolvedName || !expected) return false
	const exp = norm(expected)
	const got = norm(resolvedName)

	if (got === exp) return true

	if (STATE_NAME_TO_ABBR[got]?.toLowerCase() === exp) return true
	const gotDe = lookupGermanState(resolvedName)

	if (gotDe !== null && gotDe === lookupGermanState(expected)) return true
	const gotFr = lookupFrenchRegion(resolvedName)

	return gotFr !== null && gotFr === lookupFrenchRegion(expected)
}

/**
 * Grades one resolved locality node against the row's expected locality name.
 */
export type LocalityMatcher = (expected: string | undefined, locNode: Resolved | undefined) => boolean

/**
 * The locality-credit predicate: does the resolved place count as OA's expected locality?
 *
 * Two allowances, both provenance-first (no hardcoded name lists), both able only to ADD credit to an already-correct
 * place: WOF alias names (Butte ↔ Butte-Silver Bow, Saint ↔ St. Johnsbury) and gold's regional qualifiers when they
 * match the place's OWN ancestry (#386: `Plauen Vogtl` → Plauen, whose county is Vogtlandkreis). Different WOF ids
 * carry disjoint name sets, so Saint Albans never matches St. Johnsbury.
 *
 * The admin shard is opened read-only and both lookups are cached behind a near-miss, so the cost is negligible. The
 * handle lives as long as the eval — the process exit closes it.
 */
export function buildLocalityMatcher(adminShardPath: string): LocalityMatcher {
	// Gazetteer-alias locality matching. A resolved place counts as a locality match if OA's
	// expected name equals ANY of that place's WOF `names` rows (normalized) — not just its
	// single canonical name. This credits forms WOF records as the SAME place (Butte ↔
	// Butte-Silver Bow, Saint ↔ St. Johnsbury, Mt ↔ Mount Pleasant) WITHOUT loosening genuine
	// wrong-place misses: different WOF ids carry disjoint name sets, so Saint Albans never
	// matches St. Johnsbury. The admin db (shard 0) is opened read-only; `names` is indexed on
	// id, and lookups are cached + only fire on a near-miss, so the cost is negligible.
	const adminDB = new DatabaseClient<WOFDatabase>(adminShardPath, { readOnly: true })
	const namesStmt = adminDB.prepare("SELECT name FROM names WHERE id = ?")
	const altCache = new Map<number, Set<string>>()

	const altNamesFor = (id: number): Set<string> => {
		let set = altCache.get(id)

		if (!set) {
			set = new Set<string>()

			for (const r of namesStmt.all(id) as { name: string }[]) {
				const n = normName(r.name)

				if (n) {
					set.add(n)
				}
			}

			altCache.set(id, set)
		}

		return set
	}

	// Hierarchy-aware regional-qualifier credit (#386). OpenAddresses tags many German localities with
	// a disambiguating district suffix WOF's canonical name drops — gold `Plauen Vogtl`/`Chemnitz Sachs`
	// resolve to `Plauen`/`Chemnitz` (the point lands inside; PIP confirms it), but a bare string compare
	// reads a miss. Rather than a hardcoded suffix blacklist (a provenance-first violation), credit
	// the qualifier ONLY when it matches the resolved place's OWN WOF ancestry: `Vogtl`→county `Vogtland`,
	// `Sachs`→region `Sachsen`. List-free and non-gameable — a genuinely wrong place won't carry the
	// gold's qualifier among its ancestors. `und`/non-latin ancestor names normalize to empty under
	// normName (Cyrillic/CJK are stripped), so the token set is latin-only without a language filter.
	const ancestorNamesStmt = adminDB.prepare(
		"SELECT nm.name FROM ancestors a JOIN names nm ON nm.id = a.ancestor_id " +
			"WHERE a.id = ? AND a.ancestor_placetype IN ('county', 'region', 'macrocounty', 'macroregion')"
	)

	const ancestorTokCache = new Map<number, Set<string>>()

	const ancestorTokensFor = (id: number): Set<string> => {
		let set = ancestorTokCache.get(id)

		if (!set) {
			set = new Set<string>()

			for (const r of ancestorNamesStmt.all(id) as { name: string }[]) {
				for (const t of normName(r.name).split(" "))
					if (t.length >= MIN_DISTINCTIVE_TOKEN_LENGTH) {
						set.add(t)
					}
			}

			ancestorTokCache.set(id, set)
		}

		return set
	}

	const localityMatches = (expected: string | undefined, locNode: Resolved | undefined): boolean => {
		if (!expected || !locNode) return false
		const e = normName(expected)

		if (!e) return false

		if (normName(locNode.name) === e || altNamesFor(locNode.id).has(e)) return true
		// Near-miss: gold `<resolved name> <qualifier…>`. Credit only when EVERY trailing qualifier is an
		// abbreviation-prefix (≥3 chars) of one of the resolved place's ancestor-name tokens. The base
		// must equal the resolved name exactly, so this can only ADD credit to an already-correct place.
		const base = normName(locNode.name)

		if (base && e.startsWith(base + " ")) {
			const quals = e
				.slice(base.length + 1)
				.split(" ")
				.filter((qualifier) => qualifier.length > 0)

			const anc = ancestorTokensFor(locNode.id)

			if (quals.length && quals.every((q) => q.length >= MIN_QUALIFIER_LENGTH && [...anc].some((a) => a.startsWith(q))))
				return true
		}

		return false
	}

	return localityMatches
}
