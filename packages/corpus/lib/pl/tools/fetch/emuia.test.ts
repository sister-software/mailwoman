/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APIClient } from "@mailwoman/core/api"
import { stubFetchingBodies } from "@mailwoman/core/api/test-transport"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { streamMarkupElements } from "@mailwoman/core/html/elements"
import { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import {
	fetchEMUiAPL,
	harvestEMUiAPL,
	PL_EMUIA_HARVEST_FILE,
	PL_EMUIA_OUTPUT_FORMAT,
	PL_EMUIA_PAGE_SIZE,
	PL_EMUIA_SORT_BY,
} from "#pl/tools/fetch/emuia"

const GML_FORMATS = [
	"application/gml+xml; version=3.2",
	"text/xml; subtype=gml/3.2.1",
	"text/xml; subtype=gml/3.1.1",
	"text/xml; subtype=gml/2.1.2",
]

/**
 * The capabilities document as MapServer writes the parts the harvester reads.
 */
function capabilities(options: { formats?: string[]; paging?: boolean; countDefault?: number } = {}): string {
	const formats = options.formats ?? GML_FORMATS

	return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0">
	<ows:OperationsMetadata>
		<ows:Operation name="GetFeature">
			<ows:Parameter name="outputFormat">
				<ows:AllowedValues>${formats.map((format) => `<ows:Value>${format}</ows:Value>`).join("")}</ows:AllowedValues>
			</ows:Parameter>
		</ows:Operation>
		<ows:Constraint name="ImplementsResultPaging"><ows:NoValues/><ows:DefaultValue>${options.paging === false ? "FALSE" : "TRUE"}</ows:DefaultValue></ows:Constraint>
		<ows:Constraint name="CountDefault"><ows:NoValues/><ows:DefaultValue>${options.countDefault ?? PL_EMUIA_PAGE_SIZE}</ows:DefaultValue></ows:Constraint>
	</ows:OperationsMetadata>
	<FeatureTypeList>
		<FeatureType><Name>ms:AD.Address</Name></FeatureType>
	</FeatureTypeList>
</wfs:WFS_Capabilities>`
}

const NAMESPACES =
	'xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2" ' +
	'xmlns:wfs="http://www.opengis.net/wfs/2.0"'

/**
 * A `GetFeature` page in the shape MapServer serves, counts and timestamp on the root.
 */
function gmlPage(startIndex: number, size: number, numberMatched = "unknown"): string {
	const members = Array.from(
		{ length: size },
		(_, index) =>
			`<wfs:member><ms:AD.Address gml:id="AD.Address.${startIndex + index}">` +
			`<ms:id>${97_426_176 + startIndex + index}</ms:id>` +
			`<ms:ulica>1 Maja</ms:ulica><ms:numer>${10 + index}</ms:numer>` +
			"<ms:kod>97-300</ms:kod><ms:miejscowosc>Piotrków Trybunalski</ms:miejscowosc>" +
			"</ms:AD.Address></wfs:member>"
	).join("")

	return (
		`<?xml version='1.0' encoding="UTF-8" ?>\n<wfs:FeatureCollection ${NAMESPACES} ` +
		`numberMatched="${numberMatched}" numberReturned="${size}" timeStamp="2026-10-02T16:25:34">` +
		`${members}</wfs:FeatureCollection>`
	)
}

/**
 * The `resultType=hits` answer. On this service it reports its page cap rather than a count.
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

async function membersIn(markup: string): Promise<number> {
	async function* oneChunk(): AsyncIterable<string> {
		yield markup
	}

	let members = 0

	for await (const _member of streamMarkupElements(oneChunk(), "ms:AD.Address", { xml: true })) {
		members++
	}

	return members
}

describe("harvestEMUiAPL", () => {
	it("pages at the cap the service serves", () => {
		// `count=5000` answers numberReturned="1000", and the capabilities state CountDefault 1000.
		expect(PL_EMUIA_PAGE_SIZE).toBe(1000)
	})

	it("assembles one document whose root holds the namespaces and no per-page counts", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		const client = stubClient([
			capabilities(),
			hits(1000),
			gmlPage(0, 10),
			gmlPage(1000, 1),
			gmlPage(0, 2),
			gmlPage(2, 0),
		])

		const manifest = await harvestEMUiAPL(client, { outputDir: scratch.path, pageSize: 2 })

		expect(manifest.complete).toBe(true)
		expect(manifest.features_written).toBe(2)
		expect(manifest.output_format).toBe(PL_EMUIA_OUTPUT_FORMAT)
		expect(manifest.sort_by).toBe(PL_EMUIA_SORT_BY)
		expect(manifest.footer).toBe("</wfs:FeatureCollection>\n")
		expect(manifest.pages[0]?.retrieved_at).toBe("2026-10-02T16:25:34")

		const written = await readLocalTextFile(PathBuilder.from(scratch.path)(PL_EMUIA_HARVEST_FILE))

		// One declaration and one root element for the whole harvest rather than one per page.
		expect(written.match(/<\?xml/gu)).toHaveLength(1)
		expect(written.match(/<wfs:FeatureCollection/gu)).toHaveLength(1)
		expect(written.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<wfs:FeatureCollection ')).toBe(true)
		expect(written.endsWith("</wfs:FeatureCollection>\n")).toBe(true)
		expect(written).toContain('xmlns:ms="http://mapserver.gis.umn.edu/mapserver"')
		expect(written).not.toContain("numberReturned")
		expect(written).not.toContain("timeStamp")

		// The reader the adapter uses finds every member of the assembled document.
		expect(await membersIn(written)).toBe(2)
	})

	it("refuses the service's page cap as a count, so the harvest runs past 1,000 features", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		// A hits request reports 1000 against a CountDefault of 1000, and the page that
		// checks the number cannot exceed the cap, so the check agrees with it.
		const client = stubClient([
			capabilities(),
			hits(1000),
			gmlPage(0, 10),
			// Core's guard asks for one feature at the reported count's index.
			// This service answers with one. That proves 1,000 is its page cap
			// rather than the type's size.
			gmlPage(1000, 1),
			gmlPage(0, 2),
			gmlPage(2, 2),
			gmlPage(4, 0),
		])

		const manifest = await harvestEMUiAPL(client, { outputDir: scratch.path, pageSize: 2 })

		expect(manifest.feature_count).toBeNull()
		// Core's guard refuses it first, on the measurement rather than on the advertised cap: a service
		// holding 1,000 features answers an empty page at index 1,000 and this one answers a feature.
		// The advertised-cap reading stays as the fallback for a service whose index cannot distinguish the two.
		expect(manifest.feature_count_source).toMatch(/a floor rather than the type's size/u)
		expect(manifest.features_written).toBe(4)
		expect(manifest.complete).toBe(true)
	})

	it("asks for the GML format and the sort the service honors", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		const client = stubClient([
			capabilities(),
			hits(1000),
			gmlPage(0, 10),
			gmlPage(1000, 1),
			gmlPage(0, 2),
			gmlPage(2, 0),
		])

		await harvestEMUiAPL(client, { outputDir: scratch.path, pageSize: 2 })

		// The capabilities, the hits request, the count's checking page and the one-feature request
		// at the count's own index come first, so the harvest's first data page is the fifth.
		expect(client.asked[4]).toMatchObject({
			outputFormat: PL_EMUIA_OUTPUT_FORMAT,
			sortBy: PL_EMUIA_SORT_BY,
			startIndex: "0",
			count: "2",
		})
	})

	it("refuses a service that stops advertising the GML format the adapter reads", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		const client = stubClient([capabilities({ formats: ["application/json"] })])

		await expect(harvestEMUiAPL(client, { outputDir: scratch.path })).rejects.toThrow(
			/does not advertise application\/gml\+xml; version=3\.2/u
		)
	})

	it("refuses a service that does not advertise result paging", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		const client = stubClient([capabilities({ paging: false })])

		await expect(harvestEMUiAPL(client, { outputDir: scratch.path })).rejects.toThrow(
			/does not advertise ImplementsResultPaging/u
		)
	})

	it("refuses an exception report rather than storing it as a page", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-harvest-")

		const exception =
			'<?xml version="1.0" encoding="UTF-8"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">' +
			'<ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>msWFSGetFeature()' +
			"</ows:ExceptionText></ows:Exception></ows:ExceptionReport>"

		const client = stubClient([capabilities(), hits(1000), gmlPage(0, 10), gmlPage(1000, 1), exception])

		await expect(harvestEMUiAPL(client, { outputDir: scratch.path, pageSize: 2 })).rejects.toThrow(
			/InvalidParameterValue|msWFSGetFeature/u
		)
	})
})

describe("fetchEMUiAPL", () => {
	it("resumes at the page after the last one on disk, then makes no request when complete", async () => {
		await using scratch = await temporaryDirectory("mailwoman-emuia-fetch-")

		const outRoot = PathBuilder.from(scratch.path)
		const first = stubClient([capabilities(), hits(1000), gmlPage(0, 10), gmlPage(1000, 1), gmlPage(0, 2)])
		const started = await fetchEMUiAPL({ outRoot, client: first, pageSize: 2, maxPages: 1 })

		expect(started).toEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })

		const resumed = stubClient([
			capabilities(),
			hits(1000),
			gmlPage(0, 10),
			gmlPage(1000, 1),
			gmlPage(2, 2),
			gmlPage(4, 0),
		])

		const rest = await fetchEMUiAPL({ outRoot, client: resumed, pageSize: 2 })

		expect(rest).toEqual({ fetched: 1, skipped: 0, failed: 0, failedCodes: [] })
		expect(resumed.asked.at(-2)).toMatchObject({ startIndex: "2" })

		const written = await readLocalTextFile(outRoot("emuia", PL_EMUIA_HARVEST_FILE))

		expect(await membersIn(written)).toBe(4)
		expect(written.match(/<\?xml/gu)).toHaveLength(1)
		expect(written.endsWith("</wfs:FeatureCollection>\n")).toBe(true)

		const third = stubClient([capabilities(), hits(1000), gmlPage(0, 10), gmlPage(1000, 1)])
		const again = await fetchEMUiAPL({ outRoot, client: third, pageSize: 2 })

		expect(again).toEqual({ fetched: 0, skipped: 1, failed: 0, failedCodes: [] })
		expect(third.asked).toEqual([])
	})
})
