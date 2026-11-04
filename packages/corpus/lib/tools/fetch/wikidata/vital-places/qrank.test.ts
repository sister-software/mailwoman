// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { gzip } from "@mailwoman/core/fs/compression"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalBuffer, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { silentLogger } from "@mailwoman/core/logging"
import { describe, expect, it } from "vitest"

import {
	downloadQRank,
	isQRankCurrent,
	QRANK_DATAPACKAGE_URL,
	type QRankDatapackage,
	type QRankReceipt,
	readQRankDatapackage,
	readTopQRank,
} from "#tools/fetch/wikidata/vital-places/qrank"

/**
 * The descriptor the host served on 2026-11-04, reduced to the fields the module reads.
 */
const DATAPACKAGE_BODY = {
	version: "2026-11-01",
	licenses: [{ name: "CC0-1.0", path: "https://creativecommons.org/publicdomain/zero/1.0/" }],
	resources: [
		{
			name: "qrank",
			path: "qrank-20261101.csv.gz",
			bytes: 126_008_420,
			hash: "sha256:a5e6be96419745d6f34787cd6abc879203d007780a810a7cab0e43d250c3a41a",
		},
	],
}

const CURRENT: QRankDatapackage = {
	version: "2026-11-01",
	path: "qrank-20261101.csv.gz",
	bytes: 126_008_420,
	sha256: "a5e6be96419745d6f34787cd6abc879203d007780a810a7cab0e43d250c3a41a",
	license: "CC0-1.0",
}

function stubClient(results: StubResult[]) {
	const transport = stubTransport(results)
	const client = new APIClient({ displayName: "qrank test", logger: silentLogger(), axios: transport.axios })

	return { client, transport }
}

describe("readQRankDatapackage", () => {
	it("reads the version, file, byte count, digest and license", async () => {
		const { client, transport } = stubClient([{ body: DATAPACKAGE_BODY }])
		await using _client = client

		await expect(readQRankDatapackage(client)).resolves.toEqual(CURRENT)
		expect(transport.calls).toEqual([QRANK_DATAPACKAGE_URL])
	})

	it("names the field a descriptor lacks rather than reading a build that never matches", async () => {
		const body = structuredClone(DATAPACKAGE_BODY) as { resources: Array<Record<string, unknown>> }

		delete body.resources[0]!["hash"]

		await using client = stubClient([{ body }]).client

		await expect(readQRankDatapackage(client)).rejects.toThrow(/resources\[0\]\.hash/)
	})
})

describe("isQRankCurrent", () => {
	it("is current only for the recorded build still on disk", async () => {
		await using scratch = await temporaryDirectory("mailwoman-qrank-current-")

		const path = scratch.path("qrank.csv.gz")

		const recorded: QRankReceipt = {
			...CURRENT,
			source_url: "",
			downloaded_at: "2026-11-04T00:00:00.000Z",
			filename: "qrank.csv.gz",
		}

		await expect(isQRankCurrent(recorded, CURRENT, path)).resolves.toBe(false)

		await writeLocalBuffer(await gzip("Entity,QRank\n"), path)

		await expect(isQRankCurrent(recorded, CURRENT, path)).resolves.toBe(true)
		await expect(isQRankCurrent(null, CURRENT, path)).resolves.toBe(false)
		await expect(isQRankCurrent(recorded, { ...CURRENT, version: "2026-11-08" }, path)).resolves.toBe(false)
	})
})

describe("downloadQRank", () => {
	it("makes no download when the receipt matches the descriptor", async () => {
		await using scratch = await temporaryDirectory("mailwoman-qrank-download-")
		const { client, transport } = stubClient([{ body: DATAPACKAGE_BODY }])
		await using _client = client

		const recorded: QRankReceipt = {
			...CURRENT,
			source_url: "",
			downloaded_at: "2026-11-04T00:00:00.000Z",
			filename: "qrank.csv.gz",
		}

		await writeLocalBuffer(await gzip("Entity,QRank\n"), scratch.path("qrank.csv.gz"))
		await writeLocalJSONFile(recorded, scratch.path("qrank.json"))

		const lines: string[] = []

		await expect(
			downloadQRank(client, { destDir: scratch.path(), report: (line) => lines.push(line) })
		).resolves.toEqual(recorded)

		expect(transport.calls).toEqual([QRANK_DATAPACKAGE_URL])
		expect(lines).toEqual(["  qrank: build 2026-11-01 already on disk (126,008,420 bytes), no download"])
	})

	it("refuses a descriptor stating a license other than CC0", async () => {
		await using scratch = await temporaryDirectory("mailwoman-qrank-license-")
		const body = structuredClone(DATAPACKAGE_BODY)

		body.licenses[0]!.name = "CC-BY-4.0"

		await using client = stubClient([{ body }]).client

		await expect(downloadQRank(client, { destDir: scratch.path() })).rejects.toThrow(/CC-BY-4\.0/)
	})
})

describe("readTopQRank", () => {
	it("reads the first rows in file order and stops at the limit", async () => {
		await using scratch = await temporaryDirectory("mailwoman-qrank-read-")
		const path = scratch.path("qrank.csv.gz")

		await writeLocalBuffer(await gzip("Entity,QRank\nQ42,300\nQ90,200\nQ64,100\n"), path)

		await expect(Array.fromAsync(readTopQRank(path, 2))).resolves.toEqual([
			{ qid: "Q42", qrank: 300 },
			{ qid: "Q90", qrank: 200 },
		])

		await expect(Array.fromAsync(readTopQRank(path, 10))).resolves.toHaveLength(3)
		await expect(Array.fromAsync(readTopQRank(path, 0))).resolves.toEqual([])
	})

	it("refuses a row that is not an Entity,QRank pair by line", async () => {
		await using scratch = await temporaryDirectory("mailwoman-qrank-bad-")
		const path = scratch.path("qrank.csv.gz")

		await writeLocalBuffer(await gzip("Entity,QRank\nQ42,300\nnot-an-id,1\n"), path)

		await expect(Array.fromAsync(readTopQRank(path, 10))).rejects.toThrow(/:3: not an Entity,QRank row/)
	})
})
