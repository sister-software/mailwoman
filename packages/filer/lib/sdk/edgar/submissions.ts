/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 */

import type { CIK, SECGetClient } from "#sdk/edgar/cik"

/**
 * Uses `cik` ZERO-PADDED (`CIK` is always the 10-digit padded form — see the type's own docstring) — this is SEC's
 * documented submissions API shape (`CIK0000320193.json`, never `CIK320193.json`). Contrast
 * {@linkcode accessionArchiveURL} below, whose archive paths use the UNPADDED form instead; both conventions are real
 * and both appear in this file.
 */
export function submissionsURL(cik: CIK): string {
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
