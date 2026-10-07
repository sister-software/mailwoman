/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `numberMatched` decides whether a layer build has anything to fetch. Preserve the three WFS answers separately:
 *   a count, a refusal to count and a malformed response.
 */

import type { AxiosResponse } from "axios"
import { describe, expect, it } from "vitest"

import {
	type APIClient,
	countWFSFeaturesByPaging,
	OGCServiceError,
	readCheckedWFSFeatureCount,
	readOGCServiceException,
	readWFSFeatureCount,
} from "#api"
import { stubFetchingBodies } from "#api/test/transport"

const options = { wfsURL: "https://example.invalid/wfs", typeNames: "layer", context: "test", subject: "zones" }

describe("readWFSFeatureCount", () => {
	it("reads the count off the root element", async () => {
		const body = '<wfs:FeatureCollection numberMatched="1274" numberReturned="0"/>'

		expect(await readWFSFeatureCount(stubFetchingBodies(body), options)).toBe(1274)
	})

	it("reads a count of zero as a count, not as a missing attribute", async () => {
		expect(await readWFSFeatureCount(stubFetchingBodies('<wfs:FeatureCollection numberMatched="0"/>'), options)).toBe(0)
	})

	it('refuses numberMatched="unknown" by naming it, since declining to count is not a count of none', async () => {
		const body = '<wfs:FeatureCollection numberMatched="unknown"/>'

		await expect(readWFSFeatureCount(stubFetchingBodies(body), options)).rejects.toThrow(/declined to count/u)
	})

	it("refuses a response carrying no numberMatched at all", async () => {
		await expect(readWFSFeatureCount(stubFetchingBodies("<wfs:FeatureCollection/>"), options)).rejects.toThrow(
			/carried no numberMatched/u
		)
	})
})

describe("readCheckedWFSFeatureCount", () => {
	it("accepts a count a page agrees with and no feature sits past", async () => {
		// Slovakia's shape: the hits count, a page agreeing with it, and an empty page at the count's own index.
		// A service holding exactly that many answers this way.
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="1704196" numberReturned="0"/>',
				'<wfs:FeatureCollection numberMatched="1704196" numberReturned="10"/>',
				'<wfs:FeatureCollection numberMatched="1704196" numberReturned="0"/>'
			),
			options
		)

		expect(count).toEqual({ reported: 1_704_196, usable: true, because: expect.stringContaining("10 features") })
	})

	it("refuses a count that returns more features than it admits", async () => {
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="1" numberReturned="0"/>',
				'<wfs:FeatureCollection numberMatched="1" numberReturned="10"/>'
			),
			options
		)

		expect(count.usable).toBe(false)
		expect(count.reported).toBe(1)
		expect(count.because).toMatch(/describes its own response rather than the type/u)
	})

	it("refuses a count a page cannot exceed, which agreement alone cannot detect", async () => {
		// Poland's INSPIRE Addresses service answers numberMatched="1000", MapServer's
		// own feature cap, and caps its pages at 1,000 as well.
		// A 10-feature probe therefore agrees with the count while the type held 8,626,951 on 2026-10-02.
		// Only the third request separates them: a service holding 1,000 features returns
		// none at startIndex=1000, and this one returns a feature.
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="1000" numberReturned="0"/>',
				'<wfs:FeatureCollection numberMatched="unknown" numberReturned="10"/>',
				'<wfs:FeatureCollection numberMatched="unknown" numberReturned="1"/>'
			),
			options
		)

		expect(count.usable).toBe(false)
		expect(count.reported).toBe(1000)
		expect(count.because).toMatch(/a floor rather than the type's size/u)
	})

	it("accepts a count whose index answers an absent numberReturned rather than a feature", async () => {
		// A service that states no `numberReturned` on the probe past the count has not shown a
		// feature there, so the count stands rather than being refused on a missing attribute.
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="42" numberReturned="0"/>',
				'<wfs:FeatureCollection numberReturned="10"/>',
				"<wfs:FeatureCollection/>"
			),
			options
		)

		expect(count.usable).toBe(true)
		expect(count.reported).toBe(42)
	})

	it("reports a declined count as unread rather than as none", async () => {
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="unknown"/>',
				'<wfs:FeatureCollection numberReturned="0"/>'
			),
			options
		)

		expect(count.usable).toBe(false)
		expect(count.reported).toBeNull()
		expect(count.because).toMatch(/declining to count/u)
	})

	it("reports a missing attribute rather than assuming one", async () => {
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies("<wfs:FeatureCollection/>", "<wfs:FeatureCollection/>"),
			options
		)

		expect(count.usable).toBe(false)
		expect(count.because).toMatch(/no numberMatched attribute/u)
	})
})

describe("countWFSFeaturesByPaging", () => {
	/**
	 * A service holding `extent` features that answers a page honestly and states no usable count.
	 *
	 * That is the shape Poland's service takes.
	 * It records every `startIndex` it was asked for.
	 */
	const servingExtent = (extent: number, asked: number[] = []): Pick<APIClient, "fetch"> => ({
		fetch: async <T>(config?: { params?: Record<string, unknown> }) => {
			const startIndex = Number(config?.params?.["startIndex"] ?? 0)
			const count = Number(config?.params?.["count"] ?? 1)

			asked.push(startIndex)

			const returned = Math.max(0, Math.min(count, extent - startIndex))

			const members = Array.from(
				{ length: returned },
				(_unused, offset) => `<wfs:member><ms:AD.Address gml:id="AD.Address.${startIndex + offset}"/></wfs:member>`
			).join("")

			return {
				data: `<wfs:FeatureCollection numberMatched="unknown" numberReturned="${returned}">${members}</wfs:FeatureCollection>` as T,
			} as AxiosResponse<T>
		},
	})

	const pagingOptions = { ...options, outputFormat: "text/xml; subtype=gml/3.2.1" }

	it("measures the extent of a type whose own count is unusable", async () => {
		const measured = await countWFSFeaturesByPaging(servingExtent(8_625_921), pagingOptions)

		expect(measured.count).toBe(8_625_921)
		expect(measured.confirmed).toBe(true)
	})

	it("costs about twice the base-two logarithm of the extent, rather than a request per feature", async () => {
		const asked: number[] = []
		const measured = await countWFSFeaturesByPaging(servingExtent(8_625_921, asked), pagingOptions)

		// 51 requests measured Poland's service on 2026-10-01, so the bound is held near that.
		expect(measured.requests).toBeLessThanOrEqual(60)
		expect(asked).toHaveLength(measured.requests)
	})

	it("reads an empty type as zero rather than searching for a boundary", async () => {
		const measured = await countWFSFeaturesByPaging(servingExtent(0), pagingOptions)

		expect(measured).toEqual({ count: 0, requests: 1, confirmed: true })
	})

	it("measures a type holding one feature", async () => {
		const measured = await countWFSFeaturesByPaging(servingExtent(1), pagingOptions)

		expect(measured.count).toBe(1)
	})

	it("refuses a service that ignores startIndex rather than measuring its page cap", async () => {
		// Every page is the first, so the search would double forever and report the cap.
		const ignoring: Pick<APIClient, "fetch"> = {
			fetch: async <T>() =>
				({
					data: '<wfs:FeatureCollection numberReturned="2"><wfs:member><ms:AD.Address gml:id="AD.Address.0"/></wfs:member></wfs:FeatureCollection>' as T,
				}) as AxiosResponse<T>,
		}

		await expect(countWFSFeaturesByPaging(ignoring, pagingOptions)).rejects.toThrow(/ignoring startIndex/u)
	})
})

const INVALID_COLUMN = `<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
<ServiceExceptionReport xmlns="http://www.opengis.net/ogc" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<ServiceException>
Invalid query: Invalid column name &#39;nosuchcolumn&#39;.</ServiceException>
</ServiceExceptionReport>
`

describe("readOGCServiceException", () => {
	it("reads the exception out of the report and decodes its entities", () => {
		expect(readOGCServiceException(INVALID_COLUMN)).toBe("Invalid query: Invalid column name 'nosuchcolumn'.")
	})

	it("returns nothing for a real answer", () => {
		expect(readOGCServiceException('<wfs:FeatureCollection numberMatched="3"/>')).toBeNull()
	})

	it("answers in linear time on a report whose exception element is never closed", () => {
		const unclosed = `<ServiceExceptionReport xmlns="http://www.opengis.net/ogc"><ServiceException>${"x".repeat(200_000)}`
		const started = performance.now()

		expect(readOGCServiceException(unclosed)).toMatch(/no readable ServiceException/u)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("never mistakes the enclosing report element for the exception it wraps", () => {
		const nested = `<ServiceExceptionReport xmlns="http://www.opengis.net/ogc">
<ServiceException>Invalid query - access denied.</ServiceException>
</ServiceExceptionReport>`

		expect(readOGCServiceException(nested)).toBe("Invalid query - access denied.")
	})

	it("reads a WFS 2.0 report, which states its condition in an attribute", () => {
		// Flanders' `ad:AddressRepresentation` answers this on every `startIndex`,
		// and a reader knowing only the OGC 1.x spelling passed it through as a feature page.
		const ows = `<?xml version="1.0" encoding="UTF-8"?>
<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">
	<ows:Exception exceptionCode="NoApplicableCode">
		<ows:ExceptionText>java.lang.RuntimeException: Failed to get property: {http://www.opengis.net/wfs/2.0}boundedBy</ows:ExceptionText>
	</ows:Exception>
</ows:ExceptionReport>`

		expect(readOGCServiceException(ows)).toBe(
			"NoApplicableCode: java.lang.RuntimeException: Failed to get property: {http://www.opengis.net/wfs/2.0}boundedBy"
		)
	})

	it("reads a WFS 2.0 report whose OWS namespace is the default one", () => {
		const unprefixed = `<ExceptionReport xmlns="http://www.opengis.net/ows/1.1">
	<Exception exceptionCode="InvalidParameterValue" locator="outputFormat">
		<ExceptionText>Failed to find response for output format geojson</ExceptionText>
	</Exception>
</ExceptionReport>`

		expect(readOGCServiceException(unprefixed)).toBe(
			"InvalidParameterValue: Failed to find response for output format geojson"
		)
	})

	it("reports a WFS 2.0 report that states no message as unreadable rather than as empty", () => {
		const bare = `<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1">
	<ows:Exception exceptionCode="NoApplicableCode" />
</ows:ExceptionReport>`

		expect(readOGCServiceException(bare)).toBe("NoApplicableCode: the report carried no readable ExceptionText element")
	})

	it("decodes entities in a WFS 2.0 message", () => {
		const encoded = `<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>Unknown namespace &#39;AD_Address&#39;</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`

		expect(readOGCServiceException(encoded)).toBe("InvalidParameterValue: Unknown namespace 'AD_Address'")
	})

	it("answers in linear time on a WFS 2.0 report whose message is never closed", () => {
		const unclosed = `<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:ExceptionText>${"x".repeat(200_000)}`
		const started = performance.now()

		expect(readOGCServiceException(unclosed)).toMatch(/no readable ExceptionText/u)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("returns nothing for a 2.0 feature collection, whose root shares no name with a report", () => {
		expect(
			readOGCServiceException(
				'<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" numberMatched="unknown"/>'
			)
		).toBeNull()
	})
})

describe("readWFSFeatureCount over an exception report", () => {
	it("refuses a ServiceExceptionReport that arrived on a 200 instead of reading it as a missing count", async () => {
		await expect(readWFSFeatureCount(stubFetchingBodies(INVALID_COLUMN), options)).rejects.toBeInstanceOf(
			OGCServiceError
		)
	})
})
