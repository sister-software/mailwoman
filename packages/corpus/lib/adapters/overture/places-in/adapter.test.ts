// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { describe, expect, it } from "vitest"

import { createOverturePlacesINAdapter } from "#adapters/overture/places-in/adapter"
import { escapeSQLString, openDuckDB } from "#parquet/duckdb"
import { useScratchDir } from "#test-kit"
import type { CanonicalRow } from "#types"

const scratch = useScratchDir("overture-places-in")

const STATES = new Set(["karnataka", "kerala", "mh"])

const adapter = createOverturePlacesINAdapter({
	regionNames: async () => ({ holds: (_country: string, region: string) => STATES.has(region.toLowerCase()) }),
})

interface Place {
	id: string
	freeform: string | null
	locality: string | null
	region: string | null
	postcode: string | null
}

function place(fields: Partial<Place>): Place {
	return {
		id: "08f61a8d0c1a2b3c",
		freeform: "32/1, 2nd Main Road, Jayanagar",
		locality: "Bengaluru",
		region: "Karnataka",
		postcode: "560082",
		...fields,
	}
}

/**
 * Writes `places` as the snapshot the fetcher writes and reads every row the adapter emits from it.
 */
async function rowsOf(places: readonly Place[]): Promise<CanonicalRow[]> {
	const json = scratch.path("places.ndjson")
	const parquet = scratch.path("places-in.parquet")

	await writeLocalTextFile(places.map((each) => stringifyJSON(each)).join("\n") + "\n", json)

	{
		using db = await openDuckDB({ threads: 1 })

		await db.run(
			`COPY (SELECT * FROM read_json('${escapeSQLString(json.toString())}', columns = {id: 'VARCHAR', freeform: 'VARCHAR', locality: 'VARCHAR', region: 'VARCHAR', postcode: 'VARCHAR'})) TO '${escapeSQLString(parquet.toString())}' (FORMAT parquet)`
		)
	}

	return Array.fromAsync(adapter.rows({ inputPath: parquet, country: "IN" }))
}

describe("overture-places-in adapter", () => {
	it("renders the premise number, the street, the sub-locality, the locality, the state and the PIN", async () => {
		const [row] = await rowsOf([place({})])

		expect(row!.components).toEqual({
			house_number: "32/1",
			street: "2nd Main Road",
			dependent_locality: "Jayanagar",
			locality: "Bengaluru",
			region: "Karnataka",
			postcode: "560082",
		})

		expect(row!.raw.startsWith("32/1, 2nd Main Road, Jayanagar, Bengaluru")).toBe(true)
		expect(row!.source_id).toBe("overture-places-in-08f61a8d0c1a2b3c")
	})

	it("renders the state before the PIN on some places and after it on others, the same way on every read", async () => {
		const places = Array.from({ length: 40 }, (_, i) => place({ id: `place-${i}` }))
		const first = await rowsOf(places)
		const second = await rowsOf(places)
		const tails = new Set(first.map((row) => row.raw.slice("32/1, 2nd Main Road, Jayanagar, Bengaluru".length)))

		// The codex's postal order and the written order `Bengaluru, Karnataka 560082` that WRITTEN_LAYOUTS adds.
		expect(tails.size).toBe(2)
		expect(tails).toContain(", Karnataka 560082")
		expect(second.map((row) => row.raw)).toEqual(first.map((row) => row.raw))
	})

	it("leaves out a state written as its ISO suffix or one the region names don't hold", async () => {
		const rows = await rowsOf([place({ id: "a", region: "MH" }), place({ id: "b", region: "Erode" })])

		expect(rows.map((row) => row.components.region)).toEqual([undefined, undefined])
	})

	it("emits no row for an unreadable PIN, locality or street line", async () => {
		const rows = await rowsOf([
			place({ id: "pin", postcode: "56008" }),
			place({ id: "sub-district", locality: "Thiruvallur Sub-District" }),
			place({ id: "numbered", locality: "Mundur 1" }),
			place({ id: "name", freeform: "Nidhin Peter" }),
			place({ id: "kept" }),
		])

		expect(rows.map((row) => row.source_id)).toEqual(["overture-places-in-kept"])
	})
})
