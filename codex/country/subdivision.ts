/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   ISO 3166-2 subdivision → country reference, the cross-country complement to `country.ts`'s
 *   ISO 3166-1 `matchCountry`. A subdivision token ("QC", "Ontario", "Illinois") names a first-level
 *   admin unit whose COUNTRY is the piece the resolver needs when a region qualifier is the only
 *   signal that the locale-inferred default country is wrong ("Montreal QC" under a US locale).
 *
 *   Scope is deliberately minimal: the two subdivision systems whose two-letter codes people write
 *   ON THE ADDRESS LINE and whose homonymous localities collide across the border — US states
 *   (`us/state.ts`) and Canadian provinces (`ca/province.ts`). Both directions are covered: the ISO
 *   code (`QC` → Quebec) and the full name (`Quebec` / `Québec` → the `QC` record), so a resolver
 *   can expand the abbreviation the gazetteer FTS index lacks ("QC" is not an alt-name of Québec)
 *   into the full name it does carry. This is a soft prior, not a routing decision — the gazetteer
 *   still does the geographic confirmation (per the registry-backed-soft-prior doctrine).
 *
 *   The US and Canadian code sets are disjoint (no two-letter code, and no full name, collides
 *   between the two), so the combined lookup below is unambiguous. `CA` resolves to California the
 *   US state (Canada's provinces carry no `CA` subdivision code), never to Canada the country —
 *   country recognition stays with `matchCountry`.
 *
 *   Source: the underlying `US_STATE_BY_ABBREVIATION` (USPS Publication 28, Appendix B) and
 *   `CA_PROVINCES` (ISO 3166-2:CA) tables. No new provenance is introduced here — this module only
 *   re-keys those two existing tables into one subdivision→country view.
 */

import { CA_PROVINCES } from "../ca/province.ts"
import { US_STATE_BY_ABBREVIATION } from "../us/state.ts"

/** A resolved subdivision: its ISO 3166-2 code (sans country prefix), canonical English name, and ISO 3166-1 country. */
export interface SubdivisionMatch {
	/** ISO 3166-2 subdivision code without the country prefix (e.g. `QC` for `CA-QC`, `IL` for `US-IL`). */
	code: string
	/** Canonical English name (e.g. `Quebec`, `Illinois`). */
	name: string
	/** ISO 3166-1 alpha-2 country the subdivision belongs to (`CA`, `US`). */
	country: string
}

/** Strip diacritics + lowercase so `Québec`, `Quebec`, and `quebec` all key alike (mirrors `ca/province.ts`). */
function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/**
 * Folded surface form (ISO code, English name, or — for CA — co-official French name) → subdivision. Built once. US
 * states are inserted first and never overwritten, so on the (currently empty) event of a future code/name collision
 * the US entry wins deterministically; today the two sets are disjoint.
 */
const SUBDIVISION_LOOKUP: ReadonlyMap<string, SubdivisionMatch> = (() => {
	const out = new Map<string, SubdivisionMatch>()
	const put = (key: string, match: SubdivisionMatch): void => {
		const folded = foldName(key)

		if (folded.length > 0 && !out.has(folded)) {
			out.set(folded, match)
		}
	}

	for (const [code, name] of Object.entries(US_STATE_BY_ABBREVIATION)) {
		const match: SubdivisionMatch = { code, name, country: "US" }
		put(code, match)
		put(name, match)
	}

	for (const info of Object.values(CA_PROVINCES)) {
		const match: SubdivisionMatch = { code: info.code, name: info.name, country: "CA" }
		put(info.code, match)
		put(info.name, match)
		put(info.french, match)
	}

	return out
})()

/**
 * Resolve a first-level subdivision surface form (ISO 3166-2 code, English name, or co-official French name for CA;
 * accents optional) to its `{ code, name, country }`. Case- and diacritic-insensitive. Returns null for anything that
 * isn't a US state or Canadian province/territory — including bare country tokens (use {@link matchCountry} for
 * those).
 */
export function matchSubdivision(token: string | null | undefined): SubdivisionMatch | null {
	if (!token || typeof token !== "string") return null

	return SUBDIVISION_LOOKUP.get(foldName(token)) ?? null
}
