/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The download listing and selection, over the real `APIClient` and a stub transport, so no test reaches the network.
 */

import { APIClient } from "@mailwoman/core/api"
import { type StubResult, stubTransport } from "@mailwoman/core/api/test-transport"
import { silentLogger } from "@mailwoman/core/logging"
import { OS_DOWNLOADS_API_BASE, type OSDownload } from "@mailwoman/spatial/gb/os-downloads"
import { describe, expect, it } from "vitest"

import { GB_OS_OPEN_PRODUCTS, readOSDownloads, selectOSDownload } from "#gb/tools/fetch/os-open"

function stubClient(results: StubResult[]): APIClient & { calls: string[] } {
	const transport = stubTransport(results)
	const client = new APIClient({ displayName: "gb-os-open test", logger: silentLogger(), axios: transport.axios })

	return Object.assign(client, { calls: transport.calls })
}

const download = (format: string, area: string): OSDownload => ({
	md5: "0".repeat(32),
	size: 1,
	url: `${OS_DOWNLOADS_API_BASE}/products/OpenRoads/downloads?area=${area}&format=${format}`,
	format,
	area,
	fileName: `oproad_${format.toLowerCase()}_${area.toLowerCase()}.zip`,
})

const roads = GB_OS_OPEN_PRODUCTS.find((product) => product.productID === "OpenRoads")!

describe("selectOSDownload", () => {
	it("takes the Great Britain archive in the product's format", () => {
		const chosen = selectOSDownload(roads, [download("GeoPackage", "GB"), download("GML", "GB"), download("GML", "SE")])

		expect(chosen.fileName).toBe("oproad_gml_gb.zip")
	})

	it("names the listed formats when the product's is absent", () => {
		expect(() => selectOSDownload(roads, [download("GeoPackage", "GB")])).toThrow(/GeoPackage\/GB/)
	})
})

describe("readOSDownloads", () => {
	it("reads the product's downloads endpoint", async () => {
		const client = stubClient([{ body: [download("GML", "GB")] }])

		await expect(readOSDownloads(client, roads)).resolves.toEqual([download("GML", "GB")])
		expect(client.calls[0]).toContain("/products/OpenRoads/downloads")
	})

	it("refuses an answer that is not a list", async () => {
		const client = stubClient([{ body: { error: "not a list" } }])

		await expect(readOSDownloads(client, roads)).rejects.toThrow(/no download list/)
	})
})
