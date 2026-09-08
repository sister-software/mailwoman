/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build tw-districts` — Taiwan's 鄉鎮市區 locality database from the Overture Maps addresses
 *   parquet (the civil-affairs registers, CDLA-Permissive-2.0 AND OGDL-Taiwan-1.0), each row scoped to its 縣市's WOF
 *   region. Sealed 0444. The pipeline module is lazy-imported so `--help` never faults without the optional
 *   `@mailwoman/resolver-wof-sqlite` peer or the DuckDB dev dependency.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "tw-districts",
	description: "Build the Taiwan 鄉鎮市區 locality database.",
	options: {
		release: { type: "string", description: "Overture release directory. Default 2026-06-17.0" },
		parquet: {
			type: "string",
			description: "Taiwan addresses parquet. Default <data-root>/overture/<release>/addresses-tw.parquet",
		},
		admin: { type: "string", description: "Admin WOF database. Default <data-root>/wof/admin-global-priority.db" },
		out: { type: "string", description: "Output database. Default <data-root>/wof/localities-tw-districts.db" },
		threads: { type: "string", description: "DuckDB thread cap" },
	},
} as const satisfies CommandSpec

interface Options {
	release?: string
	parquet?: string
	admin?: string
	out?: string
	threads?: string
}

const GazetteerBuildTWDistricts: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildTWDistrictsDatabase } = await import("#gazetteer/tw-districts")

		const r = await buildTWDistrictsDatabase({
			release: options.release,
			parquetPath: options.parquet,
			adminPath: options.admin,
			out: options.out,
			threads: options.threads && /^\d+$/.test(options.threads) ? Number(options.threads) : undefined,
		})

		const lines = [
			`tw-districts: ${r.inserted} district rows, ${r.scoped} scoped to a WOF region (source md5 ${r.sourceMD5.slice(0, 8)}) → ${r.out} — sealed 0444`,
		]

		if (r.smallest) {
			lines.push(`smallest unit: ${r.smallest.region}${r.smallest.district} (${r.smallest.points} points)`)
		}

		for (const u of r.unmatchedRegions) {
			lines.push(`no WOF region answers to ${u.region}: ${u.groups} district rows folded unscoped`)
		}

		return lines.join("\n")
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildTWDistricts
