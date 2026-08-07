/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for `edgar-filings.ts` — CIK resolution + 10-K discovery + Exhibit 21 document discovery.
 *
 *   No live network anywhere here: `fetchCompanyTickers`/`fetchTenKFilings`/`fetchExhibit21Documents` are
 *   exercised against hand-rolled stubs satisfying {@link SECGetClient}/{@link SECDocumentClient} (one method
 *   each), never a real `createSECClient()` or an axios harness. Everything else is a pure function over an
 *   authored fixture or `filer/test-fixtures/edgar/lumen-2025-index-headers.html` — a real, vendored EDGAR
 *   accession manifest (162 documents per its own `PUBLIC-DOCUMENT-COUNT` header field; this file's own SGML
 *   `&lt;DOCUMENT&gt;` block count is 161 — four sequence numbers, including 18, have no block of their own in
 *   this manifest, a real-EDGAR quirk this suite counts rather than papers over).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
	accessionArchiveURL,
	fetchCompanyTickers,
	fetchExhibit21Documents,
	fetchTenKFilings,
	findExhibit21Documents,
	isCIK,
	parseCompanyTickers,
	parseFilingDocuments,
	parseTenKFilings,
	resolveCIKCandidates,
	toCIK,
	type CIK,
	type CompanyTickerEntry,
	type SECGetClient,
} from "./edgar-filings.ts"
import type { SECDocumentClient } from "./exhibit21.ts"

describe("isCIK / toCIK", () => {
	it("accepts a zero-padded 10-digit string", () => {
		expect(isCIK("0000320193")).toBe(true)
	})

	it("rejects an unpadded or wrong-length string", () => {
		expect(isCIK("320193")).toBe(false)
		expect(isCIK("00003201930")).toBe(false)
	})

	it("zero-pads a bare number to the canonical form", () => {
		expect(toCIK(320_193)).toBe("0000320193")
	})

	it("zero-pads a bare unpadded string", () => {
		expect(toCIK("320193")).toBe("0000320193")
	})

	it("returns null (never throws) for a non-numeric or over-long value", () => {
		expect(toCIK("not-a-cik")).toBeNull()
		expect(toCIK("123456789012")).toBeNull()
	})
})

function tickerFile(entries: Array<{ cik: number; ticker: string; title: string }>): unknown {
	const rows: Record<string, unknown> = {}

	entries.forEach((entry, index) => {
		rows[String(index)] = { cik_str: entry.cik, ticker: entry.ticker, title: entry.title }
	})

	return rows
}

describe("parseCompanyTickers", () => {
	it("parses SEC's index-keyed object shape into zero-padded entries", () => {
		const raw = tickerFile([{ cik: 320_193, ticker: "AAPL", title: "Apple Inc." }])

		expect(parseCompanyTickers(raw)).toEqual([{ cik: "0000320193", ticker: "AAPL", title: "Apple Inc." }])
	})

	it("throws a descriptive error naming the row key on a malformed entry", () => {
		const raw = { "0": { cik_str: 320_193, ticker: "AAPL" } } // missing title

		expect(() => parseCompanyTickers(raw)).toThrow(/malformed row "0"/)
	})

	it("throws on a non-object payload", () => {
		expect(() => parseCompanyTickers(null)).toThrow(/malformed company_tickers\.json/)
		expect(() => parseCompanyTickers("oops")).toThrow(/malformed company_tickers\.json/)
	})
})

describe("fetchCompanyTickers", () => {
	it("fetches through the shared SEC client and validates the result", async () => {
		const client: SECGetClient = {
			get: async <T>() => tickerFile([{ cik: 789_019, ticker: "MSFT", title: "MICROSOFT CORP" }]) as T,
		}

		expect(await fetchCompanyTickers(client)).toEqual([{ cik: "0000789019", ticker: "MSFT", title: "MICROSOFT CORP" }])
	})
})

describe("resolveCIKCandidates — the no-name-only-match gate (load-bearing, 3a's false-identity-link lesson)", () => {
	const NAMESAKE_TICKERS: CompanyTickerEntry[] = [
		{ cik: toCIK("0001111111")!, ticker: "ABBD", title: "American Broadband LLC" },
		{ cik: toCIK("0002222222")!, ticker: "ABBI", title: "American Broadband, Inc." },
	]

	it("never silently narrows a genuine name tie to fewer candidates than `limit`", () => {
		const candidates = resolveCIKCandidates("American Broadband", NAMESAKE_TICKERS, { limit: 1 })

		expect(candidates).toHaveLength(2)
		expect(candidates.map((candidate) => candidate.cik).toSorted()).toEqual(["0001111111", "0002222222"])
		expect(candidates.every((candidate) => candidate.score === 1)).toBe(true)
	})

	it("reports the tie even with the default limit, each carrying its own score — never collapsed to one", () => {
		const candidates = resolveCIKCandidates("American Broadband, Inc.", NAMESAKE_TICKERS)

		expect(candidates).toHaveLength(2)

		for (const candidate of candidates) {
			expect(typeof candidate.score).toBe("number")
		}
	})

	it("reports ONE candidate for a registrant filed under several share classes", () => {
		// `company_tickers.json` carries one row per TICKER, so a registrant with several share
		// classes appears several times under one CIK. Measured 2026-08-03: "Liberty Broadband
		// Corporation" came back as the same CIK four times, each scoring 1.0.
		const shareClasses: CompanyTickerEntry[] = [
			{ cik: toCIK("0001611983")!, ticker: "LBRDA", title: "Liberty Broadband Corp" },
			{ cik: toCIK("0001611983")!, ticker: "LBRDB", title: "Liberty Broadband Corp" },
			{ cik: toCIK("0001611983")!, ticker: "LBRDK", title: "Liberty Broadband Corp" },
		]

		const candidates = resolveCIKCandidates("Liberty Broadband Corporation", shareClasses)

		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.cik).toBe("0001611983")
	})

	it("does not let share classes manufacture a tie that suppresses `limit`", () => {
		// The phantom tie is the actual damage: three rows at the top score made the tie rule fire,
		// so `limit` stopped trimming and a caller asking for one answer got the same CIK back three
		// times alongside nothing else.
		const tickers: CompanyTickerEntry[] = [
			{ cik: toCIK("0001611983")!, ticker: "LBRDA", title: "Liberty Broadband Corp" },
			{ cik: toCIK("0001611983")!, ticker: "LBRDK", title: "Liberty Broadband Corp" },
			{ cik: toCIK("0006666666")!, ticker: "LBDX", title: "Liberty Broadband Holdings" },
		]

		const candidates = resolveCIKCandidates("Liberty Broadband Corp", tickers, { limit: 1 })

		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.cik).toBe("0001611983")
	})

	it("keeps the highest-scoring row's spelling and ticker when collapsing share classes", () => {
		const mixed: CompanyTickerEntry[] = [
			{ cik: toCIK("0001611983")!, ticker: "LBRDA", title: "Liberty Broadband Holdings" },
			{ cik: toCIK("0001611983")!, ticker: "LBRDK", title: "Liberty Broadband Corporation" },
		]

		const candidates = resolveCIKCandidates("Liberty Broadband Corporation", mixed)

		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.companyName).toBe("Liberty Broadband Corporation")
		expect(candidates[0]?.ticker).toBe("LBRDK")
	})

	it("does NOT report a candidate that merely canonicalizes to a DIFFERENT string, however close", () => {
		const tickers: CompanyTickerEntry[] = [
			{ cik: toCIK("0003333333")!, ticker: "ACME", title: "Acme Corporation" },
			{ cik: toCIK("0004444444")!, ticker: "ZZZZ", title: "Zzyzx Unrelated Holdings" },
		]

		const candidates = resolveCIKCandidates("Acme Corp", tickers)

		expect(candidates.map((c) => c.cik)).toEqual(["0003333333"])
	})

	it("returns an empty array when nothing clears minScore", () => {
		const tickers: CompanyTickerEntry[] = [
			{ cik: toCIK("0005555555")!, ticker: "ZZZZ", title: "Zzyzx Unrelated Holdings" },
		]

		expect(resolveCIKCandidates("Totally Different Name Co", tickers)).toEqual([])
	})

	it("still returns a single, unambiguous candidate in the normal (non-colliding) case", () => {
		const tickers: CompanyTickerEntry[] = [
			{ cik: toCIK("0000320193")!, ticker: "AAPL", title: "Apple Inc." },
			{ cik: toCIK("0000789019")!, ticker: "MSFT", title: "MICROSOFT CORP" },
		]

		const candidates = resolveCIKCandidates("Apple Inc.", tickers)

		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.cik).toBe("0000320193")
	})

	it("`limit` still trims the low-scoring tail when there is no tie at the top", () => {
		const tickers: CompanyTickerEntry[] = [
			{ cik: toCIK("0000320193")!, ticker: "AAPL", title: "Apple Inc." },
			// Shares the "apple" token but is not the same canonical string, so it scores below the exact match
			// (but still above minScore) — a genuine ranking, not a tie, so `limit` may safely trim it.
			{ cik: toCIK("0000320194")!, ticker: "AAPQ", title: "Apple Group Holdings Inc" },
		]

		const candidates = resolveCIKCandidates("Apple Inc.", tickers, { limit: 1 })

		expect(candidates).toHaveLength(1)
		expect(candidates[0]?.cik).toBe("0000320193")
	})
})

function submissionsPayload(
	cik: number,
	rows: Array<{ form: string; accessionNumber: string; filingDate: string; primaryDocument: string }>
): unknown {
	return {
		cik: String(cik),
		filings: {
			recent: {
				form: rows.map((row) => row.form),
				accessionNumber: rows.map((row) => row.accessionNumber),
				filingDate: rows.map((row) => row.filingDate),
				primaryDocument: rows.map((row) => row.primaryDocument),
			},
		},
	}
}

describe("parseTenKFilings", () => {
	const CIK = toCIK(320_193)!

	it("keeps only form === 10-K rows, dropping 10-K/A and everything else", () => {
		const raw = submissionsPayload(320_193, [
			{ form: "10-K", accessionNumber: "0000320193-23-000106", filingDate: "2023-11-03", primaryDocument: "a.htm" },
			{ form: "8-K", accessionNumber: "0000320193-23-000050", filingDate: "2023-08-01", primaryDocument: "b.htm" },
			{ form: "10-K/A", accessionNumber: "0000320193-22-000010", filingDate: "2022-12-01", primaryDocument: "c.htm" },
		])

		expect(parseTenKFilings(CIK, raw)).toEqual([
			{ cik: CIK, accessionNumber: "0000320193-23-000106", filingDate: "2023-11-03", primaryDocument: "a.htm" },
		])
	})

	it("returns an empty array (not an error) for a registrant with no 10-K on file", () => {
		const raw = submissionsPayload(320_193, [
			{ form: "8-K", accessionNumber: "0000320193-23-000050", filingDate: "2023-08-01", primaryDocument: "b.htm" },
		])

		expect(parseTenKFilings(CIK, raw)).toEqual([])
	})

	it("throws a descriptive error naming the CIK when filings.recent is missing", () => {
		expect(() => parseTenKFilings(CIK, { filings: {} })).toThrow(/CIK 0000320193/)
		expect(() => parseTenKFilings(CIK, {})).toThrow(/missing filings\.recent\.form/)
	})

	it("throws when the parallel arrays disagree in length", () => {
		const raw = {
			filings: {
				recent: {
					form: ["10-K", "10-K"],
					accessionNumber: ["0000320193-23-000106"], // one short
					filingDate: ["2023-11-03", "2022-11-01"],
					primaryDocument: ["a.htm", "b.htm"],
				},
			},
		}

		expect(() => parseTenKFilings(CIK, raw)).toThrow(/not all the same length/)
	})
})

describe("fetchTenKFilings", () => {
	it("fetches the submissions payload for the given CIK and returns only its 10-Ks", async () => {
		const CIK = toCIK(789_019)!
		let requestedURL: string | URL | undefined

		const client: SECGetClient = {
			get: async <T>(url: string | URL) => {
				requestedURL = url

				return submissionsPayload(789_019, [
					{ form: "10-K", accessionNumber: "0000789019-24-000010", filingDate: "2024-07-30", primaryDocument: "x.htm" },
				]) as T
			},
		}

		const filings = await fetchTenKFilings(client, CIK)

		expect(requestedURL).toBe("https://data.sec.gov/submissions/CIK0000789019.json")

		expect(filings).toEqual([
			{ cik: CIK, accessionNumber: "0000789019-24-000010", filingDate: "2024-07-30", primaryDocument: "x.htm" },
		])
	})
})

describe("Exhibit 21 document discovery", () => {
	const headerHTML = readFileSync(
		join(import.meta.dirname, "..", "test-fixtures", "edgar", "lumen-2025-index-headers.html"),
		"utf8"
	)

	const LUMEN_CIK = "0000018926" as CIK

	it("builds an accession archive URL with an UNPADDED cik and an undashed accession", () => {
		expect(accessionArchiveURL(LUMEN_CIK, "0000018926-26-000014")).toBe(
			"https://www.sec.gov/Archives/edgar/data/18926/000001892626000014"
		)
	})

	it("finds exactly one EX-21 among the filing's real documents, with an absolute URL", () => {
		expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", headerHTML)).toEqual([
			{
				type: "EX-21",
				filename: "lumn20251231ex21.htm",
				url: "https://www.sec.gov/Archives/edgar/data/18926/000001892626000014/lumn20251231ex21.htm",
			},
		])
	})

	it("reads every document in the manifest, not only the exhibits", () => {
		const documents = parseFilingDocuments(LUMEN_CIK, "0000018926-26-000014", headerHTML)

		// The fixture's own SGML manifest carries 161 `<DOCUMENT>` blocks — see the module docstring above for
		// why this differs from the header's `PUBLIC-DOCUMENT-COUNT: 162`.
		expect(documents).toHaveLength(161)
		expect(documents[0]).toMatchObject({ type: "10-K", filename: "lumn-20251231.htm" })
	})

	it("accepts every EX-21 spelling EDGAR actually uses", () => {
		for (const type of ["EX-21", "EX-21.1", "EX-21.01", "ex-21.2"]) {
			const html = `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${type}\n&lt;FILENAME&gt;x.htm\n&lt;/DOCUMENT&gt;`

			expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toHaveLength(1)
		}
	})

	it("does NOT mistake EX-2, EX-210 or EX-23 for an Exhibit 21", () => {
		for (const type of ["EX-2", "EX-2.1", "EX-210", "EX-23", "EX-21A"]) {
			const html = `&lt;DOCUMENT&gt;\n&lt;TYPE&gt;${type}\n&lt;FILENAME&gt;x.htm\n&lt;/DOCUMENT&gt;`

			expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toEqual([])
		}
	})

	it("returns an empty array — never throws — for a filing whose manifest has no EX-21", () => {
		expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", "<html>no manifest here</html>")).toEqual([])
	})

	it("skips a block missing a FILENAME rather than emitting a URL ending in a slash", () => {
		const html = "&lt;DOCUMENT&gt;\n&lt;TYPE&gt;EX-21\n&lt;/DOCUMENT&gt;"

		expect(findExhibit21Documents(LUMEN_CIK, "0000018926-26-000014", html)).toEqual([])
	})

	describe("fetchExhibit21Documents", () => {
		it("fetches the accession's index-headers document through the shared client and finds the EX-21", async () => {
			let requestedURL: string | URL | undefined

			const client: SECDocumentClient = {
				getDocument: async (url) => {
					requestedURL = url

					return headerHTML
				},
			}

			const filing = {
				cik: LUMEN_CIK,
				accessionNumber: "0000018926-26-000014",
				filingDate: "2026-02-20",
				primaryDocument: "lumn-20251231.htm",
			}

			const documents = await fetchExhibit21Documents(client, filing)

			expect(requestedURL).toBe(
				"https://www.sec.gov/Archives/edgar/data/18926/000001892626000014/0000018926-26-000014-index-headers.html"
			)

			expect(documents).toEqual([
				{
					type: "EX-21",
					filename: "lumn20251231ex21.htm",
					url: "https://www.sec.gov/Archives/edgar/data/18926/000001892626000014/lumn20251231ex21.htm",
				},
			])
		})

		it("returns an empty array — never throws — when the filing's manifest has no EX-21", async () => {
			const client: SECDocumentClient = {
				getDocument: async () => "<html>no manifest here</html>",
			}

			const filing = {
				cik: LUMEN_CIK,
				accessionNumber: "0000018926-26-000014",
				filingDate: "2026-02-20",
				primaryDocument: "lumn-20251231.htm",
			}

			expect(await fetchExhibit21Documents(client, filing)).toEqual([])
		})
	})
})
