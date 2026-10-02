/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { APIClient } from "@mailwoman/core/api"
import { stubFetchingBodies } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { describe, expect, it } from "vitest"

import {
	harvestVlaanderenAD,
	MAX_PAGE_SIZE,
	readVlaanderenFeatureCount,
	readVlaanderenPage,
} from "#tools/fetch/vlaanderen-ad"

const NAMESPACES =
	'xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" ' +
	'xmlns:gml="http://www.opengis.net/gml/3.2"'

/**
 * A `wfs:FeatureCollection` whose root states the counts the caller gives it.
 */
function collection(attributes: string, members = ""): string {
	return `<?xml version="1.0" encoding="UTF-8"?><wfs:FeatureCollection ${NAMESPACES} ${attributes}>${members}</wfs:FeatureCollection>`
}

/**
 * `stubFetchingBodies` with the request parameters recorded.
 *
 * The bodies and the axios shape stay in core's stub, and this adds only the record, because
 * one assertion is about what the harvester asked for rather than what it did with the answer.
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

describe("readVlaanderenPage", () => {
	it("reads the counts off the root element", async () => {
		const client = stubClient([collection('numberMatched="4563062" numberReturned="0"')])
		const page = await readVlaanderenPage(client, { typeNames: "ad:Address" })

		expect(page.numberMatched).toBe(4_563_062)
		expect(page.numberReturned).toBe(0)
	})

	it("reads numberMatched=unknown as no count rather than as zero", async () => {
		const client = stubClient([collection('numberMatched="unknown" numberReturned="5"')])
		const page = await readVlaanderenPage(client, { typeNames: "ad:Address" })

		// Every results page of this service answers `unknown`.
		expect(page.numberMatched).toBeNull()
		expect(page.numberReturned).toBe(5)
	})

	it("raises on an OGC exception report rather than storing it as a page", async () => {
		const exception =
			'<?xml version="1.0" encoding="UTF-8"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">' +
			'<ows:Exception exceptionCode="NoApplicableCode"><ows:ExceptionText>java.lang.RuntimeException: ' +
			"Failed to get property: {http://www.opengis.net/wfs/2.0}boundedBy</ows:ExceptionText></ows:Exception>" +
			"</ows:ExceptionReport>"

		await expect(
			readVlaanderenPage(stubClient([exception]), { typeNames: "ad:AddressRepresentation" })
		).rejects.toThrow(/NoApplicableCode|boundedBy/)
	})
})

describe("readVlaanderenFeatureCount", () => {
	it("asks past index 0, because a bare hits request answers the service's cap", async () => {
		const client = stubClient([collection('numberMatched="4563062" numberReturned="0"')])

		expect(await readVlaanderenFeatureCount(client, "ad:Address")).toBe(4_563_062)
		expect(client.asked[0]).toMatchObject({ resultType: "hits", startIndex: "1" })
	})

	it("raises when the service states no count, so a missing count never reads as zero", async () => {
		const client = stubClient([collection('numberMatched="unknown" numberReturned="0"')])

		await expect(readVlaanderenFeatureCount(client, "ad:Address")).rejects.toThrow(/stated no numberMatched/)
	})
})

describe("harvestVlaanderenAD", () => {
	it("pages at the size the service actually serves", () => {
		// A `count=50000` request answers with 10,000 features, so asking for more
		// costs a request and returns the same body.
		expect(MAX_PAGE_SIZE).toBe(10_000)
	})

	it("writes each component type whole, then the pages and the manifest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vlaanderen-harvest-")

		const client = stubClient([
			// ad:ThoroughfareName: count, then the page.
			collection('numberMatched="2" numberReturned="0"'),
			collection('numberReturned="2"', "<wfs:member/><wfs:member/>"),
			// ad:PostalDescriptor
			collection('numberMatched="1" numberReturned="0"'),
			collection('numberReturned="1"', "<wfs:member/>"),
			// ad:AdminUnitName
			collection('numberMatched="1" numberReturned="0"'),
			collection('numberReturned="1"', "<wfs:member/>"),
			// ad:Address: count, then one page, then the empty page that ends the harvest.
			collection('numberMatched="3" numberReturned="0"'),
			collection('numberReturned="2" timeStamp="2026-10-02T02:51:14.514Z"', "<wfs:member/><wfs:member/>"),
			collection('numberReturned="0"'),
		])

		const harvest = await harvestVlaanderenAD(client, {
			outputDir: scratch.path,
			pageSize: 2,
			componentPageSize: 2,
		})

		expect(harvest.components).toEqual({
			ThoroughfareName: ["thoroughfare-name.gml"],
			PostalDescriptor: ["postal-descriptor.gml"],
			AdminUnitName: ["admin-unit-name.gml"],
		})

		expect(harvest.addressCount).toBe(3)
		expect(harvest.addressPages).toEqual([{ startIndex: 0, file: "address-0000000000.gml", numberReturned: 2 }])
		expect(harvest.retrievedAt).toBe("2026-10-02T02:51:14.514Z")
	})

	it("pages a component type past the page cap, under one file per page", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vlaanderen-harvest-")

		// `ad:ThoroughfareName` holds 167,218 against a 10,000 cap, so the real service needs this.
		const client = stubClient([
			collection('numberMatched="5" numberReturned="0"'),
			collection('numberReturned="2"', "<wfs:member/><wfs:member/>"),
			collection('numberReturned="2"', "<wfs:member/><wfs:member/>"),
			collection('numberReturned="1"', "<wfs:member/>"),
			collection('numberMatched="1" numberReturned="0"'),
			collection('numberReturned="1"', "<wfs:member/>"),
			collection('numberMatched="1" numberReturned="0"'),
			collection('numberReturned="1"', "<wfs:member/>"),
			collection('numberMatched="0" numberReturned="0"'),
		])

		const harvest = await harvestVlaanderenAD(client, {
			outputDir: scratch.path,
			pageSize: 2,
			componentPageSize: 2,
		})

		expect(harvest.components.ThoroughfareName).toEqual([
			"thoroughfare-name-0000000000.gml",
			"thoroughfare-name-0000000002.gml",
			"thoroughfare-name-0000000004.gml",
		])

		// A type that fits in one page keeps the unsuffixed name.
		expect(harvest.components.PostalDescriptor).toEqual(["postal-descriptor.gml"])
	})

	it("refuses a component type read short over its pages", async () => {
		await using scratch = await temporaryDirectory("mailwoman-vlaanderen-harvest-")

		const client = stubClient([
			collection('numberMatched="4" numberReturned="0"'),
			collection('numberReturned="2"', "<wfs:member/><wfs:member/>"),
			collection('numberReturned="0"'),
		])

		await expect(
			harvestVlaanderenAD(client, { outputDir: scratch.path, pageSize: 2, componentPageSize: 2 })
		).rejects.toThrow(
			/answered 2 features over 1 pages where its hits request stated 4, so the type was not read whole/
		)
	})
})
