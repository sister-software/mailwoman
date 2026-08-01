/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for `edgar-filings.ts` (3b Task 6) — CIK resolution + 10-K discovery.
 *
 *   No live network anywhere here: `fetchCompanyTickers`/`fetchTenKFilings` are exercised against a
 *   hand-rolled stub satisfying {@link SECGetClient} (one method, `get<T>`), never a real `createSECClient()`
 *   or an axios harness. Everything else is a pure function over an authored fixture.
 */

import { describe, expect, it } from "vitest"

import {
	fetchCompanyTickers,
	fetchTenKFilings,
	isCIK,
	parseCompanyTickers,
	parseTenKFilings,
	resolveCIKCandidates,
	toCIK,
	type CompanyTickerEntry,
	type SECGetClient,
} from "./edgar-filings.ts"

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
