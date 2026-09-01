/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build nz-localities` — the NZ suburb/locality database (#1564, #1585's data
 *   half) from the LINZ-derived OpenAddresses countrywide extract (CC-BY 4.0, attribution LINZ).
 *   Sealed 0444. The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "nz-localities",
	description: "Build the New Zealand locality database.",
	options: {
		csv: {
			type: "string",
			description: "LINZ-derived OA NZ countrywide CSV. Default <data-root>/openaddresses/extracted/nz/countrywide.csv",
		},
		out: { type: "string", description: "Output database. Default <data-root>/wof/localities-nz-linz.db" },
	},
} as const satisfies CommandSpec

interface Options {
	csv?: string
	out?: string
}

const GazetteerBuildNZLocalities: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildNZLocalitiesDatabase } = await import("#gazetteer/nz-localities")
		const r = await buildNZLocalitiesDatabase({ csvPath: options.csv, out: options.out })

		return `nz-localities: ${r.inserted.toLocaleString()} locality rows (skipped ${r.skippedGroups} thin groups, source md5 ${r.sourceMD5.slice(0, 8)}) → ${r.out} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildNZLocalities
