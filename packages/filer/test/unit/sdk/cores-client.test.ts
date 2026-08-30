/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the FCC CORES registration lookup.
 *
 *   Every fixture is a real `apps.fcc.gov/cores/searchDetail.do` response, retrieved 2026-08-07 and vendored
 *   verbatim. No test performs a live request: the parse tests drive {@linkcode parseCORESRegistration}
 *   directly, and the fetch tests pass a one-method stub satisfying {@link CORESDocumentClient}.
 */

import { readLocalTextFileSync } from "@mailwoman/core/fs/readers-sync"
import {
	coresDetailURL,
	fetchCORESRegistration,
	parseCORESRegistration,
	recaseUniform,
	type CORESDocumentClient,
} from "@mailwoman/filer/sdk/cores-client"
import { toFRN, type FRN } from "@mailwoman/filer/sdk/frn"
import { join } from "@mailwoman/platform/path"
import { describe, expect, it } from "vitest"

function fixture(name: string): string {
	return readLocalTextFileSync(join(import.meta.dirname, "../../../test-fixtures/cores", name))
}

const KNOLOGY_FRN = toFRN("0001753557")!
const COMCAST_FRN = toFRN("0003768165")!
const UNKNOWN_FRN = toFRN("0000000000")!

describe("parseCORESRegistration — real CORES detail pages", () => {
	it("reads every stated field off the Knology/WOW! record", () => {
		const registration = parseCORESRegistration(KNOLOGY_FRN, fixture("frn-0001753557-knology-wow.html"))

		expect(registration).toEqual({
			frn: KNOLOGY_FRN,
			entityName: "Knology Total Communications, Inc.",
			entityType: "Private Sector , Corporation",
			contactOrganization: "WOW! Internet, Cable and Phone",
			contactPosition: "Associate Counsel",
			contactName: "Adrianna Maciejewska",
			contactAddress: "6050 Knology Way Attn: Regulatory Columbus, GA 31909-4962 United States",
			contactEmail: "adrianna.maciejewska@wowinc.com",
			contactPhone: "(860) 543-4996",
			registrationDate: "06/24/2000 06:26:56 PM",
			lastUpdated: "04/27/2026 06:34:17 AM",
		})
	})

	it("keeps the legal name and the brand as SEPARATE surfaces — the reason this client exists", () => {
		const registration = parseCORESRegistration(KNOLOGY_FRN, fixture("frn-0001753557-knology-wow.html"))

		// One FRN, three spellings, no name-only join between them. Form 499 knows this carrier by neither.
		expect(registration?.entityName).toBe("Knology Total Communications, Inc.")
		expect(registration?.contactOrganization).toBe("WOW! Internet, Cable and Phone")
		expect(registration?.entityName).not.toBe(registration?.contactOrganization)
	})

	it("omits a field CORES left blank rather than emitting an empty string", () => {
		const registration = parseCORESRegistration(KNOLOGY_FRN, fixture("frn-0001753557-knology-wow.html"))

		// The record's Contact Fax row is present in the markup with an empty cell.
		expect(registration).not.toHaveProperty("contactFax")
	})

	it("reads the `ContactPhone:` label, which the page ships without its space", () => {
		expect(parseCORESRegistration(COMCAST_FRN, fixture("frn-0003768165-comcast.html"))?.contactPhone).toBe(
			"(215) 286-4040"
		)
	})

	it("leaves an already-mixed-case entity name alone and title-cases a uniformly-cased one", () => {
		const comcast = parseCORESRegistration(COMCAST_FRN, fixture("frn-0003768165-comcast.html"))

		// The source states "COMCAST CABLE COMMUNICATIONS, LLC" — uniformly cased, so it is tidied.
		expect(comcast?.entityName).toBe("Comcast Cable Communications, LLC")
		// Its contact organization is already mixed-case in the source and must survive untouched.
		expect(comcast?.contactOrganization).toBe("Comcast Cable Communications, LLC")
	})
})

describe("parseCORESRegistration — abstention", () => {
	it("returns null, never a stub record, for a page carrying no registration table", () => {
		expect(parseCORESRegistration(UNKNOWN_FRN, fixture("frn-0000000000-no-record.html"))).toBeNull()
	})

	it("returns null for empty input and for markup with no rows at all, and throws for neither", () => {
		expect(() => parseCORESRegistration(KNOLOGY_FRN, "")).not.toThrow()
		expect(parseCORESRegistration(KNOLOGY_FRN, "")).toBeNull()
		expect(parseCORESRegistration(KNOLOGY_FRN, "<html><body>nothing here</body></html>")).toBeNull()
	})

	it("REFUSES a page whose own FRN row disagrees with the FRN requested", () => {
		// The false-identity-link guard: a redirect or a mis-served cache entry would otherwise be
		// attributed to the FRN that was asked for.
		const otherFRN = toFRN("0009999999")!

		expect(parseCORESRegistration(otherFRN, fixture("frn-0001753557-knology-wow.html"))).toBeNull()
	})

	it("throws on a malformed FRN rather than requesting anything", async () => {
		const client: CORESDocumentClient = {
			getDocument: () => {
				throw new Error("must not be called")
			},
		}

		await expect(fetchCORESRegistration(client, "nope" as unknown as FRN)).rejects.toThrow(/invalid FRN/)
	})
})

describe("recaseUniform", () => {
	it("title-cases uniformly-cased text", () => {
		expect(recaseUniform("WINDSTREAM SERVICES LLC")).toBe("Windstream Services LLC")

		expect(recaseUniform("golden west telecommunications cooperative")).toBe(
			"Golden West Telecommunications Cooperative"
		)
	})

	it("leaves deliberately-cased text alone", () => {
		expect(recaseUniform("Lumen Technologies Inc.")).toBe("Lumen Technologies Inc.")
		expect(recaseUniform("WOW! Internet, Cable and Phone")).toBe("WOW! Internet, Cable and Phone")
		expect(recaseUniform("IDT Telecom, Inc.")).toBe("IDT Telecom, Inc.")
	})

	it("leaves anything carrying address/email/phone punctuation alone", () => {
		expect(recaseUniform("ADRIANNA@WOWINC.COM")).toBe("ADRIANNA@WOWINC.COM")
		expect(recaseUniform("(860) 543-4996")).toBe("(860) 543-4996")
		expect(recaseUniform("6050 KNOLOGY WAY ATTN: REGULATORY")).toBe("6050 KNOLOGY WAY ATTN: REGULATORY")
	})

	it("is a display tidy, NOT a matching normalizer — it does not fold designations", () => {
		expect(recaseUniform("ARVIG ENTERPRISES INC")).not.toBe(recaseUniform("Arvig Enterprises, Inc."))
	})

	it("keeps entity-form initialisms upper-case rather than title-casing them into nonsense", () => {
		expect(recaseUniform("SOUTHERN LIGHT LLC")).toBe("Southern Light LLC")
		expect(recaseUniform("HARGRAY COMMUNICATIONS GROUP LP")).toBe("Hargray Communications Group LP")
		// A trailing comma or period must not stop the token being recognized.
		expect(recaseUniform("ACME FIBER, LLC")).toBe("Acme Fiber, LLC")
		// Words that conventionally ARE title case stay title case.
		expect(recaseUniform("OTELCO TELEPHONE INC")).toBe("Otelco Telephone Inc")
	})
})

describe("fetchCORESRegistration", () => {
	it("requests the detail URL for the FRN and parses what comes back", async () => {
		const requested: string[] = []

		const client: CORESDocumentClient = {
			getDocument: (input) => {
				requested.push(String(input))

				return Promise.resolve(fixture("frn-0003768165-comcast.html"))
			},
		}

		const registration = await fetchCORESRegistration(client, COMCAST_FRN)

		expect(requested).toEqual(["https://apps.fcc.gov/cores/searchDetail.do?frn=0003768165"])
		expect(registration?.entityName).toBe("Comcast Cable Communications, LLC")
	})

	it("resolves to null — never throws — when CORES has no record", async () => {
		const client: CORESDocumentClient = {
			getDocument: () => Promise.resolve(fixture("frn-0000000000-no-record.html")),
		}

		await expect(fetchCORESRegistration(client, UNKNOWN_FRN)).resolves.toBeNull()
	})
})

describe("coresDetailURL", () => {
	it("builds a zero-padded detail URL on the allowed host", () => {
		expect(coresDetailURL(KNOLOGY_FRN)).toBe("https://apps.fcc.gov/cores/searchDetail.do?frn=0001753557")
	})
})
