/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import {
	AU_DELIVERY_SERVICE_DESIGNATORS,
	isAuDeliveryService,
	matchAuDeliveryService,
	normalizeAuDeliveryService,
} from "./delivery-service.js"

describe("AU_DELIVERY_SERVICE_DESIGNATORS", () => {
	it("carries the verbatim AMAS table size and the documented no-number exceptions", () => {
		expect(AU_DELIVERY_SERVICE_DESIGNATORS).toHaveLength(14)
		const noNumber = AU_DELIVERY_SERVICE_DESIGNATORS.filter((d) => !d.requiresNumber).map((d) => d.name)
		// "With the exception of Care of Post Office, Community Mail Agent, Community Postal Agent,
		// and Community Mail Bag, all Postal Delivery Types must have an associated number."
		expect(noNumber.sort()).toEqual(
			["CARE OF POST OFFICE", "COMMUNITY MAIL AGENT", "COMMUNITY MAIL BAG", "COMMUNITY POSTAL AGENT", "POSTE RESTANTE"].sort()
		)
	})

	it("flags exactly the current retail products as non-legacy", () => {
		const current = [...new Set(AU_DELIVERY_SERVICE_DESIGNATORS.filter((d) => !d.legacy).map((d) => d.abbreviation))]
		expect(current.sort()).toEqual(["GPO BOX", "LOCKED BAG", "PO BOX", "PRIVATE BAG"].sort())
	})
})

describe("matchAuDeliveryService", () => {
	it("matches the current designators with ids", () => {
		expect(matchAuDeliveryService("GPO Box 2890")).toMatchObject({ designator: "GPO BOX", id: "2890", legacy: false })
		expect(matchAuDeliveryService("PO Box 112")).toMatchObject({ designator: "PO BOX", id: "112", legacy: false })
		expect(matchAuDeliveryService("Locked Bag 1797")).toMatchObject({
			designator: "LOCKED BAG",
			id: "1797",
			legacy: false,
		})
		expect(matchAuDeliveryService("Private Bag 7")).toMatchObject({ designator: "PRIVATE BAG", id: "7", legacy: false })
	})

	it("prefers GPO Box over PO Box and tolerates punctuation", () => {
		expect(matchAuDeliveryService("G.P.O. Box 9999")).toMatchObject({ designator: "GPO BOX", id: "9999" })
		expect(matchAuDeliveryService("P.O. Box 12-A")).toMatchObject({ designator: "PO BOX", id: "12-A" })
		expect(matchAuDeliveryService("General Post Office Box 123")).toMatchObject({ designator: "GPO BOX", id: "123" })
	})

	it("recognizes the legacy rural and community forms, flagged", () => {
		expect(matchAuDeliveryService("RMB 4600")).toMatchObject({ designator: "RMB", id: "4600", legacy: true })
		expect(matchAuDeliveryService("RSD 27")).toMatchObject({ designator: "RSD", id: "27", legacy: true })
		expect(matchAuDeliveryService("RMS 1605")).toMatchObject({ designator: "RMS", id: "1605", legacy: true })
		expect(matchAuDeliveryService("MS 1080")).toMatchObject({ designator: "MS", id: "1080", legacy: true })
		expect(matchAuDeliveryService("Roadside Mail Box 12")).toMatchObject({ designator: "RMB", id: "12" })
		expect(matchAuDeliveryService("Community Mail Bag 6")).toMatchObject({ designator: "CMB", id: "6" })
	})

	it("allows the documented no-number designators to stand bare", () => {
		expect(matchAuDeliveryService("CMB")).toMatchObject({ designator: "CMB", legacy: true })
		expect(matchAuDeliveryService("Care PO")).toMatchObject({ designator: "CARE PO" })
		expect(matchAuDeliveryService("Poste Restante")).toMatchObject({ designator: "CARE PO" })
		expect(matchAuDeliveryService("Community Postal Agent")).toMatchObject({ designator: "CPA" })
		expect(matchAuDeliveryService("CMB")?.id).toBeUndefined()
	})

	it("requires a number where the AMAS rule requires one", () => {
		expect(matchAuDeliveryService("Locked Bag")).toBeNull()
		expect(matchAuDeliveryService("GPO Box")).toBeNull()
		expect(matchAuDeliveryService("RSD")).toBeNull()
	})

	it("does not let the two-letter MS designator swallow an honorific", () => {
		expect(matchAuDeliveryService("Ms Smith")).toBeNull()
		expect(matchAuDeliveryService("MS 23B")).toMatchObject({ designator: "MS", id: "23B" })
	})

	it("rejects 'Private Box' — explicitly not a valid type per Australia Post", () => {
		expect(matchAuDeliveryService("Private Box 12")).toBeNull()
		expect(isAuDeliveryService("Private Box 12")).toBe(false)
	})

	it("rejects non-delivery-service strings", () => {
		expect(matchAuDeliveryService("54 Stockton Rd")).toBeNull()
		expect(matchAuDeliveryService("SYDNEY NSW 2000")).toBeNull()
		expect(matchAuDeliveryService(42)).toBeNull()
	})
})

describe("normalizeAuDeliveryService", () => {
	it("canonicalizes to the AMAS abbreviation", () => {
		expect(normalizeAuDeliveryService("g.p.o. box 123")).toBe("GPO BOX 123")
		expect(normalizeAuDeliveryService("Locked Mail Bag Service 60")).toBe("LOCKED BAG 60")
		expect(normalizeAuDeliveryService("Roadside Delivery 4")).toBe("RSD 4")
		expect(normalizeAuDeliveryService("Poste Restante")).toBe("CARE PO")
	})

	it("round-trips: every normalized form still matches", () => {
		for (const raw of ["GPO Box 2890", "Locked Bag 1797", "Private Bag 7", "RMB 4600", "CMB"]) {
			expect(isAuDeliveryService(normalizeAuDeliveryService(raw))).toBe(true)
		}
	})

	it("passes through non-matches unchanged", () => {
		expect(normalizeAuDeliveryService("Private Box 12")).toBe("Private Box 12")
	})
})
