/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The edgar chain, assembled — carrier names in, {@linkcode EdgarSubsidiaryRow}s out.
 *
 *   The corroboration check is mandatory: resolving 24 telecom names by score alone returned the wrong company twice,
 *   at 0.829 and 0.886, so {@link EdgarIngestOptions} exposes `pinnedCIKs` and no bypass. Every drop is counted
 *   rather than thrown, and a genuine tie between different CIKs that survives corroboration abstains unless a pinned
 *   CIK at the top score breaks it.
 */

import type { EdgarSubsidiaryRow } from "#sdk/build/filer"
import { corroborateCIK, type CIKCorroborationOptions } from "#sdk/cik-corroboration"
import {
	fetchExhibit21Documents,
	parseTenKFilings,
	resolveCIKCandidates,
	submissionsURL,
	type CIK,
	type CompanyTickerEntry,
	type TenKFiling,
} from "#sdk/edgar/filings/index"
import { parseExhibit21 } from "#sdk/exhibit21/index"

/**
 * The subset of `SECClient` this module needs — JSON reads plus raw document reads —
 * which a real `createSECClient()` satisfies structurally.
 */
export interface SECIngestClient {
	get<T>(input: string | URL): Promise<T>
	getDocument(input: string | URL): Promise<string>
}

/**
 * Why a registrant produced no rows; each reason is ordinary rather than an error.
 */
export const EdgarSkipReason = {
	/**
	 * No candidate cleared `resolveCIKCandidates`'s minimum score.
	 */
	Unresolved: "unresolved",
	/**
	 * A genuine tie between different CIKs survived corroboration.
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
	 * The most recent 10-K carries no Exhibit 21 — a filer's choice rather than an interface failure.
	 */
	NoExhibit21: "no-exhibit-21",
	/**
	 * The Exhibit 21 parsed to zero subsidiaries.
	 */
	NoSubsidiaries: "no-subsidiaries",
} as const

export type EdgarSkipReason = (typeof EdgarSkipReason)[keyof typeof EdgarSkipReason]

/**
 * One registrant's outcome, present for every input name including the ones that produced rows,
 * so a report can be read end-to-end without joining it back to the request list.
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
	 * What `parseExhibit21` recognized as an entry but could not confidently reduce;
	 * a high count against a low `subsidiaries` signals an unhandled layout.
	 */
	unparseable: number
	skipReason?: EdgarSkipReason
}

/**
 * The full per-run report: every registrant's outcome plus the row and skip totals.
 */
export interface EdgarIngestReport {
	outcomes: EdgarIngestOutcome[]
	rows: number
	registrantsWithRows: number
	skipped: Record<EdgarSkipReason, number>
}

/**
 * Options for {@linkcode collectEdgarSubsidiaryRows}, extending the corroboration
 * options with a score floor and a progress callback.
 */
export interface EdgarIngestOptions extends CIKCorroborationOptions {
	/**
	 * Minimum name score a candidate must clear, passed straight to `resolveCIKCandidates`;
	 * raising it is not a substitute for corroboration.
	 */
	minScore?: number
	/**
	 * Called once per registrant as it completes, for progress on a long run.
	 */
	onOutcome?: (outcome: EdgarIngestOutcome) => void
}

/**
 * Edgar's submissions payload: only the two fields this module reads are declared,
 * and the rest is handed to `parseTenKFilings` untouched.
 */
interface SubmissionsPayload {
	sic?: unknown
	name?: unknown
}

/**
 * Picks the one corroborated CIK for a name, or says why there isn't one; corroboration runs
 * over every candidate because the highest name score is exactly what proved untrustworthy.
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

	corroborated.sort((a, b) => b.score - a.score)

	// Ambiguity is a genuine tie at the top rather than "more than one survived";
	// with the 1,054,085-entry cik-lookup-data, `corroborated.length > 1` alone
	// would count 10 of 24 names as false ambiguities.
	if (corroborated.length > 1 && corroborated[0]!.score === corroborated[1]!.score) {
		// A pinned CIK at the top score breaks the tie: that is an operator decision about identity, not a name score.
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
	// edgar occasionally 404s a filing document that objectively exists, a transient fetch
	// failure, so catch here rather than let a single 404 kill the whole run.
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
				...(subsidiary.jurisdiction ? { jurisdiction: subsidiary.jurisdiction } : {}),
				filingDate: filing.filingDate,
			})
		}
	}

	return { rows, unparseable }
}

/**
 * Resolves each `queries` name to a corroborated registrant and collects its
 * most recent 10-K's Exhibit 21 disclosures.
 *
 * `company_tickers.json` covers only registrants with a ticker — 7,998 distinct CIKs,
 * missing Cellco Partnership, Windstream, Zayo, Brightspeed, Consolidated, Hargray and Altice —
 * so a caller should build the `tickers` index from `cik-lookup-data.txt` instead.
 * Only the most recent 10-K is read: older filings restate the same family with an earlier vintage.
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
						// Zero rows with no abstentions means the filing had no Exhibit 21;
						// zero rows with abstentions means one was read and yielded no row.
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
