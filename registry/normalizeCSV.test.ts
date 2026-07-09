/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { normalizeCSV } from "./ingest.ts"
import type { SourceRecord } from "./types.ts"

const dir = mkdtempSync(join(tmpdir(), "normalize-csv-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(name: string, text: string): string {
	const p = join(dir, name)
	writeFileSync(p, text)

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
		const p = fixture(
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
		const p = fixture("no-id.csv", "name,addr\nJohn Doe,1 A St\nJane Roe,2 B St\n")
		const recs = await collect(normalizeCSV(p, { mapping: { name: "name", address: "addr" } }))

		expect(recs.map((r) => r.id)).toEqual(["0", "1"])
	})
})
