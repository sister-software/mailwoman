/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `numberMatched` decides whether a layer build has anything to fetch, so the three answers a WFS server can give
 *   must stay three answers: a count, a refusal to count, and a malformed response.
 */

import { type APIClient, OGCServiceError, readOGCServiceException, readWFSFeatureCount } from "@mailwoman/core/api"
import type { AxiosResponse } from "axios"
import { describe, expect, it } from "vitest"

/**
 * The one method {@linkcode readWFSFeatureCount} reaches. `fetch` resolves a full axios response; only `data` is read,
 * so the stub states that field and asserts the shape once rather than hand-building headers and a config.
 */
const clientReturning = (data: string): Pick<APIClient, "fetch"> => ({
	fetch: async <T>() => ({ data: data as T }) as AxiosResponse<T>,
})

const options = { wfsURL: "https://example.invalid/wfs", typeNames: "layer", context: "test", subject: "zones" }

describe("readWFSFeatureCount", () => {
	it("reads the count off the root element", async () => {
		const body = '<wfs:FeatureCollection numberMatched="1274" numberReturned="0"/>'

		expect(await readWFSFeatureCount(clientReturning(body), options)).toBe(1274)
	})

	it("reads a count of zero as a count, not as a missing attribute", async () => {
		expect(await readWFSFeatureCount(clientReturning('<wfs:FeatureCollection numberMatched="0"/>'), options)).toBe(0)
	})

	it('refuses numberMatched="unknown" by naming it, since declining to count is not a count of none', async () => {
		const body = '<wfs:FeatureCollection numberMatched="unknown"/>'

		await expect(readWFSFeatureCount(clientReturning(body), options)).rejects.toThrow(/declined to count/u)
	})

	it("refuses a response carrying no numberMatched at all", async () => {
		await expect(readWFSFeatureCount(clientReturning("<wfs:FeatureCollection/>"), options)).rejects.toThrow(
			/carried no numberMatched/u
		)
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
		await expect(readWFSFeatureCount(clientReturning(INVALID_COLUMN), options)).rejects.toBeInstanceOf(OGCServiceError)
	})
})
