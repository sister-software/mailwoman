/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SEC EDGAR company→CIK resolution + 10-K filing discovery (3b Task 6).
 *
 *   Two public EDGAR endpoints, reached through the existing {@linkcode SECClient} (never a second
 *   fetcher — see `sec-client.ts`):
 *
 *   1. `https://www.sec.gov/files/company_tickers.json` — a flat, whole-file map of every registrant SEC
 *      tracks a ticker for (`{cik_str, ticker, title}` per row). {@linkcode resolveCIKCandidates} matches a
 *      company NAME against this list.
 *   2. `https://data.sec.gov/submissions/CIK##########.json` — one registrant's full filing history.
 *      {@linkcode fetchTenKFilings} reads it and keeps only `form === "10-K"` rows (10-K/A amendments are
 *      deliberately excluded — a distinct filing this task doesn't need, not an oversight).
 *
 *   **Name→CIK matching is NOT name-only, and this is the load-bearing rule in this file (3a's
 *   false-identity-link lesson, carried forward).** `cluster-filers.ts`'s own review history found that
 *   "American Broadband LLC" and "American Broadband, Inc." — two DIFFERENT companies — canonicalize to the
 *   exact same string once legal designations are stripped, and a matcher that silently picks "the best
 *   name match" would merge them under one CIK. `resolveCIKCandidates` therefore never returns a single
 *   winner: it returns every candidate that clears {@link ResolveCIKOptions.minScore}, each carrying its own
 *   `score`, and — the part that actually enforces this — a genuine TIE for the top score is NEVER silently
 *   narrowed to fewer than `limit` (see {@linkcode resolveCIKCandidates}'s own docstring). Deciding which
 *   candidate (if any) is authoritative is explicitly deferred to Task 8, which has other corroborating
 *   evidence (an existing FRN's legal name) this module does not.
 *
 *   No live network in the test suite: every test either drives {@linkcode parseCompanyTickers}/
 *   {@linkcode parseTenKFilings}/{@linkcode resolveCIKCandidates} directly (pure functions) or passes a
 *   hand-rolled stub satisfying {@link SECGetClient} — the one method (`get<T>`) this module actually calls
 *   on the shared SEC client, so a test never has to build a full axios harness just to exercise this file.
 */

import { nameSimilarity } from "@mailwoman/match"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import type { Tagged } from "type-fest"

/**
 * SEC EDGAR's Central Index Key: always a zero-padded 10-digit string. Branded over `string`, mirroring
 * {@linkcode FRN}'s (`frn.ts`) identical rationale — a bare, unpadded numeric CIK would collide with itself under a
 * naive string comparison once padding is inconsistently applied.
 */
export type CIK = Tagged<string, "CIK">

const CIK_PATTERN = /^\d{10}$/

/**
 * Predicate for a valid {@link CIK}: exactly 10 ASCII digits, zero-padded.
 */
export function isCIK(value: unknown): value is CIK {
	return typeof value === "string" && CIK_PATTERN.test(value)
}

/**
 * Zero-pads a numeric or string CIK candidate to the canonical 10-digit form and validates it. Returns `null` (never
 * throws) for anything that isn't a non-negative integer fitting in 10 digits — mirrors {@linkcode toFRN}'s (`frn.ts`)
 * "malformed input is common, not exceptional" posture for a value drawn from third-party data (`company_tickers.json`
 * ships CIKs as bare numbers, e.g. `320193`, never pre-padded).
 */
export function toCIK(value: string | number): CIK | null {
	const raw = typeof value === "number" ? String(value) : value.trim()

	if (!/^\d+$/.test(raw) || raw.length > 10) return null

	const padded = raw.padStart(10, "0")

	return isCIK(padded) ? padded : null
}

/**
 * The slice of `SECClient` (`sec-client.ts`) this module needs — {@linkcode fetchCompanyTickers}/
 * {@linkcode fetchTenKFilings} take this rather than the concrete class so a test can substitute a trivial stub instead
 * of building a full axios harness. A real `createSECClient()` instance already satisfies this structurally; the
 * production caller always passes one, so this stays "go through the existing SEC client", never a second fetcher.
 */
export interface SECGetClient {
	get<T>(input: string | URL): Promise<T>
}

const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

/**
 * One `company_tickers.json` row, exactly as `parseCompanyTickers` reads it off the wire — every value optional/
 * `unknown`-typed here because this is untrusted third-party JSON, not yet validated.
 */
interface RawCompanyTickerEntry {
	cik_str?: unknown
	ticker?: unknown
	title?: unknown
}

/**
 * One validated `company_tickers.json` row.
 */
export interface CompanyTickerEntry {
	cik: CIK
	ticker: string
	title: string
}

/**
 * Validates + types the raw `company_tickers.json` payload (an object keyed by row index, e.g. `{"0": {...}, "1":
 * {...}}` — SEC's own shape, not an array). Throws a descriptive error naming the offending row key on a structural
 * mismatch (decision 8's "malformed input must be loud" discipline, carried from `form499.ts`/`provider-list.ts`) —
 * this is SEC's own canonical reference file, so a row that doesn't fit the documented shape is a real signal something
 * changed upstream, not a case worth silently skipping.
 */
export function parseCompanyTickers(raw: unknown): CompanyTickerEntry[] {
	if (!raw || typeof raw !== "object") {
		throw new Error(
			"parseCompanyTickers: malformed company_tickers.json payload — expected an object keyed by row index"
		)
	}

	const entries: CompanyTickerEntry[] = []

	for (const [key, value] of Object.entries(raw as Record<string, RawCompanyTickerEntry>)) {
		const cikStr = value?.cik_str
		const ticker = value?.ticker
		const title = value?.title

		const cik = typeof cikStr === "string" || typeof cikStr === "number" ? toCIK(cikStr) : null

		if (cik === null || typeof ticker !== "string" || typeof title !== "string") {
			throw new Error(
				`parseCompanyTickers: malformed row ${JSON.stringify(key)} — expected {cik_str, ticker, title}, got ` +
					JSON.stringify(value)
			)
		}

		entries.push({ cik, ticker, title })
	}

	return entries
}

/**
 * Fetches + validates `company_tickers.json` through the shared SEC client.
 */
export async function fetchCompanyTickers(client: SECGetClient): Promise<CompanyTickerEntry[]> {
	const raw = await client.get<unknown>(COMPANY_TICKERS_URL)

	return parseCompanyTickers(raw)
}

/**
 * One name→CIK candidate {@linkcode resolveCIKCandidates} reports — never THE answer, just a scored possibility. See the
 * module docstring for why this function refuses to pick a single winner.
 */
export interface CIKCandidate {
	cik: CIK
	/**
	 * The company's name exactly as `company_tickers.json` spells it (`title`) — never canonicalized, so a caller sees
	 * what SEC actually published.
	 */
	companyName: string
	ticker: string
	/**
	 * Similarity in `[0, 1]` between the query name and this candidate's `companyName`, both reduced through
	 * {@linkcode canonicalizeOrganizationName} before comparison ({@linkcode nameSimilarity}, `@mailwoman/match`). `1`
	 * means the two names are IDENTICAL once legal designations are stripped — which is exactly the case that can still
	 * mean two different companies (see the module docstring), so a score of `1` is not itself a license to pick.
	 */
	score: number
}

/**
 * Options for {@linkcode resolveCIKCandidates}.
 */
export interface ResolveCIKOptions {
	/**
	 * Minimum score a candidate must clear to be reported at all. Defaults to {@linkcode DEFAULT_MIN_SCORE} —
	 * `nameSimilarity`'s own Jaro-Winkler boost threshold, below which two names have no meaningful similarity at all.
	 */
	minScore?: number
	/**
	 * Cap on the number of candidates returned, highest score first. Defaults to {@linkcode DEFAULT_CANDIDATE_LIMIT} —
	 * `company_tickers.json` carries 10,000+ rows, and reporting the whole tail below a real match is noise.
	 *
	 * NEVER narrows a genuine tie at the TOP score below this cap (see the function's own docstring) — `limit` trims the
	 * long low-scoring tail, not a collision the caller needs to see.
	 */
	limit?: number
}

const DEFAULT_MIN_SCORE = 0.7
const DEFAULT_CANDIDATE_LIMIT = 10

function canonicalOf(name: string): string {
	return canonicalizeOrganizationName(name)?.canonical || name.trim().toLowerCase()
}

/**
 * Score every `tickers` entry against `companyName` (both sides reduced through
 * {@linkcode canonicalizeOrganizationName} before comparison) and return every candidate at or above `minScore`,
 * highest score first — NEVER a single pick. See the module docstring for the false-identity-link rationale.
 *
 * **The tie rule is the actual enforcement mechanism, not the docstring alone.** Sorting by score and reporting `score`
 * per candidate is necessary but not sufficient — a caller that also passes `limit: 1` (the natural thing to do when it
 * wants "the" answer) would otherwise see the ambiguity vanish behind a plain `.slice(0, limit)`. So a genuine tie for
 * the TOP score is reported in full regardless of `limit`: querying `"American Broadband"` against a ticker file naming
 * both `"American Broadband LLC"` and `"American Broadband, Inc."` (disjoint CIKs, identical canonical form) with
 * `limit: 1` still returns BOTH, each at score `1` — the exact 3a lesson this module exists to not repeat. `limit` only
 * ever trims the tail STRICTLY BELOW the top score.
 */
export function resolveCIKCandidates(
	companyName: string,
	tickers: readonly CompanyTickerEntry[],
	options: ResolveCIKOptions = {}
): CIKCandidate[] {
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE
	const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT
	const queryCanonical = canonicalOf(companyName)

	const scored: CIKCandidate[] = []

	for (const entry of tickers) {
		const score = nameSimilarity(queryCanonical, canonicalOf(entry.title))

		if (score >= minScore) {
			scored.push({ cik: entry.cik, companyName: entry.title, ticker: entry.ticker, score })
		}
	}

	scored.sort((a, b) => b.score - a.score)

	if (!scored.length) return []

	const topScore = scored[0]!.score
	const tiedForTop = scored.filter((candidate) => candidate.score === topScore)

	if (tiedForTop.length >= limit) return tiedForTop

	return scored.slice(0, limit)
}

function submissionsURL(cik: CIK): string {
	return `https://data.sec.gov/submissions/CIK${cik}.json`
}

/**
 * The one form type {@linkcode fetchTenKFilings} keeps. 10-K/A amendments are a distinct filing this task's scope
 * doesn't need — deliberately excluded, not an oversight.
 */
const TEN_K_FORM = "10-K"

/**
 * One 10-K filing, as {@linkcode parseTenKFilings} extracts it from a submissions payload.
 */
export interface TenKFiling {
	cik: CIK
	accessionNumber: string
	filingDate: string
	/**
	 * The filing's primary document filename (e.g. `"aapl-20230930.htm"`) — the 10-K itself, NOT the Exhibit 21
	 * (`exhibit21.ts`'s concern), which is a separate document within the same accession's archive folder.
	 */
	primaryDocument: string
}

/**
 * The `filings.recent` shape `parseTenKFilings` reads — SEC's submissions API stores several parallel arrays (one value
 * per filing, all arrays the same length) rather than an array of objects.
 */
interface RawSubmissionsRecent {
	accessionNumber?: unknown
	filingDate?: unknown
	form?: unknown
	primaryDocument?: unknown
}

interface RawSubmissionsPayload {
	filings?: { recent?: RawSubmissionsRecent }
}

/**
 * Validates + extracts every 10-K filing from a raw submissions payload for `cik`. Throws a descriptive error naming
 * `cik` on a structural mismatch (missing `filings.recent`, or its parallel arrays disagreeing in length) — decision
 * 8's "malformed input must be loud" discipline; this is SEC's own documented API shape, so either failure means the
 * upstream contract changed, not a row worth silently dropping.
 */
export function parseTenKFilings(cik: CIK, raw: unknown): TenKFiling[] {
	const recent = (raw as RawSubmissionsPayload | null | undefined)?.filings?.recent

	if (!recent || !Array.isArray(recent.form)) {
		throw new Error(`parseTenKFilings: malformed submissions payload for CIK ${cik} — missing filings.recent.form`)
	}

	const { form, accessionNumber, filingDate, primaryDocument } = recent
	const length = form.length

	if (
		!Array.isArray(accessionNumber) ||
		accessionNumber.length !== length ||
		!Array.isArray(filingDate) ||
		filingDate.length !== length ||
		!Array.isArray(primaryDocument) ||
		primaryDocument.length !== length
	) {
		throw new Error(
			`parseTenKFilings: malformed submissions payload for CIK ${cik} — filings.recent's parallel arrays ` +
				"(accessionNumber/filingDate/primaryDocument/form) are not all the same length"
		)
	}

	const filings: TenKFiling[] = []

	for (let i = 0; i < length; i++) {
		if (form[i] !== TEN_K_FORM) continue

		filings.push({
			cik,
			accessionNumber: String(accessionNumber[i]),
			filingDate: String(filingDate[i]),
			primaryDocument: String(primaryDocument[i]),
		})
	}

	return filings
}

/**
 * Fetches + validates one CIK's submissions history through the shared SEC client and returns only its 10-K filings.
 */
export async function fetchTenKFilings(client: SECGetClient, cik: CIK): Promise<TenKFiling[]> {
	const raw = await client.get<unknown>(submissionsURL(cik))

	return parseTenKFilings(cik, raw)
}
