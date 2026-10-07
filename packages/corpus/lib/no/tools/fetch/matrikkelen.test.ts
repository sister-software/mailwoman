/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves which archive the Matrikkelen fetcher asks for per area, how it reads the service's
 *   freshness headers, and what it refuses.
 *
 *   The two archive names are the publisher's real paths and the byte counts are its real ones,
 *   recorded when the reader was written, so a change in what the fetcher resolves shows up against
 *   them.
 *
 *   `./matrikkelen.integration.test.ts` reads the live service. This suite stubs the transport and
 *   runs the real `APIClient` over it, so the HEAD requests go through the same adapter and header
 *   normalization they do against the publisher.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubOutcome, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	MATRIKKELEN_AREAS,
	MATRIKKELEN_MAINLAND_AREA,
	MATRIKKELEN_MEMBER_FILENAME,
	MATRIKKELEN_REQUIRED_COLUMNS,
	matrikkelenAreasFor,
	matrikkelenArchiveFilename,
	matrikkelenArchiveURL,
	matrikkelenInputPath,
	matrikkelenPublicationIsRecorded,
	readMatrikkelenPublication,
	recordedMatrikkelenArea,
	type MatrikkelenFileManifest,
} from "#no/tools/fetch/matrikkelen"

const MAINLAND = MATRIKKELEN_AREAS[0]!

const SVALBARD = MATRIKKELEN_AREAS[1]!

const LAST_MODIFIED = "Tue, 08 Sep 2026 08:19:56 GMT"

function stubClient(outcomes: StubOutcome[]): APIClient & { calls: string[] } {
	const transport = stubTransport(outcomes)
	const client = new APIClient({ displayName: "matrikkelen test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

/**
 * A recorded entry for Svalbard. The address-source register measured its archive at 58,079 bytes.
 */
function recordedSvalbard(overrides: Partial<MatrikkelenFileManifest> = {}): MatrikkelenFileManifest {
	return {
		source_url: matrikkelenArchiveURL(SVALBARD),
		filename: matrikkelenArchiveFilename(SVALBARD),
		area_code: SVALBARD.code,
		bytes: 58_079,
		sha256: "71f348ba6f0aeb7b3fb111b17616e1cd33ccf28d08129a70d538db317180727d",
		last_modified: LAST_MODIFIED,
		member_filename: MATRIKKELEN_MEMBER_FILENAME,
		member_bytes: 321_491,
		member_sha256: "0".repeat(64),
		downloaded_at: "2026-10-03T00:00:00.000Z",
		...overrides,
	}
}

describe("matrikkelenArchiveURL", () => {
	it("names the mainland archive at the dataset's conventional path", () => {
		expect(matrikkelenArchiveURL(MAINLAND)).toBe(
			"https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenAdresse/CSV/Basisdata_0000_Norge_4258_MatrikkelenAdresse_CSV.zip"
		)
	})

	it("names Svalbard's archive, which is the same dataset published for area 2100", () => {
		expect(matrikkelenArchiveURL(SVALBARD)).toBe(
			"https://nedlasting.geonorge.no/geonorge/Basisdata/MatrikkelenAdresse/CSV/Basisdata_2100_Svalbard_4258_MatrikkelenAdresse_CSV.zip"
		)
	})
})

describe("matrikkelenInputPath", () => {
	it("states the extracted CSV the adapter reads, under the area's own directory", () => {
		expect(String(matrikkelenInputPath(PathBuilder.from("/data/corpus/sources"), SVALBARD.code))).toBe(
			`/data/corpus/sources/matrikkelen/2100/${MATRIKKELEN_MEMBER_FILENAME}`
		)
	})

	it("defaults to the mainland extract, which is the area carrying Norway's rows", () => {
		expect(String(matrikkelenInputPath(PathBuilder.from("/data/corpus/sources")))).toBe(
			`/data/corpus/sources/matrikkelen/${MATRIKKELEN_MAINLAND_AREA}/${MATRIKKELEN_MEMBER_FILENAME}`
		)
	})

	it("gives the two areas separate paths, because both archives name their member the same", () => {
		const root = PathBuilder.from("/data/corpus/sources")

		expect(String(matrikkelenInputPath(root, MAINLAND.code))).not.toBe(
			String(matrikkelenInputPath(root, SVALBARD.code))
		)
	})
})

describe("matrikkelenAreasFor", () => {
	it("takes both areas when a caller names none", () => {
		expect(matrikkelenAreasFor(undefined)).toEqual(MATRIKKELEN_AREAS)
		expect(matrikkelenAreasFor([])).toEqual(MATRIKKELEN_AREAS)
	})

	it("takes only the areas named", () => {
		expect(matrikkelenAreasFor(["2100"]).map((area) => area.code)).toEqual(["2100"])
	})

	it("refuses a code the area list does not carry, rather than fetching zero files", () => {
		expect(() => matrikkelenAreasFor(["4601"])).toThrow(/4601 is not an area/u)
	})
})

describe("readMatrikkelenPublication", () => {
	it("reads the service's last-modified and content-length for one area", async () => {
		const client = stubClient([{ headers: { "last-modified": LAST_MODIFIED, "content-length": "58079" } }])

		expect(await readMatrikkelenPublication(client, SVALBARD)).toEqual({
			lastModified: LAST_MODIFIED,
			reportedBytes: 58_079,
		})

		expect(client.calls[0]).toContain("Basisdata_2100_Svalbard_4258_MatrikkelenAdresse_CSV.zip")
	})

	it("reads an absent header as null rather than as an empty string or zero", async () => {
		const client = stubClient([{ headers: {} }])

		expect(await readMatrikkelenPublication(client, MAINLAND)).toEqual({ lastModified: null, reportedBytes: null })
	})
})

describe("matrikkelenPublicationIsRecorded", () => {
	const publication = { lastModified: LAST_MODIFIED, reportedBytes: 58_079 }

	it("holds where the header, the archive and the extract all match what was recorded", () => {
		expect(matrikkelenPublicationIsRecorded(recordedSvalbard(), 58_079, 321_491, publication)).toBe(true)
	})

	it("refuses a skip where the service states no last-modified, so a silent publisher is taken again", () => {
		expect(
			matrikkelenPublicationIsRecorded(recordedSvalbard({ last_modified: null }), 58_079, 321_491, {
				lastModified: null,
				reportedBytes: 58_079,
			})
		).toBe(false)
	})

	it("refuses a skip where the service reports a later last-modified", () => {
		expect(
			matrikkelenPublicationIsRecorded(recordedSvalbard(), 58_079, 321_491, {
				...publication,
				lastModified: "Fri, 02 Oct 2026 07:50:10 GMT",
			})
		).toBe(false)
	})

	it("refuses a skip where the extracted member is not the length that was recorded", () => {
		expect(matrikkelenPublicationIsRecorded(recordedSvalbard(), 58_079, 0, publication)).toBe(false)
	})
})

describe("recordedMatrikkelenArea", () => {
	it("reads a complete entry", () => {
		expect(recordedMatrikkelenArea(recordedSvalbard())?.area_code).toBe("2100")
	})

	it("reads no entry where the manifest holds none for the area", () => {
		expect(recordedMatrikkelenArea(undefined)).toBeUndefined()
	})

	it("reads no entry where the recorded run stated no last-modified, so the skip is not decided from it", () => {
		expect(recordedMatrikkelenArea(recordedSvalbard({ last_modified: null }))).toBeUndefined()
	})

	it("reads no entry from a manifest written before the area fields existed", () => {
		const { area_code: _area, member_bytes: _bytes, ...older } = recordedSvalbard()

		expect(recordedMatrikkelenArea(older)).toBeUndefined()
	})
})

describe("MATRIKKELEN_REQUIRED_COLUMNS", () => {
	it("names the nine columns the adapter reads and no byte-order-marked first column", () => {
		expect(MATRIKKELEN_REQUIRED_COLUMNS).toEqual([
			"kommunenummer",
			"adressetype",
			"adressenavn",
			"nummer",
			"bokstav",
			"adresseTekst",
			"postnummer",
			"poststed",
			"adresseId",
		])

		// The published header's first column is `lokalid` carrying a byte-order mark,
		// so a check that includes it would fail on every file the publisher writes.
		expect(MATRIKKELEN_REQUIRED_COLUMNS).not.toContain("lokalid")
	})
})
