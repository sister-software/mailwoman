/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build bdc` — the FCC BDC availability ingest + sealed `bdc.db` layer build
 *   (2a Task 8). Thin wiring only: list → download → build lives in `@mailwoman/bdc/sdk`
 *   (`buildBDCDatabase`, list-files.ts, download.ts), so it stays unit-testable without Ink/Pastel or
 *   network in the loop. Mirrors `poi.tsx`'s progress (stderr) / summary (stdout) split.
 *
 *   First cut wires Fixed Broadband provider availability only (the primary wireline dataset) — mobile
 *   broadband/voice subcategories are a future flag, not a scope gap in this command's shape.
 */

import { execFileSync } from "node:child_process"

import {
	BDCFileCategory,
	BDCFilingDataType,
	BDCProviderSubCategory,
	buildBDCDatabase,
	createBDCClient,
	createTIGERBlockCentroidLookup,
	downloadBDCFile,
	resolveLatestVintage,
	retrieveAvailabilityFiles,
	retrieveFilingDates,
} from "@mailwoman/bdc/sdk"
import { dataRootPath } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import { artifactSizeMB } from "../../../gazetteer-pipeline/admin/index.ts"

const OptionsSchema = zod.object({
	state: zod.string().describe('2-digit FCC state/territory FIPS code (e.g. "06" for California)'),
	asOfDate: zod.string().optional().describe("FCC filing as_of_date (YYYY-MM-DD). Default: latest available"),
	out: zod.string().optional().describe("bdc.db output path. Default <data-root>/bdc/bdc.db"),
	includeLocationIds: zod
		.boolean()
		.default(false)
		.describe("Populate bdc_availability.location_id (opaque BSL join key; NULL by default)"),
})

export { OptionsSchema as options }

const GazetteerBuildBDC: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const client = createBDCClient()

		let asOfDate = options.asOfDate

		if (!asOfDate) {
			console.error("▸ resolving latest as_of_date...")

			const dates = await retrieveFilingDates(client, { filingType: BDCFilingDataType.Availability })
			asOfDate = resolveLatestVintage(dates, BDCFilingDataType.Availability)
		}

		console.error(`▸ as-of-date: ${asOfDate}`)

		const files = await retrieveAvailabilityFiles(client, {
			asOfDate,
			category: BDCFileCategory.Provider,
			subcategory: BDCProviderSubCategory.FixedBroadband,
		})

		const stateFiles = files.filter((file) => file.stateCode === options.state)

		console.error(`▸ ${stateFiles.length} provider file(s) for state ${options.state} @ ${asOfDate}`)

		const cacheDir = dataRootPath("bdc", "cache", "availability", asOfDate, options.state)
		const csvPaths: string[] = []

		for (const file of stateFiles) {
			console.error(`  downloading ${file.fileName}...`)

			csvPaths.push(await downloadBDCFile(client, file, cacheDir))
		}

		const out = options.out ?? dataRootPath("bdc", "bdc.db")
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()
		const tigerDBPath = dataRootPath("tiger", "tiger.db")

		console.error(`▸ build: ${out}`)

		const result = await buildBDCDatabase({
			csvPaths,
			out,
			asOfDate,
			buildSHA,
			includeLocationIDs: options.includeLocationIds,
			blockCentroids: createTIGERBlockCentroidLookup(tigerDBPath),
			onProgress: (message) => console.error(`  [bdc] ${message}`),
		})

		return [
			`bdc.db: ${out} (${artifactSizeMB(out)} MB)`,
			`${result.rows.toLocaleString()} rows · ${result.providers} provider(s) · ${result.deduped.toLocaleString()} deduped` +
				` · ${result.unknownGeoids.toLocaleString()} unknown geoid(s) · ${result.coverageCells.toLocaleString()} coverage cells`,
			`manifest: name=bdc tier=shipped license=public-domain source=fcc-bdc sourceVintage=${asOfDate} buildSHA=${buildSHA}`,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildBDC
