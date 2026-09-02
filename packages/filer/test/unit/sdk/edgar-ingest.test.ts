/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests for the assembled EDGAR chain.
 *
 *   The Exhibit 21 documents are real vendored filings; the submissions payloads are minimal stubs carrying
 *   only what this module reads. No test performs a live request — the client is an object literal
 *   satisfying {@link SECIngestClient}.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { toCIK, type CompanyTickerEntry } from "@mailwoman/filer/sdk/edgar-filings"
import { collectEdgarSubsidiaryRows, EdgarSkipReason, type SECIngestClient } from "@mailwoman/filer/sdk/edgar-ingest"
import { describe, expect, it } from "vitest"

const CABLE_ONE = toCIK("0001632127")!
const WIDEPOINT = toCIK("0001034760")!

const TICKERS: CompanyTickerEntry[] = [
	{ cik: CABLE_ONE, ticker: "CABO", title: "Cable One, Inc." },
	{ cik: WIDEPOINT, ticker: "WYY", title: "WidePoint Corp" },
]

async function exhibit(name: string): Promise<string> {
	return await readLocalTextFile(resolvePackagePath("@mailwoman/filer", "test-fixtures", "edgar", name))
}

const CABLE_ONE_HEADERS = `
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-21.1
&lt;FILENAME&gt;a2025q4-exhibit211.htm
&lt;/DOCUMENT&gt;`

/**
 * Build a client over a per-registrant script: SIC, whether it has a 10-K, and which exhibit fixture to serve.
 */
async function stubClient(
	script: Record<
		string,
		{ sic?: string; name: string; tenK?: boolean; headers?: string; exhibit?: string; cikPath?: string }
	>
): Promise<SECIngestClient> {
	return {
		get: <T>(input: string | URL): Promise<T> => {
			const cik = /CIK(\d{10})\.json/.exec(String(input))?.[1] ?? ""
			const entry = script[cik]

			if (!entry) throw new Error(`unscripted submissions request: ${String(input)}`)

			const recent =
				entry.tenK === false
					? { form: [], accessionNumber: [], filingDate: [], primaryDocument: [] }
					: {
							form: ["10-K"],
							accessionNumber: ["0001632127-26-000005"],
							filingDate: ["2026-02-26"],
							primaryDocument: ["x.htm"],
						}

			return Promise.resolve({ sic: entry.sic, name: entry.name, filings: { recent } } as T)
		},
		getDocument: (input: string | URL): Promise<string> => {
			const url = String(input)
			// The URL's filename comes from the scripted document manifest, not from the fixture name, so
			// match on the CIK in the archive path instead.
			const bare = /edgar\/data\/(\d+)\//.exec(url)?.[1] ?? ""
			const entry = Object.values(script).find((candidate) => candidate.cikPath === bare) ?? Object.values(script)[0]

			if (url.includes("index-headers")) return Promise.resolve(entry?.headers ?? "")

			return entry?.exhibit ? exhibit(entry.exhibit) : Promise.resolve("")
		},
	}
}

describe("collectEdgarSubsidiaryRows — the happy path", () => {
	it("produces EdgarSubsidiaryRows from a real Exhibit 21", async () => {
		const client = await stubClient({
			"0001632127": {
				cikPath: "1632127",
				sic: "4841",
				name: "Cable One, Inc.",
				headers: CABLE_ONE_HEADERS,
				exhibit: "cable-one-2025.htm",
			},
		})

		const { rows, report } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc."], TICKERS)

		expect(rows).toHaveLength(16)

		expect(rows[0]).toEqual({
			cik: CABLE_ONE,
			subsidiaryName: "Bluffton Telephone Company, LLC",
			jurisdiction: "South Carolina",
			filingDate: "2026-02-26",
		})

		expect(report.registrantsWithRows).toBe(1)
		expect(report.outcomes[0]).toMatchObject({ cik: CABLE_ONE, sic: "4841", subsidiaries: 16 })
	})

	it("stamps the FILING date on every row, not the run date", async () => {
		const client = await stubClient({
			"0001632127": {
				cikPath: "1632127",
				sic: "4841",
				name: "Cable One, Inc.",
				headers: CABLE_ONE_HEADERS,
				exhibit: "cable-one-2025.htm",
			},
		})

		const { rows } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc."], TICKERS)

		expect(rows.every((row) => row.filingDate === "2026-02-26")).toBe(true)
	})
})

describe("collectEdgarSubsidiaryRows — the gate cannot be bypassed", () => {
	it("drops a registrant SEC files outside the telecom range, however good the name score", async () => {
		// This is the WideOpenWest -> WidePoint false match, at 0.886. Without the check it writes 9 rows.
		const client = await stubClient({
			"0001034760": {
				cikPath: "1034760",
				sic: "7373",
				name: "WidePoint Corp",
				headers: CABLE_ONE_HEADERS,
				exhibit: "widepoint-2025.htm",
			},
		})

		const { rows, report } = await collectEdgarSubsidiaryRows(client, ["WidePoint Corp"], TICKERS)

		expect(rows).toHaveLength(0)
		expect(report.skipped[EdgarSkipReason.Uncorroborated]).toBe(1)
	})

	it("admits that same registrant once an operator pins it", async () => {
		const client = await stubClient({
			"0001034760": {
				cikPath: "1034760",
				sic: "7373",
				name: "WidePoint Corp",
				headers: CABLE_ONE_HEADERS,
				exhibit: "widepoint-2025.htm",
			},
		})

		const { rows } = await collectEdgarSubsidiaryRows(client, ["WidePoint Corp"], TICKERS, {
			pinnedCIKs: new Set([WIDEPOINT]),
		})

		expect(rows.length).toBeGreaterThan(0)
	})

	it("corroborates every candidate, not only the top-scoring one", async () => {
		// The top name match is uncorroborated; a lower-scoring candidate is the real carrier. Scoring
		// alone would stop at the first and report nothing.
		const tickers: CompanyTickerEntry[] = [
			{ cik: WIDEPOINT, ticker: "WYY", title: "Cable One Holdings" },
			{ cik: CABLE_ONE, ticker: "CABO", title: "Cable One, Inc." },
		]

		const client = await stubClient({
			"0001034760": { cikPath: "1034760", sic: "7373", name: "WidePoint Corp" },
			"0001632127": {
				cikPath: "1632127",
				sic: "4841",
				name: "Cable One, Inc.",
				headers: CABLE_ONE_HEADERS,
				exhibit: "cable-one-2025.htm",
			},
		})

		const { report } = await collectEdgarSubsidiaryRows(client, ["Cable One"], tickers)

		expect(report.outcomes[0]?.cik).toBe(CABLE_ONE)
	})

	it("ABSTAINS when two different corroborated CIKs both survive", async () => {
		const tickers: CompanyTickerEntry[] = [
			{ cik: CABLE_ONE, ticker: "CABO", title: "American Broadband, Inc." },
			{ cik: WIDEPOINT, ticker: "WYY", title: "American Broadband LLC" },
		]

		const client = await stubClient({
			"0001632127": { cikPath: "1632127", sic: "4841", name: "American Broadband, Inc." },
			"0001034760": { cikPath: "1034760", sic: "4813", name: "American Broadband LLC" },
		})

		const { rows, report } = await collectEdgarSubsidiaryRows(client, ["American Broadband"], tickers)

		// Picking one here would relocate the false-identity-link decision, not avoid it.
		expect(rows).toHaveLength(0)
		expect(report.skipped[EdgarSkipReason.AmbiguousCIK]).toBe(1)
	})
})

describe("collectEdgarSubsidiaryRows — every drop is counted", () => {
	it("records an unresolvable name", async () => {
		const { report } = await collectEdgarSubsidiaryRows(await stubClient({}), ["Zzyzx Unrelated Holdings"], TICKERS)

		expect(report.skipped[EdgarSkipReason.Unresolved]).toBe(1)
		expect(report.outcomes[0]).toMatchObject({ query: "Zzyzx Unrelated Holdings", subsidiaries: 0 })
	})

	it("records a registrant with no 10-K", async () => {
		const client = await stubClient({
			"0001632127": { cikPath: "1632127", sic: "4841", name: "Cable One, Inc.", tenK: false },
		})

		const { report } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc."], TICKERS)

		expect(report.skipped[EdgarSkipReason.NoTenK]).toBe(1)
	})

	it("records a 10-K carrying no Exhibit 21 — a filer's choice, not a failure", async () => {
		const client = await stubClient({
			"0001632127": { cikPath: "1632127", sic: "4841", name: "Cable One, Inc.", headers: "<html>none</html>" },
		})

		const { report } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc."], TICKERS)

		expect(report.skipped[EdgarSkipReason.NoExhibit21]).toBe(1)
	})

	it("emits an outcome for EVERY query, including the ones that worked", async () => {
		const client = await stubClient({
			"0001632127": {
				cikPath: "1632127",
				sic: "4841",
				name: "Cable One, Inc.",
				headers: CABLE_ONE_HEADERS,
				exhibit: "cable-one-2025.htm",
			},
		})

		const seen: string[] = []

		const { report } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc.", "Zzyzx Unrelated"], TICKERS, {
			onOutcome: (outcome) => seen.push(outcome.query),
		})

		expect(report.outcomes).toHaveLength(2)
		expect(seen).toEqual(["Cable One, Inc.", "Zzyzx Unrelated"])
	})

	it("carries the parser's abstention count so an unhandled layout is visible", async () => {
		const client = await stubClient({
			"0001632127": {
				cikPath: "1632127",
				sic: "4841",
				name: "Cable One, Inc.",
				headers: CABLE_ONE_HEADERS,
				exhibit: "cable-one-2025.htm",
			},
		})

		const { report } = await collectEdgarSubsidiaryRows(client, ["Cable One, Inc."], TICKERS)

		expect(report.outcomes[0]?.unparseable).toBeGreaterThan(0)
	})
})
