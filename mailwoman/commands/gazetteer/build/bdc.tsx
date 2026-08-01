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
 *
 *   `--provider-list-path` (3a Task 8, decision 6) opts INTO populating `bdc_provider` —
 *   `bdc_availability` itself is unaffected either way. When given, `parseProviderList`
 *   (`@mailwoman/filer/sdk`) streams the FCC provider-list CSV as `BuildBDCOptions.providers`, and
 *   filer.db (`--filer-db-path`, default `<data-root>/filer/filer.db`) is opened read-only to resolve
 *   each multi-FRN provider's primary FRN (`readFRNFilingCandidates` + `pickPrimaryFRN`, imported
 *   rather than reimplemented — see `build-bdc.ts`'s `BuildBDCOptions.filerDB` docstring). Omitting
 *   `--provider-list-path` leaves `bdc_provider` empty, exactly as before Task 8.
 *
 *   Both paths are `existsSync`-guarded BEFORE any download/build work starts (review fix round 1,
 *   IMPORTANT-2): `populateBDCProviderTable` only runs after `writeLayerManifest`, i.e. at the very END
 *   of a full build — an unguarded typo'd `--provider-list-path` would otherwise surface as a raw ENOENT
 *   only after a nationwide availability ingest had already finished, discarding hours of work.
 *   `--filer-db-path` given without `--provider-list-path` is a loud error, not a silent no-op (MINOR):
 *   filer.db is only ever read to resolve a multi-FRN primary FRN, so it does nothing without a provider
 *   list to resolve FRNs FOR.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import {
	BDCFileCategory,
	BDCFilingDataType,
	BDCProviderSubCategory,
	buildBDCDatabase,
	createBDCClient,
	createTIGERBlockCentroidLookup,
	downloadBDCFile,
	formatBDCThrottleStats,
	resolveLatestVintage,
	retrieveAvailabilityFiles,
	retrieveFilingDates,
} from "@mailwoman/bdc/sdk"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { dataRootPath } from "@mailwoman/core/utils"
import type { FilerDatabase } from "@mailwoman/filer"
import { parseProviderList } from "@mailwoman/filer/sdk"
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
	providerListPath: zod
		.string()
		.optional()
		.describe(
			"Path to the FCC BDC provider list CSV (frn/provider_id/holding_company). When given, populates " +
				"bdc_provider (decision 6, 3a task 8); omit to leave bdc_provider empty, as before task 8."
		),
	filerDbPath: zod
		.string()
		.optional()
		.describe(
			"Path to filer.db, used to resolve a multi-FRN provider's primary FRN when --provider-list-path is given. " +
				"Default <data-root>/filer/filer.db"
		),
})

export { OptionsSchema as options }

const GazetteerBuildBDC: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		// Fail-fast guards (review fix round 1, IMPORTANT-2 / MINOR) — checked BEFORE any network/download work
		// starts. `populateBDCProviderTable` only runs after the availability ingest AND writeLayerManifest, so
		// without this, a typo'd --provider-list-path would surface only at the very end of a full national
		// build, discarding hours of work for a check that costs microseconds up front.
		if (options.filerDbPath && !options.providerListPath) {
			throw new Error(
				"gazetteer build bdc: --filer-db-path was given without --provider-list-path — filer.db is only read " +
					"to resolve a multi-FRN provider's primary FRN, so it has no effect without a provider list. Pass " +
					"--provider-list-path too, or drop --filer-db-path."
			)
		}

		let filerDbPath: string | undefined

		if (options.providerListPath) {
			if (!existsSync(options.providerListPath)) {
				throw new Error(`gazetteer build bdc: --provider-list-path not found: "${options.providerListPath}"`)
			}

			filerDbPath = options.filerDbPath ?? dataRootPath("filer", "filer.db")

			if (!existsSync(filerDbPath)) {
				throw new Error(`gazetteer build bdc: filer.db not found at "${filerDbPath}" (--filer-db-path)`)
			}
		}

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

		// The FCC caps this API at ten requests per minute — six seconds a call — so a national run is
		// throttle-bound by construction and the interesting number is how much of the wall clock went to
		// waiting rather than transferring. Printed once the network phase is over, on stderr with the rest
		// of the progress stream, so a rate change can be assessed against a measurement.
		console.error(`▸ ${formatBDCThrottleStats(client.throttleStats())}`)

		const out = options.out ?? dataRootPath("bdc", "bdc.db")
		const buildSHA = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()
		const tigerDBPath = dataRootPath("tiger", "tiger.db")

		console.error(`▸ build: ${out}`)

		// --provider-list-path (3a Task 8, decision 6) opts into populating bdc_provider — omitted, `providers`/
		// `filerDB` stay undefined and buildBDCDatabase's default (byte-identical) path runs unchanged. Both
		// paths were already existsSync-validated above, so this can't ENOENT.
		let filerDB: DatabaseClient<FilerDatabase> | undefined

		if (filerDbPath) {
			console.error(`▸ provider list: ${options.providerListPath} (filer.db: ${filerDbPath})`)

			filerDB = new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(filerDbPath, { readOnly: true }) })
		}

		try {
			const result = await buildBDCDatabase({
				csvPaths,
				out,
				asOfDate,
				buildSHA,
				includeLocationIDs: options.includeLocationIds,
				blockCentroids: createTIGERBlockCentroidLookup(tigerDBPath),
				providers: options.providerListPath ? parseProviderList(options.providerListPath) : undefined,
				filerDB,
				onProgress: (message) => console.error(`  [bdc] ${message}`),
			})

			return [
				`bdc.db: ${out} (${artifactSizeMB(out)} MB)`,
				`${result.rows.toLocaleString()} rows · ${result.providers} provider(s) · ${result.deduped.toLocaleString()} deduped` +
					` · ${result.unknownGeoids.toLocaleString()} unknown geoid(s) · ${result.coverageCells.toLocaleString()} coverage cells` +
					(options.providerListPath ? ` · ${result.providersPopulated.toLocaleString()} bdc_provider row(s)` : ""),
				`manifest: name=bdc tier=shipped license=public-domain source=fcc-bdc sourceVintage=${asOfDate} buildSHA=${buildSHA}`,
			]
		} finally {
			await filerDB?.destroy()
		}
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
