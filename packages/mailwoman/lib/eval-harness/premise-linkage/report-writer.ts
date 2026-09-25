/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes the premise-linkage report after checking the serialized values for leaked data.
 */

import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import type { PathBuilderLike } from "path-ts"

import type { PremiseLinkageReport, PremiseLinkageResultRow } from "#eval-harness/premise-linkage/schema"
import { PREMISE_LINKAGE_SHAPE_CLASSES } from "#eval-harness/premise-linkage/schema"

/**
 * Reasons the writer can refuse a report.
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
 * Error thrown when the report fails a redaction check.
 *
 * The message holds the path and reason only.
 * It omits the offending value because error messages end up in logs.
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
 * Every key the publishable report may carry, at any depth.
 *
 * The writer refuses any key outside this set, so a field added later cannot leak data
 * until someone adds it here.
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
 * Matches a house number followed by a word, which is the shape of a street address.
 */
const ADDRESS_SHAPE = /\d+\s+\p{L}/u

/**
 * Matches a digit run long enough to be an authoritative identifier such as a UPRN.
 *
 * This also refuses a dataset version written as a bare eight-digit date.
 * Write such versions with separators instead.
 */
const IDENTIFIER_SHAPE = /\d{8,}/u

function checkString(value: string, path: string, inputs: readonly string[]): void {
	// The input check runs first because a match proves a disclosure.
	// The shape checks only suggest one.
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
 * Input to the preflight.
 *
 * The preflight checks `rows` and `inputs` but never writes them.
 */
export interface PremiseLinkagePreflightInput {
	report: PremiseLinkageReport
	rows: readonly PremiseLinkageResultRow[]
	inputs: readonly string[]
}

/**
 * Removes per-class cells and coordinate rows measured over fewer than `minCellSize` rows,
 * and records the count in `suppressedCells`.
 *
 * A per-class cell's size is `refusedOverAll.of`, because that rate is the one
 * measured over every row of the class.
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
 * Suppresses small cells, checks the result, and returns the report that may be published.
 *
 * @throws PremiseLinkageRedactionError when the run is too small or any check fails.
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
 * Writes the publishable report as JSON.
 *
 * All checks run before the write, so a refusal leaves no file behind.
 */
export async function writePremiseLinkageReport(
	path: PathBuilderLike,
	input: PremiseLinkagePreflightInput
): Promise<PremiseLinkageReport> {
	const report = publishableReport(input)

	await writeLocalJSONFile(report, path)

	return report
}
