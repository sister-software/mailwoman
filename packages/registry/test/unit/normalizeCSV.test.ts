/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { normalizeCSV } from "@mailwoman/registry/ingest"
import type { SourceRecord } from "@mailwoman/registry/types"
import { afterAll, describe, expect, it } from "vitest"

const dir = await temporaryDirectory("normalize-csv-")
afterAll(() => dir[Symbol.asyncDispose]())

async function fixture(name: string, text: string): Promise<string> {
	const p = dir.resolve(name)
	await writeLocalFile(text, p)

	return p
}

async function collect(gen: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
	const out: SourceRecord[] = []

	for await (const r of gen) {
		out.push(r)
	}

	return out
}

const MAPPING = { id: "id", name: "name", organization: "org", address: ["addr", "city", "state"] }

describe("normalizeCSV", () => {
	it("streams normalized records (name parsed, org canonicalized, no geocode)", async () => {
		const p = await fixture(
			"people.csv",
			"id,name,org,addr,city,state\n" +
				"c1,Dr. Robert Smith,Acme Health LLC,123 Main St,Portland,OR\n" +
				"c2,Maria Garcia,,50 Elm Ave,Seattle,WA\n"
		)

		const recs = await collect(normalizeCSV(p, { mapping: MAPPING }))

		expect(recs).toHaveLength(2)
		expect(recs[0]!.id).toBe("c1")
		expect(recs[0]!.name?.family).toBe("Smith")
		expect(recs[0]!.organization).toBeTruthy()
		expect(recs[0]!.address).toBeUndefined() // normalize never geocodes
		expect(recs[0]!.raw).toMatchObject({ addr: "123 Main St", state: "OR" })
		expect(recs[1]!.organization).toBeUndefined() // empty org column
	})

	it("falls back to the row index for a missing id", async () => {
		const p = await fixture("no-id.csv", "name,addr\nJohn Doe,1 A St\nJane Roe,2 B St\n")
		const recs = await collect(normalizeCSV(p, { mapping: { name: "name", address: "addr" } }))

		expect(recs.map((r) => r.id)).toEqual(["0", "1"])
	})
})
