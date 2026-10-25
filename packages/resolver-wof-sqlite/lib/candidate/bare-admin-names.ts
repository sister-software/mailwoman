/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A candidate build pass that keys each admin place under its bare name as well as its full one.
 */

import { bareAdminName } from "@mailwoman/codex/country/bare-admin-names"

import type { PlaceAttrs, StageRow } from "#candidate/place-attrs"
import { normalizeLocalityForKey } from "#street/normalize"

/**
 * Stages an alias row under the bare form of every place name a country writes with an admin-unit suffix.
 *
 * A bare `渋谷` otherwise reaches only the places whose full name is `渋谷`, a Hyogo
 * and a Chiba locality with no recorded population, and never Tokyo's `渋谷区`.
 * The alias row carries the ward's own population, so the candidate ordering
 * ranks it above the unmeasured exact matches.
 *
 * @returns The number of alias rows staged.
 */
export function stageBareAdminNames(ctx: {
	attrs: Map<number, PlaceAttrs>
	iso2ByID: Map<number, string>
	stageRow: StageRow
	tx: { exec(sql: string): void }
}): number {
	let staged = 0

	ctx.tx.exec("BEGIN")

	for (const [sid, a] of ctx.attrs) {
		const iso2 = ctx.iso2ByID.get(a.cid)

		if (!iso2) continue

		const bare = bareAdminName(iso2, a.name)

		if (!bare) continue

		const key = normalizeLocalityForKey(bare)

		if (!key || key === a.pkey) continue

		ctx.stageRow(key, a, sid, 0)

		staged++
	}

	ctx.tx.exec("COMMIT")

	return staged
}
