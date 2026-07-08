/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPathBuilder } from "@mailwoman/core/utils"
import type { SourceRecord } from "@mailwoman/registry"
import { describe, expect, it } from "vitest"

import { geocodeStream } from "./geocode-stream.js"

const fakeWorker = String(repoRootPathBuilder("mailwoman", "test-fixtures", "fake-geocode-worker.js"))

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
		expect(out.every((r) => (r.address as unknown as { tag: string }).tag === "en-US")).toBe(true)
		expect((out[0]!.address as unknown as { cols: number }).cols).toBe(2)
		// Records preserved (set comparison — completion order).
		expect(out.map((r) => r.id).sort((a, b) => Number(a) - Number(b))).toEqual(
			Array.from({ length: 50 }, (_, i) => String(i))
		)
	})
})
