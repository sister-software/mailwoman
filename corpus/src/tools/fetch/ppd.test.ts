import { describe, expect, it } from "vitest"

import { extractPPDTuples, type PPDExtractStats } from "./ppd.ts"

// PPD columns: id,price,date,postcode,type,new,tenure,PAON,SAON,street,locality,town,district,county,cat,status
const row = (
	over: Partial<Record<"postcode" | "paon" | "saon" | "street" | "locality" | "town" | "county", string>>
): string[] => {
	const base = {
		postcode: "SE19 3NF",
		paon: "14",
		saon: "",
		street: "BEULAH HILL",
		locality: "",
		town: "LONDON",
		county: "GREATER LONDON",
	}
	const r = { ...base, ...over }

	return [
		"{id}",
		"36995",
		"1995-03-24 00:00",
		r.postcode,
		"F",
		"N",
		"L",
		r.paon,
		r.saon,
		r.street,
		r.locality,
		"CROYDON",
		r.town,
		r.county,
		"A",
		"A",
	].map((v, i) => (i === 11 ? r.town : v)) // town sits at index 11; PPD district (index 12) is dropped by the extractor
}

async function run(rows: string[][]): Promise<{ lines: string[]; stats: PPDExtractStats }> {
	const lines: string[] = []
	const stats = await extractPPDTuples(rows, (line) => lines.push(line))

	return { lines, stats }
}

describe("extractPPDTuples", () => {
	it("emits an OA-shaped line with town→DISTRICT and county→REGION, title-cased", async () => {
		const { lines } = await run([row({})])
		expect(lines[0]).toBe("NUMBER,STREET,CITY,DISTRICT,REGION,POSTCODE")
		expect(lines[1]).toBe('14,"Beulah Hill",,"London","Greater London",SE19 3NF')
	})
	it("fills CITY only when locality differs from town", async () => {
		const { lines } = await run([
			row({ locality: "PLAISTOW", town: "BROMLEY" }),
			row({ locality: "LONDON", town: "LONDON" }),
		])
		expect(lines[1]).toBe('14,"Beulah Hill","Plaistow","Bromley","Greater London",SE19 3NF')
		expect(lines[2]).toBe('14,"Beulah Hill",,"London","Greater London",SE19 3NF')
	})
	it("skips SAON rows, name-PAON rows, and missing street/postcode, counting each", async () => {
		const { lines, stats } = await run([
			row({ saon: "FLAT 2" }),
			row({ paon: "CROWN POINT" }),
			row({ street: "" }),
			row({ postcode: "" }),
			row({}),
		])
		expect(lines).toHaveLength(2) // header + 1 kept
		expect(stats).toMatchObject({ kept: 1, skippedSAON: 1, skippedPAON: 1, skippedNoStreet: 1, skippedNoPostcode: 1 })
	})
	it("normalizes PAON ranges", async () => {
		const { lines } = await run([row({ paon: "4 - 6" })])
		expect(lines[1]!.startsWith("4-6,")).toBe(true)
	})
})
