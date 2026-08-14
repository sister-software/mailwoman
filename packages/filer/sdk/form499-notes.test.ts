/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the Form 499 lifecycle-note parser.
 *
 *   Every note string below is quoted VERBATIM from the 2025-12-07 vintage, including the source's own
 *   `accout` typo. The counts in the shape-coverage test are the measured counts from that file.
 */

import { describe, expect, it } from "vitest"

import { Form499CessationReason, isCeasedFiler, parseForm499Notes } from "./form499-notes.ts"

describe("parseForm499Notes — the eight templates", () => {
	it("reads a cessation date into an ISO `valid_to` candidate", () => {
		const lifecycle = parseForm499Notes(["No longer active as of 9/8/2013"])

		// M/D/YYYY sorts wrong as a string and fails assertISODate — the whole reason this converts.
		expect(lifecycle.ceasedAt).toBe("2013-09-08")
		expect(lifecycle.reasons).toEqual([Form499CessationReason.NoLongerActive])
	})

	it("zero-pads a single-digit month and day", () => {
		expect(parseForm499Notes(["No longer active as of 1/2/2004"]).ceasedAt).toBe("2004-01-02")
		expect(parseForm499Notes(["No longer active as of 12/31/2018"]).ceasedAt).toBe("2018-12-31")
	})

	it("reads a supersession edge", () => {
		const lifecycle = parseForm499Notes(["Replaced by filer 821002"])

		expect(lifecycle.replacedByForm499ID).toBe("821002")
		expect(lifecycle.reasons).toEqual([Form499CessationReason.ReplacedByFiler])
	})

	it.each([
		[
			"This company still exists, however it is no longer providing telecommunications services.",
			Form499CessationReason.ExitedTelecom,
		],
		[
			"This company has gone out of business in its entirety (no sale of assets involved).",
			Form499CessationReason.OutOfBusiness,
		],
		["All assets of this company have been sold to another party.", Form499CessationReason.AssetsSold],
		[
			"This legal entity accout has been closed because their Form 499 filing is now submitted on a consolidated basis.",
			Form499CessationReason.AccountConsolidated,
		],
		["This company has been absorbed by another filing entity.", Form499CessationReason.AbsorbedByFiler],
		["This company has filed for Chapter 7 bankruptcy protection.", Form499CessationReason.Bankruptcy],
	])("recognizes %s", (note, reason) => {
		const lifecycle = parseForm499Notes([note])

		expect(lifecycle.reasons).toEqual([reason])
		expect(lifecycle.unrecognized).toBe(0)
	})

	it("reads all three cells of a real ceased row together", () => {
		const lifecycle = parseForm499Notes([
			"No longer active as of 9/8/2013",
			"All assets of this company have been sold to another party.",
			"Replaced by filer 821002",
		])

		expect(lifecycle).toEqual({
			notes: [
				"No longer active as of 9/8/2013",
				"All assets of this company have been sold to another party.",
				"Replaced by filer 821002",
			],
			ceasedAt: "2013-09-08",
			replacedByForm499ID: "821002",
			reasons: [
				Form499CessationReason.NoLongerActive,
				Form499CessationReason.AssetsSold,
				Form499CessationReason.ReplacedByFiler,
			],
			unrecognized: 0,
		})
	})
})

describe("parseForm499Notes — never infers", () => {
	it("keeps every note verbatim, so a reason code is never the only record of what the FCC said", () => {
		const note = "This company has filed for Chapter 11 bankruptcy protection."

		expect(parseForm499Notes([note]).notes).toEqual([note])
	})

	it("counts an unrecognized note instead of guessing a reason for it", () => {
		const lifecycle = parseForm499Notes(["Some future template the FCC has not written yet."])

		expect(lifecycle.reasons).toEqual([])
		expect(lifecycle.unrecognized).toBe(1)
		expect(lifecycle.notes).toEqual(["Some future template the FCC has not written yet."])
	})

	it("does NOT keyword-sniff — a sentence merely containing a template's words is unrecognized", () => {
		const lifecycle = parseForm499Notes([
			"This company sold assets to another party and may have gone out of business.",
		])

		expect(lifecycle.reasons).toEqual([])
		expect(lifecycle.unrecognized).toBe(1)
	})

	it("treats a corrected `account` spelling as unrecognized rather than absorbing the change silently", () => {
		// The source's typo is `accout`. A vintage that fixes it must surface as a rising unrecognized
		// count, which is how anyone would ever notice the template changed.
		const lifecycle = parseForm499Notes([
			"This legal entity account has been closed because their Form 499 filing is now submitted on a consolidated basis.",
		])

		expect(lifecycle.unrecognized).toBe(1)
		expect(lifecycle.reasons).toEqual([])
	})

	it("skips blank, null and undefined cells without counting them", () => {
		const lifecycle = parseForm499Notes(["", null, undefined, "   "])

		expect(lifecycle).toEqual({ notes: [], reasons: [], unrecognized: 0 })
	})

	it("never throws, whatever it is handed", () => {
		expect(() => parseForm499Notes([])).not.toThrow()
		expect(() => parseForm499Notes(["No longer active as of not-a-date"])).not.toThrow()
		expect(parseForm499Notes(["No longer active as of not-a-date"]).unrecognized).toBe(1)
	})

	it("deduplicates a reason stated twice", () => {
		const note = "This company has been absorbed by another filing entity."

		expect(parseForm499Notes([note, note]).reasons).toEqual([Form499CessationReason.AbsorbedByFiler])
	})
})

describe("isCeasedFiler", () => {
	it("is true for a dated cessation, a wind-up, an absorption or a replacement", () => {
		expect(isCeasedFiler(parseForm499Notes(["No longer active as of 9/8/2013"]))).toBe(true)

		expect(
			isCeasedFiler(
				parseForm499Notes(["This company has gone out of business in its entirety (no sale of assets involved)."])
			)
		).toBe(true)

		expect(isCeasedFiler(parseForm499Notes(["This company has been absorbed by another filing entity."]))).toBe(true)
		expect(isCeasedFiler(parseForm499Notes(["Replaced by filer 821002"]))).toBe(true)
	})

	it("is FALSE for a company that still exists but left telecom", () => {
		// 2,981 rows say this. Reading it as "gone" would erase a live company that can still be a parent.
		expect(
			isCeasedFiler(
				parseForm499Notes(["This company still exists, however it is no longer providing telecommunications services."])
			)
		).toBe(false)
	})

	it("is FALSE for a filing consolidated under a parent — the entity did not cease", () => {
		expect(
			isCeasedFiler(
				parseForm499Notes([
					"This legal entity accout has been closed because their Form 499 filing is now submitted on a consolidated basis.",
				])
			)
		).toBe(false)
	})

	it("is FALSE for bankruptcy alone — a Chapter 11 filer is reorganizing, not gone", () => {
		expect(isCeasedFiler(parseForm499Notes(["This company has filed for Chapter 11 bankruptcy protection."]))).toBe(
			false
		)
	})

	it("is false for a filer with no notes at all", () => {
		expect(isCeasedFiler(parseForm499Notes([]))).toBe(false)
	})
})
