/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { datasetURLOf, DK_ADDRESSES_FEED_URL, readAddressesFeed } from "#dk/tools/fetch/inspire"

/**
 * The feed as `https://www2.sdfe.dk/INSPIRE/feeds/Addresses.xml` served it,
 * trimmed to the envelope and the one entry. 3,130 bytes decode to 3,125 characters,
 * and the `content-length` header says 1,455.
 *
 * The two shapes a reader has to survive are both here: the entry carries `xml:lang`,
 * and every href separates its query parameters with `&amp;`.
 */
const FEED_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0" xmlns:georss="http://www.georss.org/georss">
<title>Klimadatastyrelsen INSPIRE Addresses</title>
<updated>2020-12-24T12:00:00+01:00</updated>
<author><name>Klimadatastyrelsen</name></author>
<rights>CC BY 4.0</rights>
<link rel="describedby" href="https://creativecommons.org/licenses/by/4.0/deed.da" type="text/html"/>
<link rel="search" href="https://www2.sdfe.dk/INSPIRE/feeds/OpenSearchDescription.xml" type="application/opensearchdescription+xml"/>
<entry xml:lang="da">
<title>DK INSPIRE Addresses</title>
<inspire_dls:spatial_dataset_identifier_code>https://geo.data.gov.dk/dataset/50b921ea-935e-d605-2287-4ee364046795</inspire_dls:spatial_dataset_identifier_code>
<link rel="alternate" href="https://ftp.sdfe.dk/main.html?download&amp;weblink=39593534f26800b910ef341fa8ec6aec" type="application/geopackage+sqlite3" length="4291699" title="DK INSPIRE Addresses" hreflang="da"/>
<link href="https://geodata-info.dk/srv/eng/csw?service=CSW&amp;request=GetRecordById&amp;version=2.0.2&amp;id=50b921ea-935e-d605-2287-4ee364046795" rel="describedby" type="application/xml" title="ISO19139 Dataset Metadata" hreflang="da"/>
<id>https://ftp.sdfe.dk/main.html?download&amp;weblink=39593534f26800b910ef341fa8ec6aec</id>
<updated>2022-10-06T10:14:07+01:00</updated>
<category term="http://www.opengis.net/def/crs/EPSG/0/25832" label="ETRS89 / UTM zone 32N"/>
<summary type="text" xml:lang="da">Feature type: Addresses, Område: Danmark, Projektion: ETRS89 / UTM zone 32N</summary>
<georss:polygon>54.20834 7.73235 54.20834 15.90124 57.96045 15.90124 57.96045 7.73235 54.20834 7.73235</georss:polygon>
</entry>
</feed>`

describe("readAddressesFeed", () => {
	it("reads the one entry the feed publishes, whose open tag carries an attribute", async () => {
		const entry = await readAddressesFeed(FEED_XML, DK_ADDRESSES_FEED_URL)

		expect(entry.title).toBe("DK INSPIRE Addresses")
		expect(entry.mediaType).toBe("application/geopackage+sqlite3")
	})

	it("names the zip member on the href, because the bare weblink serves a landing page", async () => {
		const entry = await readAddressesFeed(FEED_XML, DK_ADDRESSES_FEED_URL)

		expect(entry.downloadURL).toBe(
			"https://ftp.sdfe.dk/main.html?download&weblink=39593534f26800b910ef341fa8ec6aec" +
				"&realfilename=DK_INSPIRE_Addresses.zip"
		)
	})

	it("separates the href's query parameters with a bare ampersand", async () => {
		const entry = await readAddressesFeed(FEED_XML, DK_ADDRESSES_FEED_URL)

		// An `&amp;` left in place makes the host read the parameter name as `amp;weblink`.
		expect(entry.downloadURL).not.toContain("&amp;")
		expect(new URL(entry.downloadURL).searchParams.get("weblink")).toBe("39593534f26800b910ef341fa8ec6aec")
	})

	it("takes the alternate link rather than the describedby link beside it", async () => {
		const entry = await readAddressesFeed(FEED_XML, DK_ADDRESSES_FEED_URL)

		expect(entry.downloadURL).toContain("ftp.sdfe.dk")
		expect(entry.downloadURL).not.toContain("geodata-info.dk")
	})

	it("raises on a feed holding no entry rather than answering nothing", async () => {
		await expect(readAddressesFeed("<feed><title>Addresses</title></feed>", DK_ADDRESSES_FEED_URL)).rejects.toThrow(
			/holds no <entry>/
		)
	})

	it("raises on an entry whose only link is not the dataset", async () => {
		const xml =
			`<feed><entry xml:lang="da"><title>DK INSPIRE Addresses</title>` +
			`<link rel="describedby" href="https://example.invalid/record" type="application/xml"/></entry></feed>`

		await expect(readAddressesFeed(xml, DK_ADDRESSES_FEED_URL)).rejects.toThrow(/carries no rel="alternate" link/)
	})
})

describe("datasetURLOf", () => {
	it("appends the member name to a weblink that does not state one", () => {
		expect(datasetURLOf("https://ftp.sdfe.dk/main.html?download&weblink=abc")).toBe(
			"https://ftp.sdfe.dk/main.html?download&weblink=abc&realfilename=DK_INSPIRE_Addresses.zip"
		)
	})

	it("leaves a URL that already names the member unchanged", () => {
		const named = "https://ftp.sdfe.dk/main.html?download&weblink=abc&realfilename=DK_INSPIRE_Addresses.zip"

		// A publisher that starts writing the complete URL into the feed must not get the parameter twice.
		expect(datasetURLOf(named)).toBe(named)
	})
})
