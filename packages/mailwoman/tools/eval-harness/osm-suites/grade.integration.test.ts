/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker pool `gradeOSMSuite` runs returns, for every suite row, the outcome the held-out scorer gives
 *   the same row parsed in this process with the same weights.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { isPresent } from "@mailwoman/core/objects"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { resolveWeights } from "@mailwoman/neural/weights"
import { describe, expect, it } from "vitest"

import {
	type HeldoutRowOutcome,
	heldoutWeightsLocale,
	readHeldoutLocalePackages,
	scoreHeldoutRow,
} from "#tools/eval-harness/heldout/per/country"
import { renderOSMExtractRecord } from "#tools/eval-harness/osm-suites/extract"
import { gradeOSMSuite, totalSuiteOutcomes } from "#tools/eval-harness/osm-suites/grade"

async function weightsPresent(): Promise<boolean> {
	try {
		return await pathExists((await resolveWeights({ locale: "en-us" })).modelPath)
	} catch {
		return false
	}
}

const RECORDS: ReadonlyArray<[string, Record<string, string>]> = [
	[
		"US",
		{ street: "Main Street", number: "302", unit: "STE 302", city: "Springfield", province: "IL", postcode: "62701" },
	],
	["US", { street: "Oak Street", number: "9", city: "Springfield", province: "IL", postcode: "62702" }],
	["US", { street: "Pennsylvania Avenue NW", number: "1600", city: "Washington", province: "DC", postcode: "20500" }],
	["PK", { number: "12", place: "DHA Phase 6", city: "Karachi" }],
	["PK", { street: "Jinnah Avenue", number: "5", city: "Islamabad" }],
]

describe.skipIf(!(await weightsPresent()))("gradeOSMSuite", () => {
	it("parses every row across worker threads as one in-process parse scores it", async () => {
		const rows = RECORDS.map(([country, record]) => renderOSMExtractRecord(record, country, {})).filter(isPresent)

		expect(rows.map((row) => row.country)).toEqual(RECORDS.map(([country]) => country))

		const packages = await readHeldoutLocalePackages()

		const pooled = await Array.fromAsync(
			gradeOSMSuite(rows, { cacheRoot: null, packages: [...packages.entries()], intraOpNumThreads: 1 }, 2)
		)

		const classifiers = new Map<string, Promise<NeuralAddressClassifier>>()
		const inProcess: HeldoutRowOutcome[] = []

		for (const row of rows) {
			const locale = heldoutWeightsLocale(row.country, packages)
			let classifier = classifiers.get(locale)

			if (!classifier) {
				classifier = NeuralAddressClassifier.loadFromWeights({ locale, intraOpNumThreads: 1 })
				classifiers.set(locale, classifier)
			}

			const tree = await (
				await classifier
			).parse(row.raw, {
				postcodeRepair: true,
				...(row.country ? { localeHint: row.country } : {}),
			})

			inProcess.push(scoreHeldoutRow(row, tree))
		}

		const byRow = (outcomes: readonly HeldoutRowOutcome[]) =>
			outcomes.toSorted((a, b) => a.rowID.localeCompare(b.rowID))

		// Outcomes arrive in completion order, one per row.
		expect(byRow(pooled)).toEqual(byRow(inProcess))

		const totals = totalSuiteOutcomes(pooled)

		expect(totals.map((total) => [total.country, total.rows])).toEqual([
			["PK", 2],
			["US", 3],
		])

		expect(totals.reduce((sum, total) => sum + total.exact, 0)).toBe(
			inProcess.filter((outcome) => outcome.exact).length
		)
	}, 300_000)
})
