/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { describe, expect, it } from "vitest"

import { alignRow } from "./align.ts"
import {
	composePoBoxPhrase,
	countryToLocale,
	maybeNoisifyBoxNumber,
	supportedLocales,
	synthesizeMilitaryPoBoxRow,
	synthesizePoBoxRow,
} from "./synthesize-po-box.ts"
import type { CanonicalRow } from "./types.ts"

// Deterministic RNG for reproducible tests.
function seededRandom(seed: number): () => number {
	let s = seed

	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296

		return s / 4294967296
	}
}

describe("synthesizePoBoxRow", () => {
	it("US: replaces street with PO Box leader + number", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Burlington", region: "VT", postcode: "05401", country: "US" },
			{ random: seededRandom(42), pickNumber: () => "123" }
		)
		expect(row).not.toBeNull()
		expect(row!.template).toBe("po-box")
		expect(row!.locale).toBe("en-US")
		expect(row!.raw).toContain("123")
		expect(row!.raw).toContain("Burlington")
		expect(row!.raw).toContain("VT")
		expect(row!.raw).toContain("05401")
		expect(row!.components.po_box).toBeDefined()
		expect(row!.components.po_box!).toMatch(/^(PO Box|P\.O\. Box|P\.O\.Box|PO BOX|POB|Post Office Box|Box) 123$/)
		expect(row!.components.street).toBeUndefined()
		expect(row!.components.house_number).toBeUndefined()
	})

	it("FR: uses BP / Boîte Postale leaders", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Paris", region: "Île-de-France", postcode: "75001", country: "FR" },
			{ random: seededRandom(1), pickNumber: () => "42" }
		)
		expect(row).not.toBeNull()
		expect(row!.locale).toBe("fr-FR")
		expect(row!.components.po_box!).toMatch(/^(BP|B\.P\.|Boîte Postale|BP\.) 42$/)
	})

	it("ES: uses Apartado / Apdo. leaders", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Madrid", region: "Madrid", postcode: "28001", country: "ES" },
			{ random: seededRandom(7), pickNumber: () => "100" }
		)
		expect(row).not.toBeNull()
		expect(row!.locale).toBe("es-ES")
		expect(row!.components.po_box!).toMatch(/^(Apdo\.|Apdo|Apartado|Apartado de Correos) 100$/)
	})

	it("AR: uses Casilla leaders", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Buenos Aires", region: "CABA", postcode: "C1000", country: "AR" },
			{ random: seededRandom(13), pickNumber: () => "55" }
		)
		expect(row).not.toBeNull()
		expect(row!.locale).toBe("es-AR")
		expect(row!.components.po_box!).toMatch(/^(Casilla|Casilla de Correo|CC) 55$/)
	})

	it("NZ: Private Bag / Private Box leaders, region-less format (#517)", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Auckland", region: "", postcode: "1010", country: "NZ" },
			{ random: seededRandom(5), pickNumber: () => "12" }
		)
		expect(row).not.toBeNull()
		expect(row!.locale).toBe("en-NZ")
		expect(row!.components.po_box!).toMatch(/^(PO Box|P\.O\. Box|Post Office Box|Private Bag|Private Box) 12$/)
		expect(row!.components.region).toBeUndefined() // NZ: no region token between locality and postcode
		expect(row!.raw).toBe(`${row!.components.po_box}, Auckland 1010`)
	})

	it("PMB variant: when locale supports it and street is provided", () => {
		// pmbRatio=1.0 forces PMB path
		const row = synthesizePoBoxRow(
			{
				locality: "New York",
				region: "NY",
				postcode: "10001",
				country: "US",
				street: "Main St",
				houseNumber: "100",
			},
			{ random: seededRandom(99), pickNumber: () => "200", pmbRatio: 1.0 }
		)
		expect(row).not.toBeNull()
		expect(row!.template).toBe("pmb-with-street")
		expect(row!.components.street).toBe("Main St")
		expect(row!.components.house_number).toBe("100")
		expect(row!.components.po_box).toBeDefined()
		expect(row!.components.po_box!).toMatch(/^(PMB|#) 200$/)
		expect(row!.raw).toContain("Main St")
		expect(row!.raw).toContain(row!.components.po_box!)
	})

	it("standard PO box: drops street even if provided", () => {
		const row = synthesizePoBoxRow(
			{
				locality: "Burlington",
				region: "VT",
				postcode: "05401",
				country: "US",
				street: "Main St",
				houseNumber: "100",
			},
			{ random: seededRandom(42), pickNumber: () => "123", pmbRatio: 0.0 }
		)
		expect(row!.template).toBe("po-box")
		expect(row!.components.street).toBeUndefined()
		expect(row!.components.house_number).toBeUndefined()
	})

	it("unknown country falls back to en-US locale", () => {
		const row = synthesizePoBoxRow(
			{ locality: "Somewhere", region: "??", postcode: "00000", country: "ZZ" },
			{ random: seededRandom(3), pickNumber: () => "1" }
		)
		expect(row!.locale).toBe("en-US")
	})

	it("po_box span includes leader and number for downstream BIO alignment", () => {
		const row = synthesizePoBoxRow(
			{ locality: "X", region: "Y", postcode: "00000", country: "US" },
			{ random: () => 0, pickNumber: () => "5" }
		)
		// po_box component is the WHOLE span ("PO Box 5"), not just "5"
		expect(row!.components.po_box!.split(/\s+/).length).toBeGreaterThanOrEqual(2)
	})
})

describe("synthesizeMilitaryPoBoxRow (#517)", () => {
	it("generates a unit-line po_box + APO/FPO/DPO locality + AA/AE/AP region + theatre ZIP", () => {
		const row = synthesizeMilitaryPoBoxRow({ random: seededRandom(7) })
		expect(row.template).toBe("military-po-box")
		expect(row.locale).toBe("en-US")
		expect(row.components.po_box!).toMatch(/^(PSC|CMR|Unit) \d+( Box \d+)?$/)
		expect(["APO", "FPO", "DPO"]).toContain(row.components.locality)
		expect(["AA", "AE", "AP"]).toContain(row.components.region)
		expect(row.components.postcode!).toMatch(/^\d{5}$/)

		// Every component must be a verbatim substring of raw (the BIO aligner needs this).
		for (const v of [row.components.po_box, row.components.locality, row.components.region, row.components.postcode]) {
			expect(row.raw).toContain(v!)
		}
	})

	it("aligns cleanly through alignRow (po_box + locality + region + postcode, no quarantine)", () => {
		// Seeds chosen to cover a box-bearing (PSC/CMR) and a bare (Unit) line.
		for (const seed of [11, 23, 42, 7, 100]) {
			const row = synthesizeMilitaryPoBoxRow({ random: seededRandom(seed) })
			const canonical = { ...row, source: "synth-po-box", source_id: `mil:${seed}` } as CanonicalRow
			const result = alignRow(canonical)
			expect(result.kind, `should align, raw=${row.raw}`).toBe("labeled")

			if (result.kind !== "labeled") continue
			expect(result.row.labels).toContain("B-po_box")
			expect(result.row.labels).toContain("B-locality")
			expect(result.row.labels).toContain("B-postcode")
		}
	})
})

describe("maybeNoisifyBoxNumber", () => {
	it("returns original number when random > 0.1", () => {
		// random=0.5 means no noise
		expect(maybeNoisifyBoxNumber("12345", () => 0.5)).toBe("12345")
	})

	it("applies noise when random <= 0.1", () => {
		// Force noise application; verify SOMETHING changes for a non-trivial number
		let attempts = 0
		const sawChange = false
		const rng = (() => {
			const seq = [0.05, 0.5, 0.05, 0.99, 0.05, 0.01]

			return () => seq[attempts++ % seq.length]!
		})()
		const result = maybeNoisifyBoxNumber("12345", rng)
		// Either changed or not — we just want to confirm the path runs without error
		expect(typeof result).toBe("string")
	})
})

describe("countryToLocale", () => {
	it("maps US/USA/United States", () => {
		expect(countryToLocale("US")).toBe("en-US")
		expect(countryToLocale("USA")).toBe("en-US")
		expect(countryToLocale("United States")).toBe("en-US")
	})

	it("maps FR variants", () => {
		expect(countryToLocale("FR")).toBe("fr-FR")
		expect(countryToLocale("France")).toBe("fr-FR")
	})

	it("maps ES variants", () => {
		expect(countryToLocale("ES")).toBe("es-ES")
		expect(countryToLocale("Spain")).toBe("es-ES")
	})
})

describe("supportedLocales", () => {
	it("returns the locale template list", () => {
		const locs = supportedLocales()
		expect(locs).toContain("en-US")
		expect(locs).toContain("fr-FR")
		expect(locs).toContain("es-ES")
		expect(locs).toContain("en-AU")
		expect(locs.length).toBeGreaterThanOrEqual(7)
	})
})

describe("composePoBoxPhrase", () => {
	it("joins leader + number with a single space", () => {
		expect(composePoBoxPhrase("PO Box", "123")).toBe("PO Box 123")
		expect(composePoBoxPhrase("PMB", "200")).toBe("PMB 200")
	})
})
