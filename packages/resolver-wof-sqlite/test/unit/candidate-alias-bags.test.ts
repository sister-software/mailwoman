/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@link explodeAliasBags} — pass 2 of the candidate build, which turns each place's
 *   `place_search.alt_names` bag into distinct-key alias rows and counts the distinct keys a place
 *   ends up carrying.
 *
 *   The key count is not bookkeeping: it is the gloss detector's only volume signal, so what counts
 *   as "distinct" (folded, primary included, de-duplicated within the bag) is the contract, and it is
 *   asserted here directly rather than through a whole build.
 */

import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { ALIAS_SEPARATOR } from "@mailwoman/resolver-wof-sqlite/fts"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { describe, expect, test } from "vitest"

import { explodeAliasBags } from "#candidate/alias-bags"
import type { PlaceAttrs } from "#candidate/place-attrs"

/**
 * The separator `fts.ts` joins the bag with, space-padded and trailing, exactly as a real `place_search` row carries
 * it.
 */

function bag(...aliases: string[]): string {
	return aliases.join(` ${ALIAS_SEPARATOR} `) + ` ${ALIAS_SEPARATOR}`
}

function place(name: string): PlaceAttrs {
	return {
		cid: 1,
		rid: 0,
		ptid: 2,
		name,
		lat: 0,
		lon: 0,
		mnLat: 0,
		mnLon: 0,
		mxLat: 0,
		mxLon: 0,
		pop: 0,
		neg: 0,
		pkey: normalizeLocalityForKey(name),
		imp: null,
	}
}

interface Staged {
	k: string
	sid: number
	isPrimary: number
}

/**
 * An in-memory source carrying only the one table pass 2 reads, plus a staging sink that records calls instead of
 * writing rows — the pass owns the loop, not the storage.
 */
function run(rows: Array<{ id: number; alt: string | null }>, attrs: Map<number, PlaceAttrs>) {
	using src = DatabaseClient.temp<WOFDatabase>()
	using out = DatabaseClient.temp<CandidateDatabase>()

	src.exec("CREATE TABLE place_search (wof_id INTEGER PRIMARY KEY, alt_names TEXT)")

	const insert = src.prepare("INSERT INTO place_search VALUES (?, ?)")

	for (const row of rows) {
		insert.run(row.id, row.alt)
	}

	const staged: Staged[] = []

	const result = explodeAliasBags(src, out, attrs, (k, _a, sid, isPrimary) => {
		staged.push({ k, sid, isPrimary })
	})

	return { ...result, staged }
}

describe("explodeAliasBags", () => {
	test("stages one alias row per distinct folded key, always as a non-primary", () => {
		const attrs = new Map([[200, place("Chicago")]])
		const { nAlias, staged } = run([{ id: 200, alt: bag("Chi-Town", "Windy City") }], attrs)

		expect(nAlias).toBe(2)
		expect(staged.map((s) => s.k)).toEqual([normalizeLocalityForKey("Chi-Town"), normalizeLocalityForKey("Windy City")])
		expect(staged.every((s) => s.isPrimary === 0)).toBe(true)
		expect(staged.every((s) => s.sid === 200)).toBe(true)
	})

	test("skips an alias that folds onto the place's own primary key", () => {
		const attrs = new Map([[202, place("Saint-Étienne")]])
		// The diacritic-free spelling folds to the SAME key as the display name, so it is the place's
		// primary row, not a second alias.
		const { nAlias, keyCounts } = run([{ id: 202, alt: bag("Saint-Etienne", "St Etienne") }], attrs)

		expect(nAlias).toBe(1)
		expect(keyCounts.get(202)).toBe(2)
	})

	test("counts distinct keys, primary included, collapsing repeats within one bag", () => {
		const attrs = new Map([[204, place("Toledo")]])
		const { nAlias, keyCounts } = run([{ id: 204, alt: bag("Tolete", "TOLETE", "Toletum") }], attrs)

		expect(nAlias).toBe(2)
		// toledo + tolete + toletum — the repeat does not inflate the gloss detector's signal.
		expect(keyCounts.get(204)).toBe(3)
	})

	test("ignores rows for places the primaries pass never staged, and empty bags", () => {
		const attrs = new Map([[200, place("Chicago")]])

		const { nAlias, keyCounts, staged } = run(
			[
				{ id: 999, alt: bag("Ghost Town") },
				{ id: 200, alt: null },
			],
			attrs
		)

		expect(nAlias).toBe(0)
		expect(staged).toEqual([])
		// No key count for either: an unknown place has no place to hang one on, and a place whose bag is
		// absent is UNMEASURED, which the detector must not read as a low key count.
		expect(keyCounts.size).toBe(0)
	})
})
