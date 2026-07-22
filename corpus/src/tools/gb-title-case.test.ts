import { describe, expect, it } from "vitest"

import { titleCaseGB } from "./gb-title-case.ts"

describe("titleCaseGB", () => {
	it("title-cases plain ALL-CAPS words", () => {
		expect(titleCaseGB("BEULAH HILL")).toBe("Beulah Hill")
		expect(titleCaseGB("GREATER LONDON")).toBe("Greater London")
	})
	it("lowercases linking particles except at start", () => {
		expect(titleCaseGB("BARROW UPON SOAR")).toBe("Barrow upon Soar")
		expect(titleCaseGB("WELLS NEXT THE SEA")).toBe("Wells next the Sea")
		expect(titleCaseGB("THE GREEN")).toBe("The Green")
	})
	it("handles hyphenated names with particles", () => {
		expect(titleCaseGB("STRATFORD-UPON-AVON")).toBe("Stratford-upon-Avon")
		expect(titleCaseGB("WESTON-SUPER-MARE")).toBe("Weston-super-Mare")
	})
	it("keeps letters after apostrophes lowercase", () => {
		expect(titleCaseGB("BISHOP'S STORTFORD")).toBe("Bishop's Stortford")
		expect(titleCaseGB("ST JOHN'S WOOD")).toBe("St John's Wood")
	})
	it("passes through empty and already-mixed strings by re-casing", () => {
		expect(titleCaseGB("")).toBe("")
		expect(titleCaseGB("London")).toBe("London")
	})
	it("capitalizes apostrophe-name segments but not possessive 's", () => {
		expect(titleCaseGB("TOLLESHUNT D'ARCY")).toBe("Tolleshunt D'Arcy")
		expect(titleCaseGB("STOKE D'ABERNON")).toBe("Stoke D'Abernon")
		expect(titleCaseGB("BISHOP'S STORTFORD")).toBe("Bishop's Stortford")
	})
	it("trims leading whitespace without breaking first-word capitalization", () => {
		expect(titleCaseGB(" DE MONTFORT")).toBe("De Montfort")
	})
})
