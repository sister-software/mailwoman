/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { enumerateCountryDisplayNames } from "@mailwoman/codex/country"

import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Stages each country name that `Intl.DisplayNames` renders in the codex display-name
 * locales as a non-primary key on that country's candidate row.
 *
 * The row's display name is unchanged, so a query such as `格鲁吉亚` resolves to the existing Georgia row.
 *
 * @returns The number of rows staged; zero means ICU supplied no new names.
 */
export function stageCountryDisplayNames(ctx: {
	attrs: Map<number, PlaceAttrs>
	iso2ByID: Map<number, string>
	countryPtID: number
	stageRow: StageRow
	tx: { exec(sql: string): void }
}): number {
	const countryByISO2 = new Map<string, { sid: number; a: PlaceAttrs }>()

	for (const [sid, a] of ctx.attrs) {
		if (a.ptid !== ctx.countryPtID) continue

		const iso2 = ctx.iso2ByID.get(a.cid)

		if (!iso2 || iso2 === "??") continue

		const held = countryByISO2.get(iso2)

		if (!held || (a.pop ?? 0) > (held.a.pop ?? 0)) {
			countryByISO2.set(iso2, { sid, a })
		}
	}

	let staged = 0

	ctx.tx.exec("BEGIN")

	for (const { iso2, name } of enumerateCountryDisplayNames()) {
		const target = countryByISO2.get(iso2)

		if (!target) continue

		const k = normalizeLocalityForKey(name)

		if (!k || k === target.a.pkey) continue

		ctx.stageRow(k, target.a, target.sid, 0)

		staged++
	}

	ctx.tx.exec("COMMIT")

	return staged
}
