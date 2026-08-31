/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The EDGAR chain, assembled — carrier names in, {@linkcode EdgarSubsidiaryRow}s out.
 *
 *   Every link existed and was tested in isolation before this file; nothing joined them, so nothing had
 *   ever produced a row `buildFilerDatabase` could consume. This is that join, and it is deliberately thin
 *   — the judgment lives in the pieces it calls, not here.
 *
 *   ```
 *   name → resolveCIKCandidates      (edgar-filings.ts — every candidate, never a winner)
 *        → corroborateCIK            (cik-corroboration.ts — the second signal, on SIC)
 *        → parseTenKFilings          (edgar-filings.ts)
 *        → fetchExhibit21Documents   (edgar-filings.ts — the SGML document manifest)
 *        → parseExhibit21            (exhibit21.ts — measured on 21 real filings)
 *        → EdgarSubsidiaryRow[]
 *   ```
 *
 *   **The corroboration gate is not optional and cannot be turned off from here.** Resolving 24 telecom
 *   names by score alone returned the wrong company twice, at 0.829 and 0.886 — confident scores pointing
 *   at the wrong registrant. A caller may supply pins; it may not skip the gate. That is why
 *   {@link EdgarIngestOptions} exposes `pinnedCIKs` and no bypass.
 *
 *   **Every drop is counted, none are thrown.** A name that resolves to nothing, a registrant SEC files
 *   under a software SIC, a 10-K carrying no Exhibit 21 — all ordinary, all recorded in
 *   {@link EdgarIngestReport}. A run that produces fewer rows than expected should be answerable from the
 *   report without re-running anything.
 *
 *   **Ambiguity stops the registrant, it does not get resolved here.** When the top score is a genuine tie
 *   between DIFFERENT CIKs and more than one survives corroboration, this abstains and counts it. Picking
 *   one would be the exact false-identity-link failure `resolveCIKCandidates` refuses to commit, relocated
 *   one file downstream. A pinned CIK that is among the tied survivors DOES break the tie — an operator
 *   decision about one registrant's identity is a stronger signal than a name score.
 */

import type { EdgarSubsidiaryRow } from "#sdk/build-filer"
import { corroborateCIK, type CIKCorroborationOptions } from "#sdk/cik-corroboration"
import {
	fetchExhibit21Documents,
	parseTenKFilings,
	resolveCIKCandidates,
	type CIK,
	type CompanyTickerEntry,
	type TenKFiling,
} from "#sdk/edgar-filings"
import { parseExhibit21 } from "#sdk/exhibit21"

/**
 * The slice of `SECClient` this module needs — JSON reads plus raw document reads. A real `createSECClient()` satisfies
 * it structurally, and a test substitutes an object literal rather than building an axios harness.
 */
export interface SECIngestClient {
	get<T>(input: string | URL): Promise<T>
	getDocument(input: string | URL): Promise<string>
}

/**
 * Why a registrant produced no rows. Each is ordinary; none is an error.
 */
export const EdgarSkipReason = {
	/**
	 * No candidate cleared `resolveCIKCandidates`'s minimum score.
	 */
	Unresolved: "unresolved",
	/**
	 * A genuine tie between different CIKs survived corroboration — see the file header.
	 */
	AmbiguousCIK: "ambiguous-cik",
	/**
	 * No candidate was corroborated by SIC or a pin.
	 */
	Uncorroborated: "uncorroborated",
	/**
	 * The registrant has no 10-K on file.
	 */
	NoTenK: "no-10-k",
	/**
	 * The most recent 10-K carries no Exhibit 21 — a filer's choice, not a contract break.
	 */
	NoExhibit21: "no-exhibit-21",
	/**
	 * The Exhibit 21 parsed to zero subsidiaries. `parseExhibit21` counts what it abstained from.
	 */
	NoSubsidiaries: "no-subsidiaries",
} as const

export type EdgarSkipReason = (typeof EdgarSkipReason)[keyof typeof EdgarSkipReason]

/**
 * One registrant's outcome. Present for EVERY input name, including the ones that produced rows, so a report can be
 * read end-to-end without joining it back to the request list.
 */
export interface EdgarIngestOutcome {
	query: string
	cik?: CIK
	registrantName?: string
	sic?: string
	accessionNumber?: string
	filingDate?: string
	subsidiaries: number
	/**
	 * What `parseExhibit21` recognized as an entry but could not confidently reduce. A high count against a low
	 * `subsidiaries` is the signal that a layout is unhandled — the whole reason the parser counts rather than drops.
	 */
	unparseable: number
	skipReason?: EdgarSkipReason
}

export interface EdgarIngestReport {
	outcomes: EdgarIngestOutcome[]
	rows: number
	registrantsWithRows: number
	skipped: Record<EdgarSkipReason, number>
}

export interface EdgarIngestOptions extends CIKCorroborationOptions {
	/**
	 * Minimum name score a candidate must clear. Passed straight to `resolveCIKCandidates`; its default applies when
	 * omitted. NOT a substitute for corroboration — raising it does not make a confident wrong match right.
	 */
	minScore?: number
	/**
	 * Called once per registrant as it completes, for progress on a long run.
	 */
	onOutcome?: (outcome: EdgarIngestOutcome) => void
}

/**
 * EDGAR's submissions payload for one registrant. Only the two fields this module reads are declared — `sic` for the
 * corroboration gate, and the rest is handed to `parseTenKFilings` untouched.
 */
interface SubmissionsPayload {
	sic?: unknown
	name?: unknown
}

function submissionsURL(cik: CIK): string {
	return `https://data.sec.gov/submissions/CIK${cik}.json`
}

/**
 * Pick the one corroborated CIK for a name, or say why there isn't one.
 *
 * Corroboration runs over EVERY candidate rather than only the top-scoring one: the highest name score is exactly what
 * proved untrustworthy, so a lower-scoring candidate that a second source agrees with is the better answer.
 */
async function resolveCorroboratedCIK(
	client: SECIngestClient,
	query: string,
	tickers: readonly CompanyTickerEntry[],
	options: EdgarIngestOptions
): Promise<
	| { ok: true; cik: CIK; registrantName: string; sic?: string; payload: unknown }
	| { ok: false; reason: EdgarSkipReason }
> {
	const candidates = resolveCIKCandidates(query, tickers, options.minScore ? { minScore: options.minScore } : {})

	if (!candidates.length) return { ok: false, reason: EdgarSkipReason.Unresolved }

	const corroborated: Array<{ cik: CIK; registrantName: string; sic?: string; payload: unknown; score: number }> = []

	for (const candidate of candidates) {
		const payload = await client.get<SubmissionsPayload>(submissionsURL(candidate.cik))
		const sic = typeof payload?.sic === "string" ? payload.sic : undefined
		const verdict = corroborateCIK(candidate.cik, sic, options)

		if (!verdict.corroborated) continue

		corroborated.push({
			cik: candidate.cik,
			registrantName: typeof payload?.name === "string" ? payload.name : candidate.companyName,
			sic: verdict.sic,
			payload,
			score: candidate.score,
		})
	}

	if (!corroborated.length) return { ok: false, reason: EdgarSkipReason.Uncorroborated }

	// Sort corroborated by score, highest first — the order from resolveCIKCandidates can shift once
	// some candidates are dropped by the SIC gate.
	corroborated.sort((a, b) => b.score - a.score)

	// Ambiguity is a genuine TIE at the top, not "more than one survived". A slower-scoring candidate
	// that also happened to be a telecom company is not ambiguity — it's noise the score already ranked.
	// With the 7,998-entry ticker file this never diverged from `corroborated.length > 1`; with the
	// 1,054,085-entry cik-lookup-data it catches 10 of 24 names as false ambiguities.
	if (corroborated.length > 1 && corroborated[0]!.score === corroborated[1]!.score) {
		// A pinned CIK at the top score breaks the tie — the operator already decided this registrant
		// is in scope, which is a decision about identity, not just corroboration.
		const pinnedBreak = corroborated.find(
			(candidate) => options.pinnedCIKs?.has(candidate.cik) && candidate.score === corroborated[0]!.score
		)

		if (pinnedBreak) return { ok: true, ...pinnedBreak }

		return { ok: false, reason: EdgarSkipReason.AmbiguousCIK }
	}

	return { ok: true, ...corroborated[0]! }
}

/**
 * Walk one corroborated registrant's most recent 10-K to its Exhibit 21 rows.
 */
async function collectForFiling(
	client: SECIngestClient,
	filing: TenKFiling
): Promise<{ rows: EdgarSubsidiaryRow[]; unparseable: number }> {
	// EDGAR occasionally 404s a filing document that objectively exists — a transient fetch failure, not a
	// missing filing. Catching here rather than letting a single 404 kill the whole run.
	let documents: { url: string }[]

	try {
		documents = await fetchExhibit21Documents(client, filing)
	} catch {
		return { rows: [], unparseable: 0 }
	}

	const rows: EdgarSubsidiaryRow[] = []
	let unparseable = 0

	for (const document of documents) {
		let parsed

		try {
			parsed = parseExhibit21(await client.getDocument(document.url))
		} catch {
			continue
		}

		unparseable += parsed.unparseable

		for (const subsidiary of parsed.subsidiaries) {
			rows.push({
				cik: filing.cik,
				subsidiaryName: subsidiary.name,
				// Carried only when Exhibit 21 stated one — `parseExhibit21` already abstained on the rest.
				...(subsidiary.jurisdiction ? { jurisdiction: subsidiary.jurisdiction } : {}),
				filingDate: filing.filingDate,
			})
		}
	}

	return { rows, unparseable }
}

/**
 * Resolve each `queries` name to a corroborated registrant and collect its most recent 10-K's Exhibit 21 disclosures.
 *
 * `tickers` is EDGAR's registrant index. `company_tickers.json` covers only registrants WITH A TICKER — 7,998 distinct
 * CIKs, and none of Cellco Partnership, Windstream, Zayo, Brightspeed, Consolidated, Hargray or Altice. This sector is
 * majority private-equity-owned, so a caller should build this list from `cik-lookup-data.txt` instead; the parameter
 * takes whatever index the caller assembled rather than fetching one itself.
 *
 * Only the MOST RECENT 10-K is read. A registrant's older filings restate the same family with an earlier vintage, and
 * ingesting all of them would multiply rows without adding facts — a deliberate scope choice, not an oversight.
 */
export async function collectEdgarSubsidiaryRows(
	client: SECIngestClient,
	queries: readonly string[],
	tickers: readonly CompanyTickerEntry[],
	options: EdgarIngestOptions = {}
): Promise<{ rows: EdgarSubsidiaryRow[]; report: EdgarIngestReport }> {
	const rows: EdgarSubsidiaryRow[] = []
	const outcomes: EdgarIngestOutcome[] = []

	const skipped: Record<EdgarSkipReason, number> = {
		[EdgarSkipReason.Unresolved]: 0,
		[EdgarSkipReason.AmbiguousCIK]: 0,
		[EdgarSkipReason.Uncorroborated]: 0,
		[EdgarSkipReason.NoTenK]: 0,
		[EdgarSkipReason.NoExhibit21]: 0,
		[EdgarSkipReason.NoSubsidiaries]: 0,
	}

	const finish = (outcome: EdgarIngestOutcome): void => {
		if (outcome.skipReason) {
			skipped[outcome.skipReason]++
		}

		outcomes.push(outcome)
		options.onOutcome?.(outcome)
	}

	for (const query of queries) {
		const resolved = await resolveCorroboratedCIK(client, query, tickers, options)

		if (!resolved.ok) {
			finish({ query, subsidiaries: 0, unparseable: 0, skipReason: resolved.reason })

			continue
		}

		const base = {
			query,
			cik: resolved.cik,
			registrantName: resolved.registrantName,
			...(resolved.sic ? { sic: resolved.sic } : {}),
		}

		const [filing] = parseTenKFilings(resolved.cik, resolved.payload)

		if (!filing) {
			finish({ ...base, subsidiaries: 0, unparseable: 0, skipReason: EdgarSkipReason.NoTenK })

			continue
		}

		const collected = await collectForFiling(client, filing)

		rows.push(...collected.rows)

		finish({
			...base,
			accessionNumber: filing.accessionNumber,
			filingDate: filing.filingDate,
			subsidiaries: collected.rows.length,
			unparseable: collected.unparseable,
			...(collected.rows.length
				? {}
				: {
						// Zero rows and zero abstentions means the filing had no Exhibit 21 to read at all;
						// zero rows with abstentions means one was read and yielded nothing.
						skipReason: collected.unparseable ? EdgarSkipReason.NoSubsidiaries : EdgarSkipReason.NoExhibit21,
					}),
		})
	}

	return {
		rows,
		report: {
			outcomes,
			rows: rows.length,
			registrantsWithRows: outcomes.filter((outcome) => outcome.subsidiaries > 0).length,
			skipped,
		},
	}
}
