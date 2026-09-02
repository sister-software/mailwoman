/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `numberMatched` decides whether a layer build has anything to fetch, so the three answers a WFS server can give
 *   must stay three answers: a count, a refusal to count, and a malformed response.
 */

import { type APIClient, readWFSFeatureCount } from "@mailwoman/core/api"
import { describe, expect, it } from "vitest"

const clientReturning = (data: string) => ({ fetch: async () => ({ data }) }) as unknown as Pick<APIClient, "fetch">

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
