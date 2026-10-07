/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APIClient } from "@mailwoman/core/api"
import { stubFetchingBodies } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import {
	EE_ADS_HARVEST_FILE,
	EE_ADS_PAGE_SIZE,
	EE_ADS_SORT_BY,
	featuresAsJSONL,
	fetchADSEE,
	harvestADSEE,
} from "#ee/tools/fetch/ads"

/**
 * The capabilities document as far as the harvester reads one: the formats,
 * the Addresses type, the paging constraint and the page cap.
 */
function capabilities(options: { formats?: string[]; paging?: boolean; countDefault?: number } = {}): string {
	const formats = options.formats ?? ["application/json", "text/xml; subtype=gml/3.2"]

	return `<?xml version="1.0"?>
<WFS_Capabilities version="2.0.0">
	<OperationsMetadata>
		<Operation name="GetFeature">
			<Parameter name="outputFormat">
				<AllowedValues>${formats.map((format) => `<Value>${format}</Value>`).join("")}</AllowedValues>
			</Parameter>
		</Operation>
		<Constraint name="CountDefault"><NoValues/><DefaultValue>${options.countDefault ?? 1_000_000}</DefaultValue></Constraint>
		<Constraint name="ImplementsResultPaging"><NoValues/><DefaultValue>${options.paging === false ? "FALSE" : "TRUE"}</DefaultValue></Constraint>
	</OperationsMetadata>
	<FeatureTypeList>
		<FeatureType><Name>AD_Address:AD.Address</Name></FeatureType>
		<FeatureType><Name>AD_Address:AD.Address_ThoroughfareName</Name></FeatureType>
	</FeatureTypeList>
</WFS_Capabilities>`
}

/**
 * The `resultType=hits` answer.
 * Its `numberMatched` is real on this service.
 */
function hits(numberMatched: number | string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="${numberMatched}" numberReturned="0"></wfs:FeatureCollection>`
}

/**
 * The page `readCheckedWFSFeatureCount` checks a reported count against.
 */
function probe(numberReturned: number): string {
	return `<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="unknown" numberReturned="${numberReturned}"></wfs:FeatureCollection>`
}

/**
 * The one-feature request `readCheckedWFSFeatureCount` makes at the reported count's own index.
 *
 * A page no larger than the reported count agrees with it whatever the truth is,
 * so the guard asks whether a feature sits at that index.
 * A service holding exactly that many returns none, and `beyond(0)` stands for it.
 * One that capped its count returns a feature.
 */
function beyond(numberReturned: number): string {
	return probe(numberReturned)
}

/**
 * A GeoServer GeoJSON page, flattened as the live service writes one.
 */
function jsonPage(startIndex: number, size: number, numberMatched: number): string {
	return stringifyJSON({
		type: "FeatureCollection",
		features: Array.from({ length: size }, (_, index) => ({
			type: "Feature",
			id: `AD.Address.${startIndex + index}`,
			geometry: { type: "Point", coordinates: [0, 0] },
			properties: {
				gml_id: `AD.Address.${startIndex + index}`,
				component1_xlink_title: "AU.AdministrativeUnit_maakond",
				component6_xlink_title: "76607",
			},
		})),
		totalFeatures: numberMatched,
		numberMatched,
		numberReturned: size,
		timeStamp: "2026-10-02T16:25:34.000Z",
	})
}

/**
 * `stubFetchingBodies` with every request's parameters recorded, because one assertion
 * is about what the harvester asked for rather than what it did with the answer.
 */
function stubClient(bodies: readonly string[]): Pick<APIClient, "fetch"> & { asked: Record<string, string>[] } {
	const inner = stubFetchingBodies(...bodies)
	const asked: Record<string, string>[] = []

	return {
		asked,
		fetch: (request) => {
			asked.push((request.params ?? {}) as Record<string, string>)

			return inner.fetch(request)
		},
	}
}

describe("featuresAsJSONL", () => {
	it("writes one feature per line and closes the last one", () => {
		expect(featuresAsJSONL([{ a: 1 }, { a: 2 }])).toBe('{"a":1}\n{"a":2}\n')
	})

	it("writes nothing for a page of no features, so no blank line enters the file", () => {
		expect(featuresAsJSONL([])).toBe("")
	})
})

describe("harvestADSEE", () => {
	it("pages at the size the service's CountDefault allows", () => {
		// The service advertises CountDefault 1000000 and honors count=10000.
		// That page is 31,198,909 bytes.
		expect(EE_ADS_PAGE_SIZE).toBe(10_000)
	})

	it("writes one JSONL line per feature and records each page", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-harvest-")

		const client = stubClient([
			capabilities(),
			hits(25),
			probe(10),
			beyond(0),
			jsonPage(0, 10, 25),
			jsonPage(10, 10, 25),
			jsonPage(20, 5, 25),
		])

		const manifest = await harvestADSEE(client, { outputDir: scratch.path, pageSize: 10 })

		expect(manifest.feature_count).toBe(25)
		expect(manifest.features_written).toBe(25)
		expect(manifest.pages).toHaveLength(3)
		expect(manifest.complete).toBe(true)
		expect(manifest.sha256).not.toBeNull()
		expect(manifest.license).toBe("CC0-1.0")
		expect(manifest.output_format).toBe("application/json")
		expect(manifest.sort_by).toBe(EE_ADS_SORT_BY)
		expect(manifest.pages[0]?.number_matched).toBe(25)
		expect(manifest.pages[0]?.retrieved_at).toBe("2026-10-02T16:25:34.000Z")

		// Read the way the adapter reads it: one JSON value per line, streamed.
		const features = await Array.fromAsync(
			JSONSpliterator.fromAsync<{ id: string }>(PathBuilder.from(scratch.path)(EE_ADS_HARVEST_FILE))
		)

		expect(features).toHaveLength(25)
		expect(features.at(0)?.id).toBe("AD.Address.0")
		expect(features.at(-1)?.id).toBe("AD.Address.24")
	})

	it("asks for the sort the service honors, because paging without one has no ordering", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-harvest-")

		const client = stubClient([capabilities(), hits(2), probe(2), beyond(0), jsonPage(0, 2, 2)])

		await harvestADSEE(client, { outputDir: scratch.path, pageSize: 2 })

		const page = client.asked.at(-1)

		expect(page).toMatchObject({ sortBy: EE_ADS_SORT_BY, startIndex: "0", count: "2" })
	})

	it("refuses a service advertising no JSON, because the adapter reads JSONL", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-harvest-")

		const client = stubClient([capabilities({ formats: ["text/xml; subtype=gml/3.2"] })])

		await expect(harvestADSEE(client, { outputDir: scratch.path })).rejects.toThrow(/advertises no JSON output format/u)
	})

	it("refuses a service that does not advertise result paging", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-harvest-")

		const client = stubClient([capabilities({ paging: false })])

		await expect(harvestADSEE(client, { outputDir: scratch.path })).rejects.toThrow(
			/does not advertise ImplementsResultPaging/u
		)
	})

	it("carries a count equal to the advertised page cap as no count", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-harvest-")

		// The cap and the reported count agree, so the number describes the page rather than the type.
		const client = stubClient([
			capabilities({ countDefault: 10 }),
			hits(10),
			probe(10),
			// No feature sits at the reported count's index, so core's guard accepts the number
			// and the advertised-cap reading below is the only thing that can refuse it.
			// That is the case this test exists for: a service capping at 10
			// and a type holding 10 answer every request identically.
			beyond(0),
			jsonPage(0, 2, 10),
			jsonPage(2, 0, 10),
		])

		const manifest = await harvestADSEE(client, { outputDir: scratch.path, pageSize: 2 })

		expect(manifest.feature_count).toBeNull()
		expect(manifest.feature_count_source).toMatch(/cap it advertises as CountDefault/u)
		// The harvest ended on the page that returned no features rather than on the count.
		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(2)
	})
})

describe("fetchADSEE", () => {
	it("makes no request on a second run under the same page cap", async () => {
		await using scratch = await temporaryDirectory("mailwoman-ads-fetch-")

		const outRoot = PathBuilder.from(scratch.path)
		const first = stubClient([capabilities(), hits(25), probe(10), beyond(0), jsonPage(0, 10, 25)])

		const started = await fetchADSEE({ outRoot, client: first, pageSize: 10, maxPages: 1 })

		expect(started).toEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })
		// Capabilities, the hits count, the page that checks it, the one-feature request
		// at the count's own index, and the first data page.
		expect(first.asked).toHaveLength(5)

		const second = stubClient([capabilities(), hits(25), probe(10), beyond(0), jsonPage(0, 10, 25)])
		const again = await fetchADSEE({ outRoot, client: second, pageSize: 10, maxPages: 1 })

		expect(again).toEqual({ fetched: 0, skipped: 1, failed: 0, failedCodes: [] })
		expect(second.asked).toEqual([])
	})
})
