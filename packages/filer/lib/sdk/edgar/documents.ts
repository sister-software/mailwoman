/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 */

import { BLOCK_ELEMENTS, htmlToLayoutText } from "@mailwoman/core/html/text"
import { TextSpliterator } from "spliterator"

import type { CIK } from "#sdk/edgar/cik"
import type { TenKFiling } from "#sdk/edgar/submissions"
import type { SECDocumentClient } from "#sdk/exhibit21/index"

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

/**
 * Matches every `TYPE` spelling EDGAR actually files an Exhibit 21 under (`EX-21`, `EX-21.1`, `EX-21.01`, lowercase
 * `ex-21.2`, …) while rejecting a type that merely starts the same way — `EX-2`, `EX-2.1`, `EX-210`, `EX-23`, `EX-21A`
 * are all distinct exhibits, not a spelling variant of Exhibit 21. The literal `21` must be the whole numeric part:
 * optionally followed by ONLY a `.` and more digits, never another bare digit or letter.
 */
const EXHIBIT_21_TYPE_PATTERN = /^ex-?21(\.\d+)?$/i

/**
 * One `<TAG>value` line of EDGAR's SGML manifest, which is a tag-per-line header format rather than nested markup —
 * `<TYPE>`, `<SEQUENCE>` and `<FILENAME>` have no closing tags at all. Matched against RECOVERED text, never against
 * markup: {@linkcode parseFilingDocuments} reads the index page first, which is what turns `&lt;TYPE&gt;` back into
 * `<TYPE>` and removes the page's own `<a>`/`<br>` elements.
 */
const MANIFEST_FIELD_PATTERN = /^<([a-z][a-z-]*)>(.*)$/i

/**
 * Reads EVERY document out of one accession's SGML manifest (`headerHTML`, the `…-index-headers.html` body) — not only
 * the exhibits, so a caller wanting a different document type later doesn't need a second parser.
 *
 * The manifest is EDGAR's own SGML, HTML-ESCAPED inside the index page (`<DOCUMENT>` is written `&lt;DOCUMENT&gt;`) and
 * interleaved with that page's `<a>` and `<br>` elements — the Lumen 2025 accession states 163 of them across 161
 * documents. Reading the page as text decodes the manifest back to itself and drops the page markup, so the field
 * patterns below never have to match one markup language through another's escaping.
 *
 * A manifest block missing either its `TYPE` or its `FILENAME` line is dropped rather than emitted with a guessed value
 * or a `url` ending in a bare slash — decision 6's "abstain, never guess" posture, carried from `exhibit21.ts`, applied
 * to a manifest row instead of a subsidiary row.
 */
export function parseFilingDocuments(cik: CIK, accessionNumber: string, headerHTML: string): ExhibitDocument[] {
	const archiveURL = accessionArchiveURL(cik, accessionNumber)
	const documents: ExhibitDocument[] = []

	let type: string | undefined
	let filename: string | undefined

	for (const line of TextSpliterator.from(htmlToLayoutText(headerHTML, BLOCK_ELEMENTS), { skipEmpty: true })) {
		const field = MANIFEST_FIELD_PATTERN.exec(line.trim())

		if (!field) continue

		const value = field[2]!.trim()

		switch (field[1]!.toUpperCase()) {
			case "DOCUMENT": {
				// A new block abandons whatever the previous one left half-stated.
				type = undefined
				filename = undefined

				break
			}

			case "TYPE": {
				type ??= value

				break
			}

			case "FILENAME": {
				filename ??= value

				break
			}
		}

		if (type && filename) {
			documents.push({ type, filename, url: `${archiveURL}/${filename}` })
			type = undefined
			filename = undefined
		}
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
