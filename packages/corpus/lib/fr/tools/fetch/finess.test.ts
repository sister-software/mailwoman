/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	type DataGouvDataset,
	downloadFinessExtract,
	FINESS_DATASET_API_URL,
	type FinessExtractManifest,
	finessInputPath,
	readServedMD5,
	selectFinessExtract,
} from "#fr/tools/fetch/finess"
import { writeManifest } from "#tools/fetch/download"

/**
 * The establishment extract and the geolocated extract as the dataset record listed
 * them on 2026-10-03, with the fields the fetcher reads, and an older establishment
 * extract added to check that the newest is picked.
 */
const DATASET: DataGouvDataset = {
	license: "fr-lo",
	resources: [
		{
			id: "98f3161f-79ff-4f16-8f6a-6d571a80fea2",
			url: "https://static.data.gouv.fr/resources/finess-extraction-du-fichier-des-etablissements/20260512-091152/etalab-cs1100507-stock-20260512-0339.csv",
			last_modified: "2026-05-12T09:11:58.567000+00:00",
			filesize: 47_934_098,
		},
		{
			id: "2ce43ade-8d2c-4d1d-81da-ca06c82abc68",
			url: "https://static.data.gouv.fr/resources/finess-extraction-du-fichier-des-etablissements/20260512-091308/etalab-cs1100502-stock-20260512-0339.csv",
			last_modified: "2026-05-12T09:13:13.009000+00:00",
			filesize: 35_786_629,
			checksum: { type: "sha1", value: "d3c2c0e68a413974dffbe0aabf093e3f40414967" },
		},
		{
			id: "older",
			url: "https://static.data.gouv.fr/resources/finess-extraction-du-fichier-des-etablissements/20260301-000000/etalab-cs1100502-stock-20260301-0339.csv",
			last_modified: "2026-03-01T00:00:00.000000+00:00",
		},
	],
}

function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)
	const client = new APIClient({ displayName: "fr-finess test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

describe("selectFinessExtract", () => {
	it("picks the newest establishment extract and not the geolocated one", () => {
		const selected = selectFinessExtract(DATASET)

		expect(selected.id).toBe("2ce43ade-8d2c-4d1d-81da-ca06c82abc68")
		expect(selected.filename).toBe("etalab-cs1100502-stock-20260512-0339.csv")
	})

	it("raises when the record lists no establishment extract", () => {
		expect(() => selectFinessExtract({ resources: [DATASET.resources[0]!] })).toThrow(/etalab-cs1100502/)
	})
})

describe("readServedMD5", () => {
	it("reads the MD5 out of a weak ETag, and reports another shape as absent", async () => {
		await using client = stubClient([
			{ headers: { etag: 'W/"1300241c36f1e7706a72191e05f2148e"' } },
			{ headers: { etag: '"abc-123"' } },
		])

		expect(await readServedMD5(client, DATASET.resources[1]!.url)).toBe("1300241c36f1e7706a72191e05f2148e")
		expect(await readServedMD5(client, DATASET.resources[1]!.url)).toBeNull()
	})
})

describe("downloadFinessExtract", () => {
	it("makes no transfer when the manifest records the same resource and the file is on disk", async () => {
		await using scratch = await temporaryDirectory("mailwoman-fr-finess-current-")
		await using client = stubClient([{ body: DATASET }])

		const resource = selectFinessExtract(DATASET)
		const path = scratch.path(resource.filename)
		const text = "finess;etalab;111;2026-05-12\n"

		await writeLocalFile(text, path)

		const recorded: FinessExtractManifest = {
			source_url: resource.url,
			downloaded_at: "2026-10-03T14:01:09.945Z",
			filename: resource.filename,
			sha256: await sha256File(path),
			bytes: Buffer.byteLength(text),
			resource_id: resource.id,
			resource_last_modified: resource.last_modified,
			dataset_license: "fr-lo",
			extract_header: "finess;etalab;111;2026-05-12",
			sha1: "8be4bdc362f3f382e3a7de2a26da6c3a5e6074f3",
			record_sha1: "d3c2c0e68a413974dffbe0aabf093e3f40414967",
			served_md5: "1300241c36f1e7706a72191e05f2148e",
		}

		await writeManifest(scratch.path("MANIFEST.json"), { source: "fr-finess-overseas", files: [recorded] })

		const summary = await downloadFinessExtract(client, { outputDir: scratch.path })

		expect(summary).toEqual({ fetched: 0, skipped: 1, failed: 0, failedCodes: [] })
		expect(client.calls).toEqual([FINESS_DATASET_API_URL])
	})
})

describe("finessInputPath", () => {
	it("answers the directory the adapter reads", () => {
		expect(finessInputPath(PathBuilder.from("/tmp/sources")).toString()).toBe("/tmp/sources/fr-finess-overseas")
	})
})
