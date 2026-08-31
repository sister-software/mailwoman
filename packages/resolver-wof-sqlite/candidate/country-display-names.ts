/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Pass 1b of the candidate build — fold ICU's country display names onto the country rows.
 */

import { enumerateCountryDisplayNames } from "@mailwoman/codex/country"

import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import { normalizeLocalityForKey } from "#street-normalize"

/**
 * Fold every country surface ICU knows onto that country's candidate row (#1678 thread 1).
 *
 * A bare `格鲁吉亚` (Georgia the country) resolved to NOTHING while `佐治亚州` (Georgia the US state) resolved correctly, and
 * the model gave both the same wrong `locality` tag — so the tag was never the variable. Measured 2026-08-15: 140 of
 * 237 country rows are synthetic and carry a canonical English name and nothing else; WOF holds no Chinese country
 * names at all; and the GeoNames alias fold filters through a Latin-script regex, so neither existing source could ever
 * supply them.
 *
 * `Intl.DisplayNames` already knows every one — ~280 regions, ~5,244 surfaces, from the same ICU the runtime uses for
 * every other locale-sensitive operation. No download, no vendored corpus, no snapshot to drift.
 *
 * `is_primary = 0`: these are NAMES THE WORLD USES, not the country's canonical name. The display `name` stays whatever
 * the gazetteer already had, so resolving `格鲁吉亚` answers with the Georgia country row rather than renaming it.
 *
 * Returns the row count so the caller can report it — a zero means ICU supplied nothing, which is a different fact from
 * the pass not having run.
 */
export function stageCountryDisplayNames(ctx: {
	attrs: Map<number, PlaceAttrs>
	iso2ByID: Map<number, string>
	countryPtID: number
	stageRow: StageRow
	tx: { exec(sql: string): void }
}): number {
	// One country row per ISO2. Where a code has several (historic rows surviving the is_current filter), the most
	// populous wins — the same tiebreak the ranking uses everywhere else.
	const countryByISO2 = new Map<string, { sid: number; a: PlaceAttrs }>()

	for (const [sid, a] of ctx.attrs) {
		if (a.ptid !== ctx.countryPtID) continue

		const iso2 = ctx.iso2ByID.get(a.cid)

		if (!iso2 || iso2 === "??") continue

		const held = countryByISO2.get(iso2)

		if (!held || a.pop > held.a.pop) {
			countryByISO2.set(iso2, { sid, a })
		}
	}

	let staged = 0

	ctx.tx.exec("BEGIN")

	for (const { iso2, name } of enumerateCountryDisplayNames()) {
		const target = countryByISO2.get(iso2)

		if (!target) continue

		const k = normalizeLocalityForKey(name)

		// The country's own key is already staged as its primary; INSERT OR IGNORE at materialization dedupes the
		// rest, so this only skips the obvious self-alias.
		if (!k || k === target.a.pkey) continue

		ctx.stageRow(k, target.a, target.sid, 0)

		staged++
	}

	ctx.tx.exec("COMMIT")

	return staged
}
