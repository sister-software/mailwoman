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
	it("accepts a count a page agrees with", async () => {
		const count = await readCheckedWFSFeatureCount(
			stubFetchingBodies(
				'<wfs:FeatureCollection numberMatched="1704196" numberReturned="0"/>',
				'<wfs:FeatureCollection numberMatched="1704196" numberReturned="10"/>'
			),
			options
		)

		expect(count).toEqual({ reported: 1_704_196, usable: true, because: expect.stringContaining("10 features") })
	})

	it("refuses a count that returns more features than it admits", async () => {
		// Poland's INSPIRE Addresses service answers numberMatched="1" at every
		// startIndex for a national address register.
		// Recording that number would report one address for a country.
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
	 * A service holding `extent` features that answers a page honestly and states
	 * no usable count, which is the shape Poland's does.
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
		expect(readOGCServiceException('<wfs:FeatureCollection numberMatched="3"/>')).toBeUndefined()
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
})

describe("readWFSFeatureCount over an exception report", () => {
	it("refuses a ServiceExceptionReport that arrived on a 200 instead of reading it as a missing count", async () => {
		await expect(readWFSFeatureCount(stubFetchingBodies(INVALID_COLUMN), options)).rejects.toBeInstanceOf(
			OGCServiceError
		)
	})
})
