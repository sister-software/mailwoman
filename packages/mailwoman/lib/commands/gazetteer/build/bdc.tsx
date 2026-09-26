/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   List → download → build lives in `@mailwoman/bdc/sdk`, so this stays thin and unit-testable without Ink or network
 *   in the loop; progress goes to stderr and the summary to stdout, mirroring `poi.tsx`.
 */

import { formatFileSize, pathExists } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import type { FilerDatabase } from "@mailwoman/filer"
import type { DatabaseClient as DatabaseClientHandle } from "@mailwoman/sqlite/client"
import { Box, Text } from "ink"
import { resolvePath, type PathBuilderLike } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import { buildSHA as resolveBuildSHA } from "#gazetteer-pipeline/stamp-manifest"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "bdc",
	description: "Build the FCC BDC database",
	options: {
		state: {
			type: "string",
			required: true,
			validate: (value: string) => /^\d{2}$/u.test(value),
			description: "FCC state FIPS code",
		},
		"as-of-date": { type: "string", description: "FCC filing date" },
		out: { type: "string", description: "bdc.db output path" },
		"include-location-ids": { type: "boolean", default: false, description: "Populate opaque location IDs" },
		"provider-list-path": { type: "string", description: "FCC BDC provider-list CSV" },
		"filer-db-path": { type: "string", description: "filer.db path" },
	},
} as const satisfies CommandSpec

const GazetteerBuildBDC: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const {
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
		} = await import("@mailwoman/bdc/sdk")

		const { DatabaseClient } = await import("@mailwoman/sqlite/client")
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { parseProviderList } = await import("@mailwoman/filer/sdk")

		// Fail-fast guard: `populateBDCProviderTable` runs only after the availability ingest
		// and `writeLayerManifest`, so a typo'd --provider-list-path would otherwise surface
		// at the end of a full national build, discarding hours of work.
		if (options.filerDBPath && !options.providerListPath) {
			throw new Error(
				"gazetteer build bdc: --filer-db-path was given without --provider-list-path — filer.db is only read " +
					"to resolve a multi-FRN provider's primary FRN, so it has no effect without a provider list. Pass " +
					"--provider-list-path too, or drop --filer-db-path."
			)
		}

		let filerDBPath: PathBuilderLike | undefined

		if (options.providerListPath) {
			if (!(await pathExists(options.providerListPath))) {
				throw new Error(`gazetteer build bdc: --provider-list-path not found: "${options.providerListPath}"`)
			}

			filerDBPath = options.filerDBPath ?? dataRootPath("filer", "filer.db")

			if (!(await pathExists(filerDBPath))) {
				throw new Error(`gazetteer build bdc: filer.db not found at "${filerDBPath}" (--filer-db-path)`)
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

		// The FCC caps this API at ten requests per minute, so a national run is throttle-bound
		// and this measurement says how much wall clock went to waiting rather than transferring.
		console.error(`▸ ${formatBDCThrottleStats(client.throttleStats())}`)

		const out = resolvePath(options.out ?? dataRootPath("bdc", "bdc.db"))
		const buildSHA = resolveBuildSHA(repoRootPath())
		const tigerDBPath = resolvePath(dataRootPath("tiger", "tiger.db"))

		console.error(`▸ build: ${out}`)

		let filerDB: DatabaseClientHandle<FilerDatabase> | undefined

		if (filerDBPath) {
			console.error(`▸ provider list: ${options.providerListPath} (filer.db: ${filerDBPath})`)

			filerDB = new DatabaseClient<FilerDatabase>(filerDBPath, { readOnly: true })
		}

		try {
			const result = await buildBDCDatabase({
				csvPaths,
				out,
				asOfDate,
				buildSHA,
				includeLocationIDs: options.includeLocationIDs,
				blockCentroids: await createTIGERBlockCentroidLookup(tigerDBPath),
				providers: options.providerListPath ? parseProviderList(options.providerListPath) : undefined,
				filerDB,
				onProgress: (message) => console.error(`  [bdc] ${message}`),
			})

			return [
				`bdc.db: ${out} (${await formatFileSize(out)})`,
				`${result.rows.toLocaleString()} rows · ${result.providers} provider(s) · ${result.deduped.toLocaleString()} deduped` +
					` · ${result.unknownGeoids.toLocaleString()} unknown geoid(s) · ${result.coverageCells.toLocaleString()} coverage cells` +
					(options.providerListPath ? ` · ${result.providersPopulated.toLocaleString()} bdc_provider row(s)` : ""),
				`manifest: name=bdc tier=shipped license=public-domain source=fcc-bdc sourceVintage=${asOfDate} buildSHA=${buildSHA}`,
			]
		} finally {
			await filerDB?.destroy()
		}
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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

	return null
}

export default GazetteerBuildBDC
