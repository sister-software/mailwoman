/**
 * @copyright Sister Software.
 * @license AGPL-3.0
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
 * EDGAR's `cik-lookup-data.txt` — the FULL registrant index, including entities without a ticker. The format is one
 * entry per line, colon-delimited:
 *
 *     COMPANY NAME:0001234567:
 *
 * There is no ticker column (the empty third field is always blank). ~1,054,085 entries covering 40 MB; read the file
 * once and keep the result rather than reparsing it per query.
 *
 * An entry whose CIK won't parse is skipped without throwing — this is a flat file, not SEC's documented API shape, and
 * a malformed line is the rule rather than the exception. A CIK that rounds to zero (EDGAR pads to 10 digits) is also
 * skipped.
 *
 * **1,054,085 entries → one `resolveCIKCandidates` call scores ALL of them.** The function does a single O(n) pass with
 * a cheap `nameSimilarity` call per entry, which is fast enough for a tool that runs once per vintage. A caller running
 * thousands of queries should build a prefix index instead; that is not this.
 */
export function parseCIKLookupData(text: string): CompanyTickerEntry[] {
	const entries: CompanyTickerEntry[] = []

	// oxlint-disable mailwoman/prefer-spliterator -- 40 MB flat file, consumed inline by resolveCIKCandidates
	// which does an O(n) canonicalization scan and needs every entry resident.
	for (const line of text.split("\n")) {
		// oxlint-enable mailwoman/prefer-spliterator
		const trimmed = line.trim()

		if (!trimmed) continue

		const firstColon = trimmed.indexOf(":")
		const lastColon = trimmed.lastIndexOf(":")

		if (firstColon === -1 || firstColon === lastColon) continue

		const title = trimmed.slice(0, firstColon)

		if (!title) continue

		const numeric = Number(trimmed.slice(firstColon + 1, lastColon))

		if (!numeric) continue

		const cik = toCIK(numeric)

		if (!cik) continue

		entries.push({ cik, title, ticker: "" })
	}

	return entries
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
 *
 * **Candidates are collapsed to one row per CIK before any of that runs, and the tie rule depends on it.**
 * `company_tickers.json` carries one row per TICKER, so a registrant filed under several share classes appears several
 * times under a single CIK — resolving `"Liberty Broadband Corporation"` on 2026-08-03 returned CIK `0001611983` four
 * times, each scoring 1.0, and the same phantom tie appeared for Comcast, AT&T, T-Mobile and Telephone and Data
 * Systems. Left uncollapsed those duplicates trip the tie rule, which then suppresses `limit` and hands a caller the
 * same company back N times as though it were an unresolved ambiguity. The rule exists for a collision between
 * DIFFERENT companies; one company's share classes are not one. Per CIK the highest-scoring row wins (first seen wins
 * within an exact score tie, so the result is deterministic in ticker-file order), which is what keeps the reported
 * `companyName`/`ticker` the ones that actually matched.
 */
export function resolveCIKCandidates(
	companyName: string,
	tickers: readonly CompanyTickerEntry[],
	options: ResolveCIKOptions = {}
): CIKCandidate[] {
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE
	const limit = options.limit ?? DEFAULT_CANDIDATE_LIMIT
	const queryCanonical = canonicalOf(companyName)

	// Keyed by CIK, not pushed to a list: this is the share-class collapse the docstring describes, and it has to
	// happen BEFORE the sort so the tie rule below only ever sees distinct registrants.
	const bestByCIK = new Map<CIK, CIKCandidate>()

	for (const entry of tickers) {
		const score = nameSimilarity(queryCanonical, canonicalOf(entry.title))

		if (score < minScore) continue

		const incumbent = bestByCIK.get(entry.cik)

		if (incumbent && incumbent.score >= score) continue

		bestByCIK.set(entry.cik, { cik: entry.cik, companyName: entry.title, ticker: entry.ticker, score })
	}

	const scored = [...bestByCIK.values()]

	scored.sort((a, b) => b.score - a.score)

	if (!scored.length) return []

	const topScore = scored[0]!.score
	const tiedForTop = scored.filter((candidate) => candidate.score === topScore)

	if (tiedForTop.length >= limit) return tiedForTop

	return scored.slice(0, limit)
}
