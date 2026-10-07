/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"

/**
 * The envelope of ČÚZK's service document with two of its entries,
 * as `https://atom.cuzk.gov.cz/AD/AD.xml` served them on 2026-10-02.
 *
 * Both shapes a reader has to survive are here: a feed-level `<link>` sits beside the
 * entries that have their own, and every href separates its query parameters with `&amp;`.
 */
const CZ_SERVICE_XML =
	`<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
	`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:georss="http://www.georss.org/georss" ` +
	`xmlns:inspire_dls="http://inspire.ec.europa.eu/schemas/inspire_dls/1.0" xml:lang="cs">` +
	`<id>https://atom.cuzk.gov.cz/AD/AD.xml</id>` +
	`<title>INSPIRE stahovací služba ATOM pro téma Adresy (AD)</title>` +
	`<updated>2026-10-01T08:38:52+02:00</updated>` +
	`<rights>žádné podmínky neplatí</rights>` +
	`<link href="http://geoportal.cuzk.gov.cz/SDIProCSW/service.svc/get?REQUEST=GetRecordById&amp;SERVICE=CSW` +
	`&amp;Id=CZ-00025712-CUZK_ATOM-MD_AD" rel="describedby" title="metadata stahovací služby" type="application/xml"/>` +
	`<link href="https://atom.cuzk.gov.cz/AD/AD.xml" hreflang="cs" rel="self" type="application/atom+xml"/>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258" rel="next" title="ETRS89" type="text/xml"/>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514" rel="next" title="S-JTSK" type="text/xml"/>` +
	`<entry><id>https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584061.xml</id>` +
	`<title>INSPIRE - adresní místa - obec: Unkovice [584061]</title>` +
	`<updated>2026-06-04T02:19:33+02:00</updated><rights>žádné podmínky neplatí</rights>` +
	`<link href="http://geoportal.cuzk.gov.cz/SDIProCSW/service.svc/get?REQUEST=GetRecordById&amp;SERVICE=CSW` +
	`&amp;Id=CZ-00025712-CUZK_AD_584061" rel="describedby" title="metadata datasetu" type="application/xml"/>` +
	`<link href="https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584061.xml" rel="alternate" ` +
	`title="dataset feed" type="application/atom+xml"/>` +
	`<category label="ETRS89" term="http://www.opengis.net/def/crs/EPSG/0/4258"/>` +
	`<inspire_dls:spatial_dataset_identifier_code>CZ-00025712-CUZK_AD_584061` +
	`</inspire_dls:spatial_dataset_identifier_code>` +
	`<georss:polygon> 49.0281 16.612 49.0245 16.5617</georss:polygon></entry>` +
	`<entry><id>https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584282.xml</id>` +
	`<title>INSPIRE - adresní místa - obec: Židlochovice [584282]</title>` +
	`<updated>2026-09-22T02:57:55+02:00</updated><rights>žádné podmínky neplatí</rights>` +
	`<link href="https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584282.xml" rel="alternate" ` +
	`title="dataset feed" type="application/atom+xml"/>` +
	`<inspire_dls:spatial_dataset_identifier_code>CZ-00025712-CUZK_AD_584282` +
	`</inspire_dls:spatial_dataset_identifier_code></entry>` +
	`</feed>`

/**
 * One municipality's dataset feed, the second ATOM level, with one entry per projection.
 */
const CZ_DATASET_FEED_XML =
	`<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
	`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="cs">` +
	`<id>https://atom.cuzk.cz/AD/datasetFeeds/CZ-00025712-CUZK_AD_584061.xml</id>` +
	`<title>INSPIRE - adresní místa - obec: Unkovice [584061]</title>` +
	`<updated>2026-06-04T02:19:33+02:00</updated>` +
	`<link href="https://atom.cuzk.cz/AD/AD.xml" hreflang="cs" rel="up" type="application/atom+xml"/>` +
	`<entry><id>https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514/584061.zip</id>` +
	`<title>INSPIRE - adresní místa - obec: Unkovice [584061]</title>` +
	`<updated>2026-06-04T02:19:33+02:00</updated>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-5514/584061.zip" length="25248" ` +
	`rel="alternate" type="application/gml+xml" hreflang="cs"/></entry>` +
	`<entry><id>https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip</id>` +
	`<title>INSPIRE - adresní místa - obec: Unkovice [584061]</title>` +
	`<updated>2026-06-04T02:19:33+02:00</updated>` +
	`<link href="https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258/584061.zip" length="24846" ` +
	`rel="alternate" type="application/gml+xml" hreflang="cs"/></entry>` +
	`</feed>`

describe("readAtomFeed", () => {
	it("tells a feed's own links from the links inside its entries", async () => {
		const feed = await readAtomFeed(feedChunks(CZ_SERVICE_XML))

		// Four feed-level links, and not the five that sit inside the two entries.
		expect(feed.links.map((link) => link.rel)).toEqual(["describedby", "self", "next", "next"])
		expect(feed.entries).toHaveLength(2)
	})

	it("reads each entry's title, updated, rights and INSPIRE identifier", async () => {
		const feed = await readAtomFeed(feedChunks(CZ_SERVICE_XML))
		const [first] = feed.entries

		expect(first?.title).toBe("INSPIRE - adresní místa - obec: Unkovice [584061]")
		expect(first?.updated).toBe("2026-06-04T02:19:33+02:00")
		expect(first?.rights).toBe("žádné podmínky neplatí")
		expect(first?.identifierCode).toBe("CZ-00025712-CUZK_AD_584061")
	})

	it("decodes the escaped ampersand in an href, so a query parameter is not read as `amp;SERVICE`", async () => {
		const feed = await readAtomFeed(feedChunks(CZ_SERVICE_XML))
		const metadata = linkWithRel(feed.links, "describedby")

		expect(metadata?.href).not.toContain("&amp;")
		expect(new URL(metadata?.href ?? "").searchParams.get("SERVICE")).toBe("CSW")
	})

	it("reads a numeric length and reports a missing one as null", async () => {
		const dataset = await readAtomFeed(feedChunks(CZ_DATASET_FEED_XML))
		const lengths = dataset.entries.map((entry) => entry.links[0]?.length)

		expect(lengths).toEqual([25_248, 24_846])

		const service = await readAtomFeed(feedChunks(CZ_SERVICE_XML))

		// The service document states no length on any link.
		// That is not a length of zero.
		expect(service.links.every((link) => link.length === null)).toBe(true)
	})

	it("lower-cases the rel value and keeps href, type and title as the publisher wrote them", async () => {
		// XML attribute names are case-sensitive, so the reader matches the spelling ATOM
		// prescribes and lower-cases only the controlled value inside it.
		const feed = await readAtomFeed(
			feedChunks(`<feed><link rel="NEXT" href="https://e.invalid/A" type="Text/XML" title="ETRS89"/></feed>`)
		)

		expect(feed.links[0]).toMatchObject({
			rel: "next",
			href: "https://e.invalid/A",
			type: "Text/XML",
			title: "ETRS89",
		})
	})

	it("answers no entries for a feed holding none, leaving the refusal to the caller", async () => {
		const feed = await readAtomFeed(feedChunks(`<feed><title>Adresy</title></feed>`))

		expect(feed.entries).toEqual([])
		expect(feed.links).toEqual([])
	})

	it("reads a feed arriving in several chunks, including one split inside an entry", async () => {
		async function* split(): AsyncIterable<string> {
			const half = Math.floor(CZ_SERVICE_XML.length / 2)

			yield CZ_SERVICE_XML.slice(0, half)
			yield CZ_SERVICE_XML.slice(half)
		}

		const feed = await readAtomFeed(split())

		expect(feed.entries.map((entry) => entry.identifierCode)).toEqual([
			"CZ-00025712-CUZK_AD_584061",
			"CZ-00025712-CUZK_AD_584282",
		])
	})
})

describe("linkWithRel", () => {
	it("takes the first link with the relation, however the document cases it", async () => {
		const feed = await readAtomFeed(feedChunks(CZ_SERVICE_XML))

		expect(linkWithRel(feed.links, "NEXT")?.href).toBe("https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258")
	})

	it("answers null for a relation the collection does not carry", async () => {
		const feed = await readAtomFeed(feedChunks(CZ_SERVICE_XML))

		expect(linkWithRel(feed.links, "enclosure")).toBeNull()
	})
})
