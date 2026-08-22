/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath, repoRootPath } from "@mailwoman/core/utils"
import type { SourceRecord } from "@mailwoman/registry"
import { geocodeStream } from "mailwoman/geocode-stream"
import { describe, expect, it } from "vitest"

const fakeWorker = workspacePath("mailwoman", "test-fixtures", "fake-geocode-worker.js")

/**
 * What `fake-geocode-worker.js` writes into the `address` slot instead of a geocode: the config locale it was handed
 * and the number of mapped address columns. Reading it back is how the wiring becomes observable without a model.
 */
interface WiringEcho {
	tag: string
	cols: number
}

const echoOf = (record: SourceRecord): WiringEcho => record.address as unknown as WiringEcho

async function* records(n: number): AsyncIterableIterator<SourceRecord> {
	for (let i = 0; i < n; i++) {
		yield { id: String(i), raw: { addr: `addr ${i}` } } as SourceRecord
	}
}

describe("geocodeStream (wiring, fake worker)", () => {
	it("passes mapping + config to the worker and streams enriched records back", async () => {
		const out: SourceRecord[] = []

		for await (const r of geocodeStream(records(50), {
			mapping: { address: ["addr", "city"] },
			geocode: { wofDBPath: "/x.db", dataRoot: "/data", locale: "en-US", country: "US" },
			concurrency: 3,
			batchSize: 8,
			worker: fakeWorker,
		})) {
			out.push(r)
		}

		expect(out).toHaveLength(50)
		// Every record geocoded; config (locale) + mapping (address col count) reached the worker.
		expect(out.every((r) => echoOf(r).tag === "en-US")).toBe(true)
		expect(echoOf(out[0]!).cols).toBe(2)

		// Records preserved (set comparison — completion order).
		expect(out.map((r) => r.id).toSorted((a, b) => Number(a) - Number(b))).toEqual(
			Array.from({ length: 50 }, (_, i) => String(i))
		)
	})
})
