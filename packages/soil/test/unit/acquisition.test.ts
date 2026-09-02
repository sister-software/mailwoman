/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The acquisition side: the failure body Soil Data Access actually returns, the metadata that decides an
 *   artifact's vintage and its licence, and the farmland scope that decides whether two rows are comparable.
 *
 *   THE EXCEPTION FIXTURE IS THE LIVE SERVICE'S OWN BODY, captured from a query with a bad column name. Its
 *   twin — a query that exceeds the server's own timeout — returns the SAME document shape on an HTTP 200,
 *   which is why the detection is on the body rather than on the status.
 */

import { readServiceException } from "@mailwoman/soil/sdk/client"
import { readFGDCMetadata } from "@mailwoman/soil/sdk/survey-area"
import { FarmlandScope, farmlandScope, soilLayerName } from "@mailwoman/soil/vocabulary"
import { describe, expect, it } from "vitest"

/**
 * The live service's answer to `SELECT nosuchcolumn FROM sacatalog`, verbatim, HTTP 400.
 */
const INVALID_COLUMN = `<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
<ServiceExceptionReport xmlns="http://www.opengis.net/ogc" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.opengis.net/ogc http://schemas.opengis.net/wms/1.1.1/OGC-exception.xsd">
<ServiceException>
Invalid query: Invalid column name &#39;nosuchcolumn&#39;.</ServiceException>
</ServiceExceptionReport>
`

/**
 * The same document a server-side timeout returns — on an HTTP 200, which is the whole trap.
 */
const TIMED_OUT = `<?xml version='1.0' encoding="UTF-8" standalone="no" ?>
<ServiceExceptionReport xmlns="http://www.opengis.net/ogc">
<ServiceException>
Your query timed out.</ServiceException>
</ServiceExceptionReport>
`

describe("readServiceException", () => {
	it("reads the exception out of the report and decodes its entities", () => {
		expect(readServiceException(INVALID_COLUMN)).toBe("Invalid query: Invalid column name 'nosuchcolumn'.")
	})

	it("catches the timeout report, which arrives on a 200 and would otherwise read as an empty answer", () => {
		expect(readServiceException(TIMED_OUT)).toBe("Your query timed out.")
	})

	it("returns nothing for a real answer, so the JSON path is untouched", () => {
		expect(readServiceException('{"Table":[["IA153"]]}')).toBeUndefined()
	})

	it("answers in linear time on a report whose exception element is never closed", () => {
		// The shape a lazy `[\\s\\S]*?` scan backtracks polynomially over: an opening tag with no closing partner, in a
		// body a network service produced. It must return the "could not read" reading rather than spend the document.
		const unclosed = `<ServiceExceptionReport xmlns="http://www.opengis.net/ogc"><ServiceException>${"x".repeat(200_000)}`
		const started = performance.now()

		expect(readServiceException(unclosed)).toMatch(/no readable ServiceException/u)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("never mistakes the enclosing report element for the exception it wraps", () => {
		// `<ServiceExceptionReport …>` shares the whole prefix. Matching it captures the entire report body as the message.
		const nested = `<ServiceExceptionReport xmlns="http://www.opengis.net/ogc">
<ServiceException>Invalid query - access denied.</ServiceException>
</ServiceExceptionReport>`

		expect(readServiceException(nested)).toBe("Invalid query - access denied.")
	})
})

/**
 * The shape of the FGDC document NRCS ships inside every survey-area archive, trimmed to the elements this layer reads.
 * The dates and the scale are `IA153`'s real ones.
 */
const FGDC = `<metadata><idinfo><citation><citeinfo><origin>
U.S. Department of Agriculture, Natural Resources Conservation Service
</origin><pubdate>20250909</pubdate><title>
Soil Survey Geographic (SSURGO) database for Polk County, Iowa
</title></citeinfo></citation><useconst>
The U.S. Department of Agriculture, Natural Resources Conservation Service, should be acknowledged as the data source in products derived from these data. This is public information and may be interpreted by organizations, agencies, units of government, or others based on needs; however, they are responsible for the appropriate application.
</useconst></idinfo><dataqual><lineage>
<srcinfo><srccite><citeinfo><title>Soil Survey of Polk County, Iowa</title></citeinfo></srccite><srcscale>15840</srcscale><srctime><timeinfo><sngdate><caldate>1960</caldate></sngdate></timeinfo></srctime></srcinfo>
<srcinfo><srccite><citeinfo><title>annotated overlay</title></citeinfo></srccite><srcscale>12000</srcscale><srctime><timeinfo><sngdate><caldate>1996</caldate></sngdate></timeinfo></srctime></srcinfo>
<srcinfo><srccite><citeinfo><title>region 10 soils geodatabase</title></citeinfo></srccite><srctime><timeinfo><rngdates><begdate>2006</begdate><enddate>2018</enddate></rngdates></timeinfo></srctime></srcinfo>
</lineage></dataqual></metadata>`

describe("readFGDCMetadata", () => {
	it("takes the OLDEST source citation, which is the field survey the polygons rest on", () => {
		const metadata = readFGDCMetadata(FGDC, "IA153")

		// The refresh is 2025; the ground was walked in 1960. A consumer reading the refresh as survey currency reads it
		// wrong by sixty-five years, so both travel and the older one names its source.
		expect(metadata.publicationDate).toBe("2025-09-09")
		expect(metadata.oldestSourceDate).toBe("1960")
		expect(metadata.oldestSourceTitle).toBe("Soil Survey of Polk County, Iowa")
		expect(metadata.oldestSourceScale).toBe(15_840)
	})

	it("refuses a survey area whose use constraints no longer carry the public-information sentence", () => {
		const withoutGrant = FGDC.replace("This is public information and may be interpreted", "This is restricted and")

		// That sentence IS the grant this layer ships on. A build that absorbed its removal would ship an artifact under
		// terms nobody checked.
		expect(() => readFGDCMetadata(withoutGrant, "IA153")).toThrow(/public information/u)
	})

	it("refuses metadata with no publication date rather than stamping a guessed vintage", () => {
		expect(() => readFGDCMetadata(FGDC.replace(/<pubdate>.*?<\/pubdate>/u, ""), "IA153")).toThrow(
			/no publication date/u
		)
	})

	it("reads an unclosed element as unreadable, in one pass rather than by scanning for it", () => {
		// What a truncated archive produces, and what a lazy-quantifier reader backtracks polynomially over. Every element
		// after the truncation is unreadable, so the licence assertion — the FIRST thing read — is what refuses, and the refusal
		// doubles as the timing check.
		const truncated = `${FGDC.slice(0, FGDC.indexOf("<pubdate>") + "<pubdate>".length)}${"9".repeat(200_000)}`
		const started = performance.now()

		expect(() => readFGDCMetadata(truncated, "IA153")).toThrow(/public information/u)
		expect(performance.now() - started).toBeLessThan(1000)
	})
})

describe("farmlandScope", () => {
	it("marks the two nationally-defined categories as comparable between states", () => {
		// 7 CFR 657.5(a)–(b): prime and unique farmland are defined nationally against nine specific criteria.
		expect(farmlandScope("All areas are prime farmland")).toBe(FarmlandScope.Federal)
		expect(farmlandScope("Prime farmland if drained")).toBe(FarmlandScope.Federal)
		expect(farmlandScope("Farmland of unique importance")).toBe(FarmlandScope.Federal)
	})

	it("marks the delegated categories, which do NOT travel between states", () => {
		// §657.5(c) and (d) hand these to state and local agencies, so Iowa's and Georgia's are not the same claim.
		expect(farmlandScope("Farmland of statewide importance")).toBe(FarmlandScope.State)
		expect(farmlandScope("Farmland of statewide importance, if drained")).toBe(FarmlandScope.State)
		expect(farmlandScope("Farmland of local importance")).toBe(FarmlandScope.Local)
	})

	it("reads a NULL and a not-prime value as stating no farmland importance, and they stay distinct upstream", () => {
		expect(farmlandScope(null)).toBe(FarmlandScope.None)
		expect(farmlandScope("Not prime farmland")).toBe(FarmlandScope.None)
	})
})

describe("soilLayerName", () => {
	it("carries the region in the name, because the declared extent is the set that was built", () => {
		expect(soilLayerName("IA")).toBe("soil-capability-nrcs-ssurgo-ia")
		expect(soilLayerName("ia153")).toBe("soil-capability-nrcs-ssurgo-ia153")
	})
})
