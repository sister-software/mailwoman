/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `numberMatched` decides whether a layer build has anything to fetch. Preserve the three WFS answers separately:
 *   a count, a refusal to count and a malformed response.
 */

import { describe, expect, it } from "vitest"

import { OGCServiceError, readCheckedWFSFeatureCount, readOGCServiceException, readWFSFeatureCount } from "#api"
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
