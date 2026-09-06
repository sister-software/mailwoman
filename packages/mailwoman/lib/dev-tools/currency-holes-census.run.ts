/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The currency check's census (#1746): what the resurrection judges per country on the shipped dead-row query
 *   (`locality`), and what widening it to `localadmin` admits — read on the admin gazetteer and the GeoNames dumps
 *   with the check's own function in dry-run, so the count is the build's arithmetic and not a second copy of it.
 *
 *   Usage: node packages/mailwoman/lib/dev-tools/currency-holes-census.run.ts [--admin <admin-global-priority.db>]
 *   [--geonames <dir>] [--countries GB,DE,FR,IT,US] [--json <out>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	type CurrencyBackfillCountryReport,
	DEFAULT_DEAD_PLACETYPES,
	resurrectCurrencyHoles,
} from "@mailwoman/resolver-wof-sqlite/currency-backfill"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

const ARMS: ReadonlyArray<{ name: string; deadPlacetypes: readonly string[] }> = [
	{ name: "shipped", deadPlacetypes: DEFAULT_DEAD_PLACETYPES },
	{ name: "+localadmin", deadPlacetypes: [...DEFAULT_DEAD_PLACETYPES, "localadmin"] },
]

async function main(): Promise<void> {
	const { values } = parseArguments({
		options: {
			admin: { type: "string" },
			geonames: { type: "string" },
			countries: { type: "string", default: "GB,DE,FR,IT,US" },
			json: { type: "string" },
		},
	})

	const adminPath = values.admin ?? String(dataRootPath("wof", "admin-global-priority.db"))
	const geonamesDir = values.geonames ?? String(dataRootPath("geonames"))
	const countries = values.countries!.split(",").map((code) => code.trim().toUpperCase())
	using src = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })
	const reports: Array<CurrencyBackfillCountryReport & { arm: string }> = []

	for (const arm of ARMS) {
		await resurrectCurrencyHoles({
			src,
			geonamesDir,
			countries,
			attrs: new Map(),
			ccID: () => 0,
			ptID: () => 0,
			regionOf: new Map(),
			importance: undefined,
			stageRow: () => {},
			progress: (phase, message) => console.error(`[${phase}] ${arm.name}: ${message}`),
			deadPlacetypes: arm.deadPlacetypes,
			dryRun: true,
			onCountry: (report) => reports.push({ ...report, arm: arm.name }),
		})
	}

	console.log(
		"country  arm          judged  blocked  unattested  floored  resurrected  (localadmin: judged/resurrected)"
	)

	for (const report of reports) {
		const la = report.byDeadPlacetype["localadmin"]

		console.log(
			`${report.country.padEnd(8)} ${report.arm.padEnd(12)} ${String(report.judged).padStart(6)}  ${String(report.blocked).padStart(7)}  ` +
				`${String(report.unattested).padStart(10)}  ${String(report.floored).padStart(7)}  ${String(report.resurrected).padStart(11)}` +
				`  ${la ? `(${la.judged}/${la.resurrected})` : report.dumpPresent ? "" : "(no dump)"}`
		)
	}

	for (const report of reports) {
		if (report.sample.length) {
			console.log(`${report.country} ${report.arm}: ${report.sample.join(", ")}`)
		}
	}

	if (values.json) {
		await writeLocalJSONFile(reports, values.json)
	}
}

runIfScript(import.meta, main)
