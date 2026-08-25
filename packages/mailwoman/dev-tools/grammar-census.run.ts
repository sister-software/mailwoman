/**
 * Report-only C6 census over the committed Gauntlet corpus. This command is not a release gate.
 */

import { writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { allRows } from "@mailwoman/core/utils"
import { findFSTAcceptedMatches } from "@mailwoman/neural/fst-prior"
import { normalizeLocalityForKey } from "@mailwoman/resolver-wof-sqlite/street-normalize"

import { loadRegressionCases } from "../eval-harness/gauntlet/cases/load.ts"
import { buildGauntletDeps } from "../eval-harness/gauntlet/harness.ts"
import {
	type C6RowReport,
	completeSpanRegistryReceipt,
	detectC6Violations,
	gradeBoundaryTruth,
	locateUniqueComponentTruth,
	spansFromBIO,
	summarizeC6,
} from "../eval-harness/grammar-census.ts"
import { resolveCandidateDBPath } from "../resolver-backend.ts"

const TARGET_IDS = [
	"tt-cs-port-of-spain",
	"ad-cs-andorra-la-vella",
	"il-cs-tel-aviv-yafo",
	"my-cs-petaling-jaya",
] as const

const { values } = parseArgs({ options: { "out-json": { type: "string" } } })
const cases = await loadRegressionCases()
const deps = await buildGauntletDeps()
const reports: C6RowReport[] = []
const candidateDBPath = resolveCandidateDBPath()
const candidateDB = candidateDBPath ? new DatabaseSync(candidateDBPath, { readOnly: true }) : undefined

interface CandidateLocalityRow {
	spr_id: number
	name: string
	population: number | null
	is_primary: number | null
}

const candidateLocalities = candidateDB
	? candidateDB.prepare(
			"SELECT c.spr_id, c.name, c.population, c.is_primary FROM candidate c " +
				"JOIN placetype_codes p ON p.id = c.placetype_id WHERE c.name_key = ? AND p.placetype = 'locality' " +
				"ORDER BY c.neg_rank ASC LIMIT 20"
		)
	: undefined

function sourceGazetteerReceipt(input: string): C6RowReport["sourceGazetteer"] {
	if (!candidateDBPath || !candidateLocalities) return undefined
	const key = normalizeLocalityForKey(input)
	// Hyphen is a possible decoded boundary (`Tel Aviv-Yafo`). Generate surface subspans, then pass every one through the
	// candidate table's shared fold; do not infer keys by editing the folded complete key.
	const surfaceWords = input.split(/[\s-]+/u).filter((word) => word.length > 0)
	const nestedKeys = new Set<string>()

	for (let start = 0; start < surfaceWords.length; start++) {
		for (let end = start + 1; end <= surfaceWords.length; end++) {
			const surface = surfaceWords.slice(start, end).join(" ")
			const nestedKey = normalizeLocalityForKey(surface)

			if (nestedKey === key) continue
			nestedKeys.add(nestedKey)
		}
	}

	const project = (row: CandidateLocalityRow) => ({
		wofID: Number(row.spr_id),
		name: String(row.name),
		population: row.population === null ? null : Number(row.population),
		primary: row.is_primary === 1,
	})

	const exactLocalities = allRows<CandidateLocalityRow>(candidateLocalities, key).map(project)

	const nestedLocalities = [...nestedKeys]
		.map((nestedKey) => ({
			key: nestedKey,
			rows: allRows<CandidateLocalityRow>(candidateLocalities, nestedKey).map(project),
		}))
		.filter((receipt) => receipt.rows.length > 0)

	return { databasePath: candidateDBPath, key, exactLocalities, nestedLocalities }
}

try {
	for (const row of cases) {
		const overlayCountry = row.locale?.split("-")[1] ?? row.country
		const diagnostic = await deps.diagnoseParse(row.input, { caseCountry: overlayCountry })
		const truth = locateUniqueComponentTruth(row.input, row.expectComponents ?? {})

		if (!diagnostic.fst) {
			reports.push({ id: row.id, input: row.input, fstAvailable: false, violations: [] })

			continue
		}

		const matches = findFSTAcceptedMatches(diagnostic.fst, diagnostic.trace.pieces)
		const required = TARGET_IDS.includes(row.id as (typeof TARGET_IDS)[number])

		const violations = detectC6Violations(spansFromBIO(diagnostic.trace.tokens), matches).map((violation) => {
			const boundaryCharacter = diagnostic.trace.pieces[violation.boundary]?.start ?? diagnostic.trace.text.length

			return { ...violation, boundaryCharacter, grade: gradeBoundaryTruth(boundaryCharacter, truth) }
		})

		reports.push({
			id: row.id,
			input: row.input,
			fstAvailable: true,
			violations,
			...(required
				? { completeSpanRegistry: completeSpanRegistryReceipt(matches, diagnostic.trace.pieces.length) }
				: {}),
			...(required ? { sourceGazetteer: sourceGazetteerReceipt(row.input) } : {}),
		})
	}
} finally {
	deps.close()
	candidateDB?.close()
}

const summary = summarizeC6(reports)

console.log(
	`C6 detector: ${summary.rows} board rows; FST available ${summary.rowsWithFST}/${summary.rows}; ` +
		`${summary.rowsFlagged}/${summary.rows} rows flagged; ${summary.boundariesFlagged} boundary receipts ` +
		`(${summary.truePositive} TP, ${summary.falsePositive} FP, ${summary.unclassified} unclassified).`
)

for (const report of reports.filter((row) => row.violations.length > 0).slice(0, 20)) {
	console.log(`${report.id}: ${report.input}`)

	for (const violation of report.violations.slice(0, 3)) {
		console.log(
			`  char ${violation.boundaryCharacter}: ${violation.left.tag}|${violation.right.tag}, ` +
				`nested ${violation.nestedSide}, ${violation.grade}; referential covering=${violation.coveringReferential ?? "absent"}, ` +
				`nested=${violation.nestedReferential}, delta=${violation.referentialDelta ?? "absent"}`
		)
	}
}

console.log("Required-row coverage:")

for (const id of TARGET_IDS) {
	const report = reports.find((row) => row.id === id)

	if (!report) {
		console.log(`  ${id}: MISSING FROM BOARD`)
	} else {
		const scores = report.completeSpanRegistry
		const source = report.sourceGazetteer

		console.log(
			`  ${id}: FST=${report.fstAvailable ? "yes" : "no"}, violations=${report.violations.length}, ` +
				`best complete=${scores?.bestCoveringReferential ?? "absent"}, best nested=${scores?.bestNestedReferential ?? "absent"}, ` +
				`delta=${scores?.referentialDelta ?? "absent"}; candidate.db key=${source?.key ?? "unavailable"}, ` +
				`exact locality rows=${source?.exactLocalities.length ?? "unavailable"}, ` +
				`nested locality keys=${source?.nestedLocalities.map((entry) => entry.key).join(",") || "none"}, input=${report.input}`
		)
	}
}

if (values["out-json"]) {
	await writeFile(
		values["out-json"],
		`${JSON.stringify({ summary, requiredIDs: TARGET_IDS, rows: reports }, null, 2)}\n`
	)
}
