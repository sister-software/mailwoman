/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The premise-linkage report writer (#1902) and the PREFLIGHT that decides whether anything is
 *   written at all.
 *
 *   The threat this guards against is not a careless operator. It is an ordinary change: someone adds
 *   a field to help debug a bad run, a provider payload rides along inside it, and the report is
 *   already in a pull request before anybody reads the diff closely. So the writer does not trust the
 *   type system to have kept the report clean — the types are what the code was written against, and
 *   the leak arrives in the code that was written afterwards. It re-derives the answer from the VALUES
 *   about to be serialized:
 *
 *   1. Every key must be one this schema declares. An unknown key is refused whatever it holds, which
 *        is what makes the check hold against fields that do not exist yet.
 *   2. No string may look like a street address, may contain a long digit run in the shape of an
 *        authoritative identifier, or may contain any input string this run read. The run's inputs are
 *        held in memory for exactly this comparison and discarded with the run.
 *   3. No row whose terms forbid a published coordinate may carry a coordinate error.
 *   4. The run itself must be at least the agreed minimum cell size, and any per-class cell below it is
 *        REMOVED before publication — with the removal counted, because a suppression nobody can see is
 *        indistinguishable from a class that had no rows.
 *
 *   A refusal throws and names the path. It never writes a partial file: every check runs against the
 *   finished value before the file is opened.
 */

import { writeFile } from "@mailwoman/platform/fs/promises"

import type { PremiseLinkageReport, PremiseLinkageResultRow } from "./schema.ts"
import { PREMISE_LINKAGE_SHAPE_CLASSES } from "./schema.ts"

/**
 * Why the writer refused. A closed set, so a caller can branch on the reason without reading the message.
 */
export const PremiseLinkageRedactionReason = {
	UnknownKey: "unknown_key",
	AddressShape: "address_shape",
	IdentifierShape: "identifier_shape",
	InputSubstring: "input_substring",
	UnpublishableCoordinate: "unpublishable_coordinate",
	RunBelowMinimum: "run_below_minimum",
} as const

export type PremiseLinkageRedactionReason =
	(typeof PremiseLinkageRedactionReason)[keyof typeof PremiseLinkageRedactionReason]

/**
 * A refusal to publish, naming the value that caused it. The message carries the PATH and the reason, never the
 * offending value — an error message is a log line, and a log line is a disclosure.
 */
export class PremiseLinkageRedactionError extends Error {
	readonly path: string
	readonly reason: PremiseLinkageRedactionReason

	constructor(path: string, reason: PremiseLinkageRedactionReason, detail: string) {
		super(`premise-linkage: refusing to write the report — ${detail} at ${path} [${reason}]`)
		this.name = "PremiseLinkageRedactionError"
		this.path = path
		this.reason = reason
	}
}

/**
 * Every key the publishable report may carry, flattened. A flat set rather than a path-aware schema on purpose: the
 * question it answers is "is this name one we designed", and a name nobody designed is refused wherever it appears.
 */
const REPORT_KEY_ALLOWLIST: ReadonlySet<string> = new Set<string>([
	"mode",
	"mailwomanVersion",
	"policy",
	"minCellSize",
	"suppressedCells",
	"arms",
	"comparison",
	"arm",
	"providerName",
	"providerDatasetVersion",
	"rowsRead",
	"erroredOverAll",
	"overall",
	"perClass",
	"coordinateThresholds",
	"exactOverEligible",
	"wrongOverEligible",
	"refusedOverAll",
	"ambiguousOverAll",
	"thresholdM",
	"withinThreshold",
	"baselineArm",
	"candidateArm",
	"changed",
	"improved",
	"regressed",
	"n",
	"of",
	...PREMISE_LINKAGE_SHAPE_CLASSES,
])

/**
 * A house number followed by a name — the shape of every street address in the registers this harness grades against,
 * and the shape no aggregate field has any reason to hold.
 */
const ADDRESS_SHAPE = /\d+\s+\p{L}/u

/**
 * A digit run long enough to be an authoritative object identifier (a UPRN reaches twelve).
 *
 * The cost of this check is that a dataset version written as a bare eight-digit date is refused. That is the intended
 * trade: a version string can be given a non-bare form in one edit, and a leaked identifier cannot be recalled.
 */
const IDENTIFIER_SHAPE = /\d{8,}/u

function checkString(value: string, path: string, inputs: readonly string[]): void {
	// Checked FIRST because it is the only one of the three that proves a disclosure rather than
	// suspecting one: this exact string was read from the controlled file during this run.
	const haystack = value.toLowerCase()

	for (const input of inputs) {
		if (input.length && haystack.includes(input.toLowerCase())) {
			throw new PremiseLinkageRedactionError(
				path,
				PremiseLinkageRedactionReason.InputSubstring,
				"a string containing an input this run read"
			)
		}
	}

	if (ADDRESS_SHAPE.test(value)) {
		throw new PremiseLinkageRedactionError(
			path,
			PremiseLinkageRedactionReason.AddressShape,
			"a string in the shape of a street address"
		)
	}

	if (IDENTIFIER_SHAPE.test(value)) {
		throw new PremiseLinkageRedactionError(
			path,
			PremiseLinkageRedactionReason.IdentifierShape,
			"a digit run in the shape of an authoritative identifier"
		)
	}
}

function walkPublishable(value: unknown, path: string, inputs: readonly string[]): void {
	if (typeof value === "string") {
		checkString(value, path, inputs)

		return
	}

	if (Array.isArray(value)) {
		value.forEach((entry, index) => walkPublishable(entry, `${path}[${index}]`, inputs))

		return
	}

	if (typeof value !== "object" || value === null) return

	for (const [key, entry] of Object.entries(value)) {
		const keyPath = `${path}.${key}`

		if (!REPORT_KEY_ALLOWLIST.has(key)) {
			throw new PremiseLinkageRedactionError(
				keyPath,
				PremiseLinkageRedactionReason.UnknownKey,
				"a key this report schema does not declare"
			)
		}

		walkPublishable(entry, keyPath, inputs)
	}
}

/**
 * What the preflight reads. The rows and the inputs are CHECKED and never written — they are how the writer knows what
 * the report was computed from.
 */
export interface PremiseLinkagePreflightInput {
	report: PremiseLinkageReport
	rows: readonly PremiseLinkageResultRow[]
	inputs: readonly string[]
}

/**
 * Remove per-class cells and coordinate rows measured over fewer than `minCellSize` rows, and count the removals.
 *
 * A per-class cell's size is the number of rows in that class — `refusedOverAll.of`, which is the only denominator on
 * the rates measured over every row of the class rather than a subset of it.
 */
function suppressSmallCells(report: PremiseLinkageReport): PremiseLinkageReport {
	const minimum = report.minCellSize
	let suppressed = 0

	const arms = report.arms.map((arm) => {
		const perClass: PremiseLinkageReport["arms"][number]["perClass"] = {}

		for (const shapeClass of PREMISE_LINKAGE_SHAPE_CLASSES) {
			const rates = arm.perClass[shapeClass]

			if (!rates) continue

			if (rates.refusedOverAll.of < minimum) {
				suppressed++

				continue
			}

			perClass[shapeClass] = rates
		}

		const coordinateThresholds = arm.coordinateThresholds.filter((entry) => {
			if (entry.withinThreshold.of >= minimum) return true

			suppressed++

			return false
		})

		return { ...arm, perClass, coordinateThresholds }
	})

	return { ...report, arms, suppressedCells: suppressed }
}

function checkRows(rows: readonly PremiseLinkageResultRow[]): void {
	rows.forEach((row, index) => {
		if (!row.coordinatePublishable && row.coordinateErrorM !== undefined) {
			throw new PremiseLinkageRedactionError(
				`rows[${index}].coordinateErrorM`,
				PremiseLinkageRedactionReason.UnpublishableCoordinate,
				"a coordinate error on a row whose terms forbid publishing one"
			)
		}
	})
}

/**
 * Suppress, check, and return the report that may leave the controlled environment. Throws before producing anything
 * when the run cannot be published.
 */
export function publishableReport(input: PremiseLinkagePreflightInput): PremiseLinkageReport {
	const smallestPublishableRun = input.report.minCellSize
	const rowsRead = input.report.arms[0]?.rowsRead ?? 0

	if (rowsRead < smallestPublishableRun) {
		throw new PremiseLinkageRedactionError(
			"arms[0].rowsRead",
			PremiseLinkageRedactionReason.RunBelowMinimum,
			`a run of ${rowsRead} rows below the agreed minimum cell size of ${smallestPublishableRun}`
		)
	}

	checkRows(input.rows)
	const suppressed = suppressSmallCells(input.report)

	walkPublishable(suppressed, "report", input.inputs)

	return suppressed
}

/**
 * Write the publishable report as JSON. One `writeFile` after every check, so a refusal leaves no file behind.
 */
export async function writePremiseLinkageReport(
	path: string,
	input: PremiseLinkagePreflightInput
): Promise<PremiseLinkageReport> {
	const report = publishableReport(input)

	await writeFile(path, `${JSON.stringify(report, null, "\t")}\n`, "utf8")

	return report
}
