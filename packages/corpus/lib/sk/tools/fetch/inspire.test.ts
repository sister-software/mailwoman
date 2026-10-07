/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Proves what the Slovak harvester checks before it pages, how it assembles a document the adapter
 *   reads, and what it refuses.
 *
 *   The capabilities values are the service's real ones, measured 2026-10-03: `CountDefault` 5000,
 *   `ImplementsResultPaging` TRUE, five `ad:` feature types, and `application/gml+xml; version=3.2`
 *   among the advertised formats.
 *
 *   `./inspire.integration.test.ts` reads the live service. This suite stubs the client's `fetch`,
 *   so no request leaves the process.
 */

import type { APIClient } from "@mailwoman/core/api"
import { stubFetchingBodies } from "@mailwoman/core/api/test-transport"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { streamMarkupElements } from "@mailwoman/core/html/elements"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	SK_INSPIRE_OUTPUT_FORMAT,
	SK_INSPIRE_PAGE_SIZE,
	SK_INSPIRE_SORT_BY,
	SK_INSPIRE_TYPES,
	harvestSKInspireType,
	readSKInspireCapabilities,
	skInspireHarvestFile,
	skInspireInputPath,
} from "#sk/tools/fetch/inspire"

const AD_TYPES = ["Address", "AddressAreaName", "AdminUnitName", "PostalDescriptor", "ThoroughfareName"]

/**
 * The capabilities document as GeoServer writes the parts the harvester reads.
 */
function capabilities(
	options: { formats?: string[]; paging?: boolean; countDefault?: number; types?: string[] } = {}
): string {
	const formats = options.formats ?? ["application/gml+xml; version=3.2", "application/json", "gml32"]
	const types = options.types ?? AD_TYPES

	return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0">
	<ows:OperationsMetadata>
		<ows:Operation name="GetFeature">
			<ows:Parameter name="outputFormat">
				<ows:AllowedValues>${formats.map((format) => `<ows:Value>${format}</ows:Value>`).join("")}</ows:AllowedValues>
			</ows:Parameter>
		</ows:Operation>
		<ows:Constraint name="ImplementsResultPaging"><ows:NoValues/><ows:DefaultValue>${options.paging === false ? "FALSE" : "TRUE"}</ows:DefaultValue></ows:Constraint>
		<ows:Constraint name="CountDefault"><ows:NoValues/><ows:DefaultValue>${options.countDefault ?? SK_INSPIRE_PAGE_SIZE}</ows:DefaultValue></ows:Constraint>
	</ows:OperationsMetadata>
	<FeatureTypeList>
		${types.map((type) => `<FeatureType><Name>ad:${type}</Name></FeatureType>`).join("")}
	</FeatureTypeList>
</wfs:WFS_Capabilities>`
}

const NAMESPACES =
	'xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" ' +
	'xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink"'

/**
 * A `GetFeature` page of postal descriptors, counts and timestamp on the root.
 */
function postalPage(startIndex: number, size: number, numberMatched: number | string = 1415): string {
	const members = Array.from(
		{ length: size },
		(_, index) =>
			`<wfs:member><ad:PostalDescriptor gml:id="PostalDescriptor.${startIndex + index}">` +
			`<ad:postCode>${String(4018 + startIndex + index).padStart(5, "0")}</ad:postCode>` +
			"</ad:PostalDescriptor></wfs:member>"
	).join("")

	return (
		`<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection ${NAMESPACES} ` +
		`numberMatched="${numberMatched}" numberReturned="${size}" timeStamp="2026-10-03T01:39:42.638Z">` +
		`${members}</wfs:FeatureCollection>`
	)
}

/**
 * The `resultType=hits` answer. This service gives it as a real count.
 */
function hits(numberMatched: number | string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection ${NAMESPACES} numberMatched="${numberMatched}" numberReturned="0"></wfs:FeatureCollection>`
}

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

async function featuresIn(markup: string, element: string): Promise<number> {
	async function* oneChunk(): AsyncIterable<string> {
		yield markup
	}

	let features = 0

	for await (const _feature of streamMarkupElements(oneChunk(), element, { xml: true })) {
		features++
	}

	return features
}

describe("skInspireInputPath", () => {
	it("states the directory the adapter reads, which holds a document per feature type", () => {
		expect(String(skInspireInputPath(PathBuilder.from("/data/corpus/sources")))).toBe("/data/corpus/sources/sk-inspire")
	})

	it("gives every type its own file name inside its own directory", () => {
		const names = SK_INSPIRE_TYPES.map((type) => skInspireHarvestFile(type))

		expect(new Set(names).size).toBe(SK_INSPIRE_TYPES.length)
		expect(names).toContain("Address.gml")
	})

	it("takes the four component types before the addresses they are joined against", () => {
		expect(SK_INSPIRE_TYPES.at(-1)).toBe("Address")
		expect(SK_INSPIRE_TYPES).toHaveLength(5)
	})
})

describe("readSKInspireCapabilities", () => {
	it("reads the qualified type name for each of the five types", async () => {
		const capability = await readSKInspireCapabilities(stubClient([capabilities()]))

		expect(capability.typeNames.Address).toBe("ad:Address")
		expect(capability.typeNames.PostalDescriptor).toBe("ad:PostalDescriptor")
		expect(capability.countDefault).toBe(5000)
		expect(capability.supportsPaging).toBe(true)
	})

	it("refuses a service that stops publishing one of the five, because the join needs all of them", async () => {
		const missing = capabilities({ types: AD_TYPES.filter((type) => type !== "PostalDescriptor") })

		await expect(readSKInspireCapabilities(stubClient([missing]))).rejects.toThrow(
			/publishes no PostalDescriptor feature type/u
		)
	})

	it("refuses a service that does not advertise the GML the adapter reads", async () => {
		const jsonOnly = capabilities({ formats: ["application/json"] })

		await expect(readSKInspireCapabilities(stubClient([jsonOnly]))).rejects.toThrow(/does not advertise/u)
	})

	it("refuses a service that does not advertise result paging", async () => {
		await expect(readSKInspireCapabilities(stubClient([capabilities({ paging: false })]))).rejects.toThrow(
			/ImplementsResultPaging/u
		)
	})
})

describe("harvestSKInspireType", () => {
	it("assembles one document whose root carries the namespaces and no per-page counts", async () => {
		await using scratch = await temporaryDirectory("mailwoman-sk-inspire-")

		const client = stubClient([
			// `readCheckedWFSFeatureCount` makes three requests.
			// It asks for the count, proves it against a page, then asks for a page at `startIndex = reported`.
			// A non-empty page there means the reported value is a floor rather than the
			// type's size, so the zero page is what establishes 1415 as the count.
			hits(1415),
			postalPage(0, 5),
			postalPage(1415, 0),
			postalPage(0, 5),
			postalPage(5, 5),
			postalPage(10, 0),
		])

		const manifest = await harvestSKInspireType(client, {
			outputDir: scratch.path,
			typeName: "ad:PostalDescriptor",
			type: "PostalDescriptor",
			pageCap: 5000,
			pageSize: 5,
			maxPages: 2,
		})

		expect(manifest.type_name).toBe("ad:PostalDescriptor")
		expect(manifest.output_format).toBe(SK_INSPIRE_OUTPUT_FORMAT)
		expect(manifest.sort_by).toBe(SK_INSPIRE_SORT_BY)
		expect(manifest.feature_count).toBe(1415)
		expect(manifest.pages).toHaveLength(2)
		expect(manifest.features_written).toBe(10)

		const document = await readLocalTextFile(PathBuilder.from(scratch.path)("PostalDescriptor.gml"))

		expect(document).toContain('xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0"')

		// `numberMatched`, `numberReturned` and `timeStamp` describe one page, and the assembled
		// document holds ten features over two pages, so the root states none of them.
		expect(document).not.toContain("numberReturned=")
		expect(document).not.toContain("timeStamp=")

		expect(await featuresIn(document, "ad:PostalDescriptor")).toBe(10)

		// The first three requests are the count check: `resultType=hits`, a one-feature page
		// that proves the count against real output, and a page at `startIndex = reported` whose
		// emptiness establishes that the reported value is the type's size rather than a floor.
		// The harvest's own pages follow at 0 and 5.
		expect(client.asked.map((params) => params.startIndex)).toEqual(["1", undefined, "1415", "0", "5"])
		expect(client.asked.at(-1)?.sortBy).toBe(SK_INSPIRE_SORT_BY)
	})

	it("refuses a service that answers a new startIndex with the previous page", async () => {
		await using scratch = await temporaryDirectory("mailwoman-sk-inspire-")

		const client = stubClient([hits(1415), postalPage(0, 5), postalPage(0, 5), postalPage(0, 5)])

		await expect(
			harvestSKInspireType(client, {
				outputDir: scratch.path,
				typeName: "ad:PostalDescriptor",
				type: "PostalDescriptor",
				pageCap: 5000,
				pageSize: 5,
			})
		).rejects.toThrow(/byte-identical/u)
	})

	it("carries no count where the service reports its own page cap", async () => {
		await using scratch = await temporaryDirectory("mailwoman-sk-inspire-")

		// A reported count equal to `CountDefault` describes the largest page the service will serve
		// rather than what the type holds, so the harvest ends on the first empty page.
		//
		// The third body is the zero page `readCheckedWFSFeatureCount` asks for at `startIndex = reported`.
		// A features answer would make core refuse the count as a floor. That is a different
		// finding and would never reach the cap comparison this covers.
		const client = stubClient([
			hits(5000),
			postalPage(0, 5, 5000),
			postalPage(5000, 0, 5000),
			postalPage(0, 5, 5000),
			postalPage(5, 0, 5000),
		])

		const manifest = await harvestSKInspireType(client, {
			outputDir: scratch.path,
			typeName: "ad:PostalDescriptor",
			type: "PostalDescriptor",
			pageCap: 5000,
			pageSize: 5,
		})

		expect(manifest.feature_count).toBeNull()
		expect(manifest.feature_count_source).toMatch(/CountDefault/u)
		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(5)
	})

	it("caps the page size at the size the service serves", async () => {
		await using scratch = await temporaryDirectory("mailwoman-sk-inspire-")

		const client = stubClient([hits(1415), postalPage(0, 1), postalPage(0, 1), postalPage(1, 0)])

		const manifest = await harvestSKInspireType(client, {
			outputDir: scratch.path,
			typeName: "ad:PostalDescriptor",
			type: "PostalDescriptor",
			pageCap: 5000,
			pageSize: 50_000,
		})

		expect(manifest.page_size).toBe(SK_INSPIRE_PAGE_SIZE)
	})
})
