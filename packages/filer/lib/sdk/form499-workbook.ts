/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Form 499 filer database, read from the FCC's own XLSX export.
 *
 *   `form499.ts`'s {@linkcode parseForm499} reads a headerless 17-column TSV. That shape is not something
 *   the FCC publishes — it is what a human produced by hand-massaging this workbook, column by column, into
 *   the tuple Nexus's `csv.parse` was configured with. The tuple being POSITIONAL is why the massaging had
 *   to be exact, and the massaging is why the pipeline could never be re-run from source.
 *
 *   This reads the published workbook directly: 122 columns, a real header row, 19,852 filers in the
 *   2025-12-07 vintage. The 17-column TSV path stays for the artifacts already produced against it.
 *
 *   **What the workbook has that the TSV never did**, and why each matters:
 *
 *   - `note1`/`note2`/`note3` — the filer lifecycle. 11,533 rows carry one, and they parse to a closed
 *     eight-template vocabulary with ZERO unrecognized across the whole file (`form499-notes.ts`). Two of
 *     the eight are data the schema already has columns for: a cessation date, and a successor filer ID.
 *   - 59 per-jurisdiction TRUE/FALSE columns — the registered operating footprint. 11,256 filers operate in
 *     exactly one state, 1,780 in fifty or more.
 *   - `CORESID` — the FRN, under a name the 17-column tuple called `frn`.
 *
 *   **Three mappings would corrupt data if done naively**, which is the real argument for a reader rather
 *   than a spreadsheet export:
 *
 *   1. `LastFiling` is `M/D/YYYY`. It becomes `valid_from`, `assertISODate` REJECTS it, and
 *      `build-filer.ts` picks the latest legal name per FRN by comparing these as plain strings — where
 *      `4/1/2025` sorts below `12/31/2018`. Converted here, once.
 *   2. `USF_Contributor_1` is `Yes`/`No`. {@link Form499Row.usfContributor} is documented as true iff the
 *      raw value is the literal `TRUE`, so a pass-through makes every filer a non-contributor.
 *   3. The address is six columns (`HQ_Address1..3`, city, state, zip) where the row shape has one string.
 *
 *   **Header keys come from `normalizeColumnNames`, which deliberately leaves ALL-CAPS headers alone** — so
 *   the FRN column is `CORESID`, not `coresid`. Reading the lower-cased spelling yields `undefined` on
 *   every row, silently, and every filer loses its FRN. {@linkcode FORM_499_WORKBOOK_KEYS} pins the exact
 *   keys this reader depends on and {@linkcode assertWorkbookHeader} fails loudly when the export changes.
 *
 *   **Memory:** `XLSXSpliterator` materializes the sheet — XLSX is a ZIP of XML with shared strings in a
 *   separate entry, so bounded-memory streaming is not available. ~20k × 122 is fine; this note exists so
 *   nobody points it at a genuinely large workbook expecting otherwise.
 */

import { isoDate } from "@mailwoman/core/utils"
import { normalizeColumnNames, XLSXSpliterator, type XLSXCellValue } from "spliterator"

import { toFRN } from "#frn"
import type { Form499Row } from "#sdk/form499"
import { parseForm499Notes } from "#sdk/form499-notes"

/**
 * The workbook keys this reader reads by name, as {@linkcode normalizeColumnNames} renders them.
 *
 * `CORESID` keeps its upper case ON PURPOSE — see the module docstring. It is listed here rather than inlined so the
 * casing is stated once, next to the note explaining it.
 */
export const FORM_499_WORKBOOK_KEYS = {
	form499ID: "filer_499_id",
	lastFiling: "last_filing",
	usfContributor: "usf_contributor_1",
	legalName: "legal_name_of_carrier",
	doingBusinessAs: "doing_business_as",
	principalCommType: "principal_comm_type_1",
	holdingCompany: "holding_company",
	frn: "CORESID",
	managementCompany: "management_company",
	customerInquiriesTelephone: "customer_inquiries_telephone",
	dcAgentDisplayName: "dc_agent1",
	dcAgentOrganizationName: "dc_agent2",
	dcAgentTelephone: "dc_agent_telephone",
	// `DC_Agent_EMail` normalizes to `dc_agent_e_mail`, not `dc_agent_email` — the inner capital M is a
	// word boundary to the snake-caser. Caught by `assertWorkbookHeader`, which is what it is for.
	dcAgentEmailAddress: "dc_agent_e_mail",
	firstState: "alabama",
	lastState: "wyoming",
} as const

const HQ_ADDRESS_KEYS = ["hq_address1", "hq_address2", "hq_address3", "hq_city", "hq_state", "hq_zip_code"] as const

const CUSTOMER_ADDRESS_KEYS = [
	"customer_inquiries_address1",
	"customer_inquiries_address2",
	"customer_inquiries_address3",
	"customer_inquiries_city",
	"customer_inquiries_state",
	"customer_inquiries_zip_code",
] as const

const DC_AGENT_ADDRESS_KEYS = [
	"dc_agent_address1",
	"dc_agent_address2",
	"dc_agent_address3",
	"dc_agent_city",
	"dc_agent_state",
	"dc_agent_zip",
] as const

const NOTE_KEYS = ["note1", "note2", "note3"] as const

/**
 * USPS codes for the workbook's 59 jurisdiction columns, keyed by the normalized header name. Territories and the
 * Pacific atolls are included because the workbook carries them; Johnston and Midway have no USPS code of their own and
 * take their FIPS-adjacent conventional abbreviations, which are recorded here rather than silently dropped.
 */
const STATE_CODE_BY_KEY: Record<string, string> = {
	alabama: "AL",
	alaska: "AK",
	american_samoa: "AS",
	arizona: "AZ",
	arkansas: "AR",
	california: "CA",
	colorado: "CO",
	connecticut: "CT",
	delaware: "DE",
	district_of_columbia: "DC",
	florida: "FL",
	georgia: "GA",
	guam: "GU",
	hawaii: "HI",
	idaho: "ID",
	illinois: "IL",
	indiana: "IN",
	iowa: "IA",
	johnston_atoll: "JA",
	kansas: "KS",
	kentucky: "KY",
	louisiana: "LA",
	maine: "ME",
	maryland: "MD",
	massachusetts: "MA",
	michigan: "MI",
	midway_atoll: "MI-MID",
	minnesota: "MN",
	mississippi: "MS",
	missouri: "MO",
	montana: "MT",
	nebraska: "NE",
	nevada: "NV",
	new_hampshire: "NH",
	new_jersey: "NJ",
	new_mexico: "NM",
	new_york: "NY",
	north_carolina: "NC",
	north_dakota: "ND",
	northern_mariana_islands: "MP",
	ohio: "OH",
	oklahoma: "OK",
	oregon: "OR",
	pennsylvania: "PA",
	puerto_rico: "PR",
	rhode_island: "RI",
	south_carolina: "SC",
	south_dakota: "SD",
	tennessee: "TN",
	texas: "TX",
	utah: "UT",
	us_virgin_islands: "VI",
	vermont: "VT",
	virginia: "VA",
	wake_island: "WK",
	washington: "WA",
	west_virginia: "WV",
	wisconsin: "WI",
	wyoming: "WY",
}

// A cell can also arrive as a real boolean: a transformer that types the column hands one through, and `cell()`
// normalizes it like every other scalar. The union says so rather than a test asserting past it.
type WorkbookRow = Record<string, XLSXCellValue | boolean>

/**
 * One cell as a trimmed string. `null` (an empty XLSX cell), numbers and dates all normalize here, so no caller has to
 * branch on {@linkcode XLSXCellValue}'s union.
 */
function cell(row: WorkbookRow, key: string): string {
	const value = row[key]

	if (value === null || value === undefined) return ""

	if (value instanceof Date) return isoDate(value)

	return String(value).trim()
}

/**
 * Join a multi-column address into one line, dropping the parts the filer left blank.
 */
function joinAddress(row: WorkbookRow, keys: readonly string[]): string {
	return keys
		.map((key) => cell(row, key))
		.filter((value) => value.length > 0)
		.join(" ")
}

const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

/**
 * Convert the workbook's `M/D/YYYY` filing date to ISO `YYYY-MM-DD`.
 *
 * Returns `""` for anything that isn't that shape rather than inventing a date. That is deliberate and it is NOT
 * silent: `lastFiledAt` becomes `valid_from`, and `assertISODate` throws on a non-ISO value — so an unconverted date
 * fails the build loudly at the point it would be written, which is where a reader can see which filer caused it.
 * Emitting the raw `M/D/YYYY` here would fail the same assertion; emitting a guess would not fail at all.
 */
export function toISOFilingDate(value: string): string {
	// A workbook whose cells are real dates rather than text arrives pre-converted by `cell`.
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value

	const match = US_DATE_PATTERN.exec(value)

	if (!match) return ""

	const [, month, day, year] = match

	return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`
}

/**
 * Read the jurisdiction columns into sorted USPS codes. A column is set when its cell is the literal `TRUE` — the same
 * comparison `usfContributor` uses, and the same one the workbook's own values follow.
 */
export function readOperatingStates(row: WorkbookRow): string[] {
	const states: string[] = []

	for (const [key, code] of Object.entries(STATE_CODE_BY_KEY)) {
		if (cell(row, key).toUpperCase() === "TRUE") {
			states.push(code)
		}
	}

	return states.toSorted()
}

/**
 * Turn one workbook row into a {@linkcode Form499Row}.
 */
export function toForm499Row(row: WorkbookRow): Form499Row {
	const keys = FORM_499_WORKBOOK_KEYS

	return {
		form499ID: cell(row, keys.form499ID),
		frn: toFRN(cell(row, keys.frn)),
		lastFiledAt: toISOFilingDate(cell(row, keys.lastFiling)),
		// The workbook says Yes/No where the row shape is documented as "true iff the raw value is TRUE".
		// Both spellings are accepted so this reader stays correct if the export ever switches back.
		usfContributor: ["yes", "true"].includes(cell(row, keys.usfContributor).toLowerCase()),
		legalNameOfCarrier: cell(row, keys.legalName),
		doingBusinessAs: cell(row, keys.doingBusinessAs),
		principalCommType: cell(row, keys.principalCommType),
		holdingCompany: cell(row, keys.holdingCompany),
		managementCompany: cell(row, keys.managementCompany),
		hqAddress: joinAddress(row, HQ_ADDRESS_KEYS),
		customerInquiriesTelephone: cell(row, keys.customerInquiriesTelephone),
		customerInquiriesAddress: joinAddress(row, CUSTOMER_ADDRESS_KEYS),
		dcAgentDisplayName: cell(row, keys.dcAgentDisplayName),
		dcAgentOrganizationName: cell(row, keys.dcAgentOrganizationName),
		dcAgentTelephone: cell(row, keys.dcAgentTelephone),
		dcAgentEmailAddress: cell(row, keys.dcAgentEmailAddress),
		dcAgentAddress: joinAddress(row, DC_AGENT_ADDRESS_KEYS),
		lifecycle: parseForm499Notes(NOTE_KEYS.map((key) => cell(row, key))),
		operatingStates: readOperatingStates(row),
	}
}

/**
 * Every key {@linkcode toForm499Row} reads. A header missing any of these means the FCC changed its export, and this
 * reader would otherwise emit rows whose fields are all empty strings — a silent, whole-file data loss that looks like
 * a successful parse.
 */
const REQUIRED_KEYS: readonly string[] = [
	...Object.values(FORM_499_WORKBOOK_KEYS),
	...HQ_ADDRESS_KEYS,
	...CUSTOMER_ADDRESS_KEYS,
	...DC_AGENT_ADDRESS_KEYS,
	...NOTE_KEYS,
]

/**
 * Throw a descriptive error when the workbook's header is missing a key this reader needs.
 *
 * Exported so a caller can validate a header it already has without re-reading the file.
 */
export function assertWorkbookHeader(headerKeys: readonly string[]): void {
	const present = new Set(headerKeys)
	const missing = REQUIRED_KEYS.filter((key) => !present.has(key))

	if (missing.length) {
		throw new Error(
			`parseForm499Workbook: the workbook header is missing ${missing.length} column(s) this reader needs — ` +
				`${missing.join(", ")}. The FCC export's shape changed, or the sheet is not the filer database. ` +
				"Failing here rather than emitting rows whose every field is an empty string."
		)
	}
}

export interface ParseForm499WorkbookOptions {
	/**
	 * Sheet to read, as a 1-based number or a name. Defaults to the first.
	 */
	sheet?: number | string
}

/**
 * Stream the FCC's Form 499 filer workbook as {@linkcode Form499Row}s.
 *
 * The header is validated before the first row is yielded — see {@linkcode assertWorkbookHeader}.
 */
export async function* parseForm499Workbook(
	workbookPath: string,
	options: ParseForm499WorkbookOptions = {}
): AsyncIterable<Form499Row> {
	const sheet = options.sheet ?? 1

	const [rawHeader] = await XLSXSpliterator.fromAsync(workbookPath, { sheet, header: false, take: 1 }).toArray()

	if (!rawHeader) {
		throw new Error(`parseForm499Workbook: no rows found in ${workbookPath}`)
	}

	assertWorkbookHeader(normalizeColumnNames((rawHeader as XLSXCellValue[]).map((value) => String(value ?? ""))))

	for await (const row of XLSXSpliterator.fromAsync(workbookPath, { sheet, mode: "object" })) {
		yield toForm499Row(row as WorkbookRow)
	}
}
