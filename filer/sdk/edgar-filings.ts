/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file SEC EDGAR company→CIK resolution + 10-K filing discovery.
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
 *   false-identity-link lesson, carried forward).** `cluster-filers.ts` carries the worked example:
 *   "American Broadband LLC" and "American Broadband, Inc." — two DIFFERENT companies — canonicalize to the
 *   exact same string once legal designations are stripped, and a matcher that silently picks "the best
 *   name match" would merge them under one CIK. `resolveCIKCandidates` therefore never returns a single
 *   winner: it returns every candidate that clears {@link ResolveCIKOptions.minScore}, each carrying its own
 *   `score`, and — the part that actually enforces this — a genuine TIE for the top score is NEVER silently
 *   narrowed to fewer than `limit` (see {@linkcode resolveCIKCandidates}'s own docstring). Deciding which
 *   candidate (if any) is authoritative belongs to a caller holding corroborating evidence — an existing
 *   FRN's legal name, say — which this module does not have.
 *
 *   No live network in the test suite: every test either drives {@linkcode parseCompanyTickers}/
 *   {@linkcode parseTenKFilings}/{@linkcode resolveCIKCandidates} directly (pure functions) or passes a
 *   hand-rolled stub satisfying {@link SECGetClient} — the one method (`get<T>`) this module actually calls
 *   on the shared SEC client, so a test never has to build a full axios harness just to exercise this file.
 *
 *   **A third responsibility: which document IN a filing is the Exhibit 21.** `exhibit21.ts`'s
 *   {@linkcode fetchExhibit21} parses a document once its URL is already known and says finding that URL is
 *   out of scope. EDGAR's accession `index.json` can't answer it either — every file there is typed as a
 *   GIF icon name (`"type":"text.gif"`). The accession's `…-index-headers.html` can: it carries the
 *   submission's own SGML manifest (HTML-escaped, one `&lt;DOCUMENT&gt;…&lt;/DOCUMENT&gt;` block per filed
 *   document) naming every document's `TYPE`/`FILENAME`. {@linkcode parseFilingDocuments} reads that
 *   manifest; {@linkcode findExhibit21Documents} narrows it to the Exhibit 21 entries; both are pure
 *   functions over an already-fetched string, and {@linkcode fetchExhibit21Documents} is the thin
 *   fetch-then-parse pairing, same shape as `fetchCompanyTickers`/`fetchTenKFilings` above.
 */

import { nameSimilarity } from "@mailwoman/match"
import { canonicalizeOrganizationName } from "@mailwoman/record"
import type { Tagged } from "type-fest"

import type { SECDocumentClient } from "./exhibit21.ts"

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

	// oxlint-disable mailwoman/prefer-spliterator — 40 MB flat file, consumed inline by resolveCIKCandidates
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

/**
 * Uses `cik` ZERO-PADDED (`CIK` is always the 10-digit padded form — see the type's own docstring) — this is SEC's
 * documented submissions API shape (`CIK0000320193.json`, never `CIK320193.json`). Contrast
 * {@linkcode accessionArchiveURL} below, whose archive paths use the UNPADDED form instead; both conventions are real
 * and both appear in this file.
 */
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

/**
 * One document {@linkcode parseFilingDocuments} reads out of a filing's SGML manifest — `type` and `filename` exactly
 * as EDGAR's own `&lt;TYPE&gt;`/`&lt;FILENAME&gt;` manifest lines spell them (never normalized/uppercased — see
 * {@linkcode EXHIBIT_21_TYPE_PATTERN} for why matching stays case-insensitive instead of relying on a canonical
 * spelling), plus the absolute archive `url` this module derives ({@linkcode accessionArchiveURL} + `filename`).
 */
export interface ExhibitDocument {
	type: string
	filename: string
	url: string
}

/**
 * Builds the archive folder URL for one accession. Uses `cik` UNPADDED (`Number(cik)` is what strips the zero-padding
 * `CIK` always carries) — EDGAR's archive paths spell the CIK bare (`.../data/18926/...`), the opposite convention from
 * {@linkcode submissionsURL} above, which zero-pads. Both are real EDGAR conventions and both appear in this file; a
 * caller reaching for the wrong one gets a 404, not a wrong-but-plausible document. `accessionNumber` is accepted
 * either dashed (`"0000018926-26-000014"`, the form every EDGAR-facing field spells it) or already undashed — the
 * archive path itself never carries the dashes.
 */
export function accessionArchiveURL(cik: CIK, accessionNumber: string): string {
	return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}`
}

// Operates on `headerHTML` — the accession's `…-index-headers.html` body, which HTML-escapes EDGAR's own SGML
// manifest (so `<DOCUMENT>` reads literally as `&lt;DOCUMENT&gt;` in the source). One block per filed document, in
// filing order; a final unterminated block (malformed/truncated input) still yields everything after its opening tag
// via the `$` fallback rather than being silently dropped.
const DOCUMENT_BLOCK_PATTERN = /&lt;DOCUMENT&gt;([\s\S]*?)(?:&lt;\/DOCUMENT&gt;|$)/gi
const DOCUMENT_TYPE_PATTERN = /&lt;TYPE&gt;([^\r\n<]+)/i
const DOCUMENT_FILENAME_PATTERN = /&lt;FILENAME&gt;([^\r\n<]+)/i

/**
 * Matches every `TYPE` spelling EDGAR actually files an Exhibit 21 under (`EX-21`, `EX-21.1`, `EX-21.01`, lowercase
 * `ex-21.2`, …) while rejecting a type that merely starts the same way — `EX-2`, `EX-2.1`, `EX-210`, `EX-23`, `EX-21A`
 * are all distinct exhibits, not a spelling variant of Exhibit 21. The literal `21` must be the whole numeric part:
 * optionally followed by ONLY a `.` and more digits, never another bare digit or letter.
 */
const EXHIBIT_21_TYPE_PATTERN = /^ex-?21(\.\d+)?$/i

/**
 * Reads EVERY document out of one accession's SGML manifest (`headerHTML`, the `…-index-headers.html` body) — not only
 * the exhibits, so a caller wanting a different document type later doesn't need a second parser. A manifest block
 * missing either its `TYPE` or its `FILENAME` line is dropped rather than emitted with a guessed value or a `url`
 * ending in a bare slash — decision 6's "abstain, never guess" posture, carried from `exhibit21.ts`, applied here to a
 * manifest row instead of a subsidiary row.
 */
export function parseFilingDocuments(cik: CIK, accessionNumber: string, headerHTML: string): ExhibitDocument[] {
	const archiveURL = accessionArchiveURL(cik, accessionNumber)
	const documents: ExhibitDocument[] = []

	for (const match of headerHTML.matchAll(DOCUMENT_BLOCK_PATTERN)) {
		const block = match[1]!
		const type = DOCUMENT_TYPE_PATTERN.exec(block)?.[1]?.trim()
		const filename = DOCUMENT_FILENAME_PATTERN.exec(block)?.[1]?.trim()

		if (!type || !filename) continue

		documents.push({ type, filename, url: `${archiveURL}/${filename}` })
	}

	return documents
}

/**
 * Narrows one accession's full document manifest to its Exhibit 21 entries (see {@linkcode EXHIBIT_21_TYPE_PATTERN} for
 * the accepted spellings). Returns `[]` — NEVER throws — when the manifest has no Exhibit 21 at all, which is ordinary,
 * not exceptional: an absent exhibit is the FILER's choice (Consolidated Communications' and United States Cellular's
 * latest 10-Ks both carry none), not an upstream contract break. This is the opposite posture from
 * {@linkcode parseCompanyTickers}/{@linkcode parseTenKFilings} above, which throw on a malformed payload — those parse
 * SEC's OWN documented API shapes, so a mismatch there means the upstream contract changed. A manifest with no Exhibit
 * 21 hasn't broken any contract; it's just a filer that didn't file one this cycle.
 */
export function findExhibit21Documents(cik: CIK, accessionNumber: string, headerHTML: string): ExhibitDocument[] {
	return parseFilingDocuments(cik, accessionNumber, headerHTML).filter((document) =>
		EXHIBIT_21_TYPE_PATTERN.test(document.type)
	)
}

/**
 * Fetches one filing's accession manifest (`{@linkcode accessionArchiveURL}(filing.cik, filing.accessionNumber)` joined
 * with `${filing.accessionNumber}-index-headers.html`, through the shared {@link SECDocumentClient} — `exhibit21.ts`'s
 * one-method structural type, not the concrete SEC client, so a test never needs an axios harness) and returns its
 * Exhibit 21 documents. See {@linkcode findExhibit21Documents} for why an absent exhibit is a `[]` result, not a thrown
 * error.
 */
export async function fetchExhibit21Documents(
	client: SECDocumentClient,
	filing: TenKFiling
): Promise<ExhibitDocument[]> {
	const indexURL = `${accessionArchiveURL(filing.cik, filing.accessionNumber)}/${filing.accessionNumber}-index-headers.html`
	const headerHTML = await client.getDocument(indexURL)

	return findExhibit21Documents(filing.cik, filing.accessionNumber, headerHTML)
}
