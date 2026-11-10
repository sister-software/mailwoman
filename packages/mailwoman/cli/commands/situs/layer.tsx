/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Builds the US address layer from NAD, Overture and the admitted OpenAddresses runs.
 */

import { OVERTURE_ADDRESSES_RELEASE } from "@mailwoman/core/overture-pins"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Declares the options of `mailwoman situs layer`.
 */
export const spec = {
	name: "layer",
	description: "Build the US address layer, one lookup.db and detail.db per state",
	options: {
		"layer-version": { type: "string", description: "The layer version, an ISO date such as 2026-11-08" },
		"base-version": {
			type: "string",
			description:
				"The published version whose regions a new version's first build keeps for the states it does not rebuild",
		},
		states: { type: "string", description: "Comma-separated USPS state codes to build (default: every state and DC)" },
		omit: {
			type: "string",
			description: "Comma-separated regions to build but leave out of the manifest, such as us-hi",
		},
		release: {
			type: "string",
			default: OVERTURE_ADDRESSES_RELEASE,
			description: "Overture release whose addresses-us.parquet supplies the non-NAD rows",
		},
		plan: { type: "string", description: "OpenAddresses plan JSON listing each run's member and recorded license" },
	},
} as const satisfies CommandSpec

/**
 * Builds every requested state's address layer under `db/addresses/us-<state>/<version>/`
 * and writes the US manifest, printing each state's record counts by source.
 */
const SitusAddressLayer: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const version = options.layerVersion

		if (!version || !/^\d{4}-\d{2}-\d{2}$/u.test(version)) {
			throw new CommandError("--layer-version is required, as an ISO date such as 2026-11-08")
		}

		if (!options.plan) throw new CommandError("--plan is required: the OpenAddresses plan JSON")

		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")
		const { repoRootPath } = await import("@mailwoman/core/paths")
		const { buildSHA } = await import("@mailwoman/gazetteer/tools/pipeline/stamp-manifest")
		const { nadReleaseParquetPath } = await import("@mailwoman/corpus/us/tools/fetch/nad")
		const { buildUSAddressLayer } = await import("@mailwoman/corpus/us/address-records/layer")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")

		const lines: string[] = []

		const result = await buildUSAddressLayer({
			root: dataRootPath("db"),
			version,
			...(options.baseVersion ? { baseVersion: options.baseVersion } : {}),
			nadParquet: await nadReleaseParquetPath(dataRootPath("corpus", "sources")),
			overtureParquet: dataRootPath("overture", options.release, "addresses-us.parquet"),
			openAddresses: { plan: await readLocalJSONFile(options.plan), cache: dataRootPath("oa-cache") },
			...(options.states ? { states: extractDelimited(options.states) } : {}),
			...(options.omit ? { omitFromManifest: extractDelimited(options.omit) } : {}),
			buildSHA: buildSHA(repoRootPath()),
			adminDatabase: wofDatabasePath("admin-global-priority.db"),
			onState: (build) => {
				const refused: Record<string, number> = {}

				for (const reasons of Object.values(build.refused)) {
					for (const [reason, count] of Object.entries(reasons)) {
						refused[reason] = (refused[reason] ?? 0) + count
					}
				}

				const refusedText = Object.entries(refused)
					.map(([reason, count]) => `${count.toLocaleString()} ${reason}`)
					.join(", ")

				const line =
					`${build.state}: ${build.records.toLocaleString()} records ` +
					`(NAD ${build.nad.toLocaleString()}, Overture ${build.overture.toLocaleString()}, ` +
					`OpenAddresses ${build.openAddresses.toLocaleString()} from ${build.runs} runs) in ${build.seconds} s` +
					(refusedText ? `; refused ${refusedText}` : "")

				lines.push(line)

				console.error(line)
			},
		})

		lines.push(
			`runs refused by license: ${result.refusedRuns}; runs absent from the cache: ${result.missingRuns}`,
			`manifest: ${result.manifest}`
		)

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default SitusAddressLayer
