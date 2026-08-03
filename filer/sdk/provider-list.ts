/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file BDC provider list CSV — streaming parser preserving multi-FRN cardinality (decision 6).
 *
 *   Source shape reference: Nexus's `sync/scripts/registrations.ts` parses `bdc_us_provider_list_*.csv`
 *   into `{frn, provider_id, holding_company}` rows via `csv.parse(contents, { columns: true })` — a
 *   whole-file, header-keyed read. This port keeps the header-keyed shape (so extra or reordered
 *   real-world columns, e.g. `provider_name`/`dba_name`, don't break it — only the three named columns
 *   below are required, anywhere in the header), but rewrites the loader per decision 8: it streams
 *   line-by-line off a `ReadStream` (`node:readline`, the same construction as {@linkcode parseForm499}
 *   in `form499.ts`) rather than reading the file whole, and it throws a descriptive error naming the
 *   file and 1-indexed line number the instant a row's column count doesn't match the header — no
 *   partial/truncated row is ever silently yielded.
 *
 *   Decision 6 is the entire point of this file, so it bears repeating exactly what NOT to copy: Nexus's
 *   `parseBDCProvidersFiles` folds every row sharing a `provider_id` into ONE `BroadbandProvider` via a
 *   `Map<ProviderID, BroadbandProvider>` — a later row's FRN is added to a `Set` (cardinality preserved
 *   there, incidentally) but its `holdingCompany` silently OVERWRITES the previous value, only warning
 *   to the console when the two strings differ. That fold happens at PARSE time, before anything
 *   downstream ever sees the discarded string. {@linkcode parseProviderList} does none of that: it is a
 *   flat streaming pass with NO `Map` keyed by `provider_id`, NO dedup, and NO last-wins — every row in
 *   the file is yielded exactly once, in file order. A `provider_id` appearing on N rows yields N
 *   {@linkcode ProviderListRow}s, full stop. The crosswalk graph (`filer.db`) is where that cardinality gets
 *   to mean something; collapsing it here would be unrecoverable downstream.
 *
 *   `frn` is parsed through {@linkcode toFRN} (decision 3's zero-padded 10-digit branded string). Unlike
 *   `Form499Row.frn`, this field is NOT nullable: the provider list — unlike a 499 filing — has no
 *   legitimate row without a resolvable FRN, so a row whose `frn` field doesn't parse is treated as
 *   malformed input and throws (decision 8), not silently coerced to `null`.
 */

import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"

import { toFRN, type FRN } from "./frn.ts"

/**
 * The three provider-list CSV columns this parser actually reads, named after Nexus's `RawProviderRecord`
 * (`sync/scripts/registrations.ts`). Looked up by NAME against the file's own header row — not by position — so extra
 * or reordered columns in the real FCC file don't break parsing.
 */
const REQUIRED_PROVIDER_LIST_COLUMNS = ["frn", "provider_id", "holding_company"] as const satisfies readonly string[]

/**
 * One parsed row of the BDC provider list CSV. See the module docstring for decision 6 (why
 * {@linkcode parseProviderList} yields every row rather than folding by `provider_id`) and decision 3 (why `frn` is the
 * zero-padded branded string, not a bare number).
 */
export interface ProviderListRow {
	/**
	 * The FCC's numeric provider identifier. NOT branded — the task brief specifies a plain `number`, and unlike
	 * {@link ProviderListRow.frn} there is no leading-zero concern (BDC provider IDs are ordinary small integers, not
	 * zero-padded strings).
	 */
	providerID: number
	/**
	 * Zero-padded 10-digit FRN ({@linkcode toFRN}). Never `null` — see the module docstring.
	 */
	frn: FRN
	/**
	 * The filer's holding company as it appears on THIS row. `null` when the raw CSV field is empty — one `providerID`
	 * can legitimately carry different `holdingCompany` strings across rows (decision 6); do not assume this field is
	 * stable per `providerID`.
	 */
	holdingCompany: string | null
}

/**
 * Splits one CSV line into fields, honoring double-quote-delimited fields (so a quoted `holding_company` value
 * containing a comma, e.g. `"Second Holdings, Renamed LLC"`, survives as one field) and the standard `""` doubled-quote
 * escape for a literal quote inside a quoted field. Deliberately scoped to single-line fields only — a quoted field
 * spanning multiple physical lines is out of scope, since this parser reads line-by-line via `node:readline` (see the
 * module docstring's streaming rationale) and the BDC provider list's `holding_company` values are single-line company
 * names in practice.
 */
function splitProviderListCSVLine(line: string): string[] {
	const fields: string[] = []
	let current = ""
	let inQuotes = false

	for (let index = 0; index < line.length; index++) {
		const char = line[index]!

		if (inQuotes) {
			if (char === '"') {
				if (line[index + 1] === '"') {
					current += '"'

					index++
				} else {
					inQuotes = false
				}
			} else {
				current += char
			}

			continue
		}

		if (char === '"') {
			inQuotes = true
		} else if (char === ",") {
			fields.push(current)
			current = ""
		} else {
			current += char
		}
	}

	fields.push(current)

	return fields
}

/**
 * Confirms `header` names every column {@linkcode REQUIRED_PROVIDER_LIST_COLUMNS} needs, throwing a descriptive error
 * naming `csvPath` and the missing column otherwise — decision 8's "malformed input must be loud" discipline applied to
 * the header row, not just data rows.
 */
function assertRequiredProviderListColumns(header: readonly string[], csvPath: string): void {
	for (const column of REQUIRED_PROVIDER_LIST_COLUMNS) {
		if (!header.includes(column)) {
			throw new Error(
				`parseProviderList: malformed header at ${csvPath} — missing required column ${JSON.stringify(column)}`
			)
		}
	}
}

/**
 * Converts one data row's split `fields` (already confirmed to match `header`'s length) into a typed
 * {@linkcode ProviderListRow}, throwing a descriptive error naming `csvPath` and the 1-indexed `lineNumber` when
 * `provider_id` doesn't parse to a safe integer or `frn` doesn't parse via {@linkcode toFRN} — both decision 8's
 * "malformed input must be loud" discipline, mirroring the 2a `peekProviderID` precedent (`bdc/sdk/build-bdc.ts`) for
 * the integer guard.
 */
function toProviderListRow(
	header: readonly string[],
	fields: readonly string[],
	csvPath: string,
	lineNumber: number
): ProviderListRow {
	const raw: Record<string, string> = {}

	header.forEach((column, index) => {
		raw[column] = fields[index]!
	})

	const providerIDField = raw.provider_id!
	const providerID = Number.parseInt(providerIDField, 10)

	if (!Number.isSafeInteger(providerID)) {
		throw new TypeError(
			`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — provider_id did not ` +
				`parse to a safe integer, got ${JSON.stringify(providerIDField)}`
		)
	}

	const frn = toFRN(raw.frn!)

	if (frn === null) {
		throw new Error(
			`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — frn ` +
				`${JSON.stringify(raw.frn)} did not parse to a valid FRN`
		)
	}

	const holdingCompanyField = raw.holding_company!

	return {
		providerID,
		frn,
		holdingCompany: holdingCompanyField === "" ? null : holdingCompanyField,
	}
}

/**
 * Streams the BDC provider list CSV at `csvPath` line-by-line (`node:readline` over a `ReadStream` — same construction
 * as {@linkcode parseForm499}, the file is never read into memory whole) and yields EVERY row as a typed
 * {@linkcode ProviderListRow}. The first non-blank line is read as the header and used to locate the
 * `frn`/`provider_id`/`holding_company` columns by name; a header missing any of the three throws immediately. A data
 * row whose column count doesn't match the header's throws immediately, naming `csvPath` and the 1-indexed line number
 * (decision 8) — no partial/truncated row is ever silently yielded. A blank line is skipped rather than treated as
 * malformed.
 *
 * Decision 6 (repeated from the module docstring because it is the entire point of this function): a `provider_id`
 * appearing on multiple rows is yielded once PER ROW, exactly as it appears in the file. No dedup, no last-wins, no
 * folding into a `Map` keyed by `provider_id` — the crosswalk graph is where that cardinality belongs, not here.
 */
export async function* parseProviderList(csvPath: string): AsyncIterable<ProviderListRow> {
	const lines = createInterface({
		input: createReadStream(csvPath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	})

	let lineNumber = 0
	let header: string[] | null = null

	for await (const line of lines) {
		lineNumber++

		if (!line.length) continue

		const fields = splitProviderListCSVLine(line)

		if (header === null) {
			assertRequiredProviderListColumns(fields, csvPath)
			header = fields

			continue
		}

		if (fields.length !== header.length) {
			throw new Error(
				`parseProviderList: malformed row at ${csvPath}:${lineNumber} (line ${lineNumber}) — expected ` +
					`${header.length} comma-delimited columns (per header), got ${fields.length}`
			)
		}

		yield toProviderListRow(header, fields, csvPath, lineNumber)
	}
}
