/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file FCC Form 499 filer TSV — column vocabulary, row shape, classification mapping, and a
 *   streaming parser (3a decisions 3 & 8).
 *
 *   Re-homed from Nexus's `sync/fcc/universal-service.ts` (relicense-by-copy, no provenance
 *   headers) — ONLY the 17-column vocabulary (:27-44) and the `principalCommType` → classification
 *   mapping (:164-176) survive the port; everything else about the Nexus loader is rewritten:
 *
 *   - The Nexus loader reads the ENTIRE TSV into memory via `fs.readFile`, then parses it with the
 *     `csv` package configured `relax_column_count_less: true` — a short row is silently truncated,
 *     never surfaced. {@linkcode parseForm499} instead streams line-by-line off a `ReadStream` (the
 *     file is never held in memory whole) and throws a descriptive error naming the file and the
 *     1-indexed line number the moment a row's column count doesn't match
 *     {@linkcode FORM_499_COLUMNS}'s 17 — decision 8's "malformed input must be loud" discipline,
 *     the same one 2a's `peekProviderID` (`bdc/sdk/build-bdc.ts`) applies to a bad `provider_id`.
 *   - Nexus's `RawFCCForm499Filing` interface declares an `otherTradeName1` field that its own
 *     column tuple never lists — meaning it was NEVER actually populated by that loader, a live bug
 *     in the salvage source. This port omits the field entirely rather than perpetuate one that can
 *     never carry data.
 *   - `frn` is parsed through {@linkcode toFRN} (decision 3's zero-padded 10-digit branded string).
 *   - Nexus's row type carries `holdingCompany` AND `managementCompany` as two separate string
 *     fields; this port keeps both (spec §3.1 finding 1 — ownership and operational control are
 *     different assertions, not synonyms to collapse into one).
 *
 *   On the DC agent: the 499 "DC agent" is the registered agent for service of process, a role
 *   dominated by a handful of firms (CT Corporation, CSC, Cogency Global) serving tens of thousands
 *   of otherwise-unrelated filers. The `dcAgent*` fields below are carried as plain string
 *   attributes ONLY — nothing in this file, or anywhere downstream, may treat a shared DC agent as
 *   evidence that two filers are related. That inference is the single most likely false-positive
 *   generator in the whole crosswalk design (spec §3.1 finding 3) and is out of scope here by
 *   design, not by oversight.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { toFRN, type FRN } from "./frn.ts"

/**
 * The Form 499 filer TSV's 17 columns, in file order — ported verbatim from Nexus's `RawFCCForm499FilingColumns`
 * (`sync/fcc/universal-service.ts`:27-44) and spec §3.1. The source TSV carries no header row (Nexus's own `csv.parse`
 * call passes this same tuple as its `columns` option rather than reading column names off row 1), so
 * {@linkcode parseForm499} treats every line as data.
 */
export const FORM_499_COLUMNS = [
	"form499ID",
	"frn",
	"lastFiledAt",
	"usfContributor",
	"legalNameOfCarrier",
	"doingBusinessAs",
	"principalCommType",
	"holdingCompany",
	"managementCompany",
	"hqAddress",
	"customerInquiriesTelephone",
	"customerInquiriesAddress",
	"dcAgentDisplayName",
	"dcAgentOrganizationName",
	"dcAgentTelephone",
	"dcAgentEmailAddress",
	"dcAgentAddress",
] as const satisfies readonly string[]

export type Form499Column = (typeof FORM_499_COLUMNS)[number]

/**
 * One parsed row of the Form 499 filer TSV. See the module docstring for what changed from Nexus's
 * `RawFCCForm499Filing` (the `otherTradeName1` omission, the `FRN` typing, and the loader rewrite) and for the DC-agent
 * doctrine that governs `dcAgent*` below.
 */
export interface Form499Row {
	/**
	 * The raw Form 499 filer ID, kept as a string. Nexus typed this `Tagged<number, "Form499ID">`, but its own CSV parse
	 * never actually converted the field to a number — it was a bare type assertion over string CSV output. This port
	 * keeps the honest string type rather than perpetuate that mismatch.
	 */
	form499ID: string
	/**
	 * `null` when the raw field doesn't parse to a valid 10-digit FRN ({@linkcode toFRN}) — never thrown, since a
	 * missing/invalid FRN on an otherwise well-formed row is common in the wild (a filer not yet registered in CORES) and
	 * is not the "malformed row" decision 8 guards against.
	 */
	frn: FRN | null
	/**
	 * The date the form was last filed, as a raw string straight off the TSV — no `Date` parsing happens at this layer.
	 */
	lastFiledAt: string
	/**
	 * `true` iff the raw field is the literal string `"TRUE"` — matches Nexus's own comparison.
	 */
	usfContributor: boolean
	legalNameOfCarrier: string
	doingBusinessAs: string
	/**
	 * Free-text classification signal — see {@linkcode classifyFiler}.
	 */
	principalCommType: string
	/**
	 * The filer's holding company — an OWNERSHIP assertion. Kept distinct from {@link Form499Row.managementCompany} (spec
	 * §3.1 finding 1); do not collapse the two.
	 */
	holdingCompany: string
	/**
	 * The filer's management company — an OPERATIONAL CONTROL assertion, not a synonym for
	 * {@link Form499Row.holdingCompany}.
	 */
	managementCompany: string
	hqAddress: string
	customerInquiriesTelephone: string
	customerInquiriesAddress: string
	/**
	 * The DC agent's display name — the registered agent for service of process. Plain attribute only; see the module
	 * docstring. NEVER treat this (or the other `dcAgent*` fields) as evidence that two filers sharing an agent are
	 * related.
	 */
	dcAgentDisplayName: string
	dcAgentOrganizationName: string
	dcAgentTelephone: string
	dcAgentEmailAddress: string
	dcAgentAddress: string
}

/**
 * The classification signals `principalCommType` (plus `usfContributor`) can assert about a filer — ported from Nexus's
 * `OrganizationClassification` subset used by `supplementOrganization` (`sync/fcc/universal-service.ts`:158-176),
 * renamed to this workspace's own vocabulary.
 */
export const FilerClassification = {
	IncumbentLEC: "incumbent_lec",
	CLEC: "clec",
	InterExchange: "interexchange",
	TollReseller: "toll_reseller",
	USFContributor: "usf_contributor",
} as const

export type FilerClassification = (typeof FilerClassification)[keyof typeof FilerClassification]

/**
 * Classify a Form 499 row by its free-text `principalCommType` plus its `usfContributor` flag — a direct port of
 * Nexus's `supplementOrganization` mapping (`sync/fcc/universal-service.ts`:160-176), including its if/else-if between
 * Incumbent LEC and CLEC (a filer whose `principalCommType` contains "Incumbent" is classified as Incumbent LEC only,
 * never also CLEC, even though nothing in the FCC data guarantees those substrings are mutually exclusive).
 * Interexchange and Toll Reseller are independent checks, same as the original.
 */
export function classifyFiler(row: Form499Row): FilerClassification[] {
	const classifications: FilerClassification[] = []

	if (row.usfContributor) {
		classifications.push(FilerClassification.USFContributor)
	}

	if (row.principalCommType.includes("Incumbent")) {
		classifications.push(FilerClassification.IncumbentLEC)
	} else if (row.principalCommType.includes("CLEC")) {
		classifications.push(FilerClassification.CLEC)
	}

	if (row.principalCommType.includes("Interexchange")) {
		classifications.push(FilerClassification.InterExchange)
	}

	if (row.principalCommType.includes("Toll Reseller")) {
		classifications.push(FilerClassification.TollReseller)
	}

	return classifications
}

/**
 * Splits one TSV line into {@linkcode FORM_499_COLUMNS}'s 17 named fields. Throws a descriptive error naming `tsvPath`
 * and the 1-indexed `lineNumber` when the field count doesn't match — decision 8's "malformed input must be loud"
 * discipline (the 2a `peekProviderID` precedent), replacing Nexus's `relax_column_count_less: true`, which silently
 * truncated short rows instead.
 */
function splitForm499Line(line: string, tsvPath: string, lineNumber: number): Record<Form499Column, string> {
	const fields = line.split("\t")

	if (fields.length !== FORM_499_COLUMNS.length) {
		throw new Error(
			`parseForm499: malformed row at ${tsvPath}:${lineNumber} (line ${lineNumber}) — expected ` +
				`${FORM_499_COLUMNS.length} tab-delimited columns, got ${fields.length}`
		)
	}

	const raw = {} as Record<Form499Column, string>

	FORM_499_COLUMNS.forEach((column, index) => {
		raw[column] = fields[index]!
	})

	return raw
}

/**
 * Converts one {@linkcode splitForm499Line} result into a typed {@linkcode Form499Row} — applies {@linkcode toFRN} to
 * `frn` and the `"TRUE"` literal check to `usfContributor`; every other field passes through as the raw TSV string.
 */
function toForm499Row(raw: Record<Form499Column, string>): Form499Row {
	return {
		form499ID: raw.form499ID,
		frn: toFRN(raw.frn),
		lastFiledAt: raw.lastFiledAt,
		usfContributor: raw.usfContributor.trim() === "TRUE",
		legalNameOfCarrier: raw.legalNameOfCarrier,
		doingBusinessAs: raw.doingBusinessAs,
		principalCommType: raw.principalCommType,
		holdingCompany: raw.holdingCompany,
		managementCompany: raw.managementCompany,
		hqAddress: raw.hqAddress,
		customerInquiriesTelephone: raw.customerInquiriesTelephone,
		customerInquiriesAddress: raw.customerInquiriesAddress,
		dcAgentDisplayName: raw.dcAgentDisplayName,
		dcAgentOrganizationName: raw.dcAgentOrganizationName,
		dcAgentTelephone: raw.dcAgentTelephone,
		dcAgentEmailAddress: raw.dcAgentEmailAddress,
		dcAgentAddress: raw.dcAgentAddress,
	}
}

/**
 * Streams the Form 499 filer TSV at `tsvPath` line-by-line (`node:readline` over a `ReadStream` — the file is never
 * read into memory whole, unlike Nexus's `fs.readFile`-then-parse original) and yields each row as a typed
 * {@linkcode Form499Row}. A line whose column count doesn't match {@linkcode FORM_499_COLUMNS} throws immediately,
 * naming `tsvPath` and the 1-indexed line number (decision 8) — no partial/truncated row is ever silently yielded. A
 * blank trailing line (a lone `\n` at EOF) is skipped rather than treated as malformed.
 */
export async function* parseForm499(tsvPath: string): AsyncIterable<Form499Row> {
	const lines = createInterface({
		input: createReadStream(tsvPath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	})

	let lineNumber = 0

	for await (const line of lines) {
		lineNumber++

		if (!line.length) continue

		const raw = splitForm499Line(line, tsvPath, lineNumber)

		yield toForm499Row(raw)
	}
}
