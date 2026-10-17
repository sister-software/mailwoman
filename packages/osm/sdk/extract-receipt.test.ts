import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { describe, expect, it } from "vitest"

import { extractReceiptPath, readExtractProvenance } from "#sdk/extract-receipt"
import type { GeofabrikExtractReceipt } from "#sdk/fetch"

const URL = "https://download.geofabrik.de/australia-oceania/new-zealand-latest.osm.pbf"
const BYTES = "stand-in extract bytes"

function receiptFor(bytes: string, overrides: Partial<GeofabrikExtractReceipt> = {}): GeofabrikExtractReceipt {
	return {
		region: "australia-oceania/new-zealand",
		source_url: URL,
		retrieved_at: "2026-08-07T09:00:00.000Z",
		last_modified: "Thu, 06 Aug 2026 20:21:41 GMT",
		filename: "new-zealand-260806.osm.pbf",
		bytes: bytes.length,
		sha256: sha256Hex(bytes),
		md5: "0".repeat(32),
		published_md5: null,
		license: "ODbL-1.0",
		...overrides,
	}
}

describe("readExtractProvenance", () => {
	it("reads the URL and snapshot date from the receipt and measures the digest", async () => {
		await using directory = await temporaryDirectory("mw-osm-receipt-")
		const pbf = directory.path("new-zealand-260806.osm.pbf")

		await writeLocalTextFile(BYTES, pbf)
		await writeLocalJSONFile(receiptFor(BYTES), extractReceiptPath(pbf))

		expect(await readExtractProvenance(pbf)).toEqual({
			sourceURL: URL,
			sourceSHA256: sha256Hex(BYTES),
			snapshotDate: "2026-08-06",
		})
	})

	it("refuses a file whose bytes changed after the receipt was written", async () => {
		await using directory = await temporaryDirectory("mw-osm-receipt-")
		const pbf = directory.path("new-zealand-260806.osm.pbf")

		await writeLocalTextFile(`${BYTES} edited`, pbf)
		await writeLocalJSONFile(receiptFor(BYTES), extractReceiptPath(pbf))

		await expect(readExtractProvenance(pbf)).rejects.toThrow(/changed after it was downloaded/)
	})

	it("refuses a stated URL that differs from the receipt's", async () => {
		await using directory = await temporaryDirectory("mw-osm-receipt-")
		const pbf = directory.path("new-zealand-260806.osm.pbf")

		await writeLocalTextFile(BYTES, pbf)
		await writeLocalJSONFile(receiptFor(BYTES), extractReceiptPath(pbf))

		await expect(readExtractProvenance(pbf, { sourceURL: "https://example.org/nz.osm.pbf" })).rejects.toThrow(
			/differs from the receipt's source_url/
		)
	})

	it("takes the stated URL for an extract with no receipt and leaves the snapshot date unrecorded", async () => {
		await using directory = await temporaryDirectory("mw-osm-receipt-")
		const pbf = directory.path("hand-downloaded.osm.pbf")

		await writeLocalTextFile(BYTES, pbf)

		expect(await readExtractProvenance(pbf, { sourceURL: URL })).toEqual({
			sourceURL: URL,
			sourceSHA256: sha256Hex(BYTES),
			snapshotDate: null,
		})
	})

	it("refuses an extract with neither a receipt nor a stated URL", async () => {
		await using directory = await temporaryDirectory("mw-osm-receipt-")
		const pbf = directory.path("hand-downloaded.osm.pbf")

		await writeLocalTextFile(BYTES, pbf)

		await expect(readExtractProvenance(pbf)).rejects.toThrow(/has no receipt/)
	})
})
