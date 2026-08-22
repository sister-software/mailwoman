/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build gnaf-rooftop` — the AU rooftop address-point shard from Geoscape
 *   G-NAF (CC-BY-4.0, attribution Geoscape Australia), emitted into the `OSMShardProvider` home so
 *   the situs tier serves AU with zero runtime changes. Sealed 0444. The pipeline module is
 *   lazy-imported so `--help` never faults without the optional `@mailwoman/osm` /
 *   `@mailwoman/resolver-wof-sqlite` peers.
 */

import { Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "gnaf-rooftop",
	description: "Build the Australian G-NAF rooftop address-point shard.",
	options: {
		"standard-dir": {
			type: "string",
			description: "Extracted G-NAF Standard/ PSV directory. Default <data-root>/gnaf/may26/extracted/…/Standard",
		},
		out: { type: "string", description: "Output shard. Default <data-root>/osm/address-points-au-au.db" },
		states: {
			type: "string",
			description: "Comma-separated state prefixes (e.g. ACT,NSW) — the smoke rung. Default all",
		},
		release: { type: "string", description: "G-NAF release tag for provenance. Default may26-gda2020" },
		"build-sha": { type: "string", required: true, description: "Git SHA recorded in the layer manifest" },
		"created-at": {
			type: "string",
			required: true,
			description: "ISO-8601 build timestamp — the builder never invents provenance time",
		},
	},
} as const satisfies CommandSpec

interface Options {
	standardDir?: string
	out?: string
	states?: string
	release?: string
	buildSha: string
	createdAt: string
}

const GazetteerBuildGNAFRooftop: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildGNAFRooftopShard } = await import("#gazetteer/gnaf-rooftop")

		const r = await buildGNAFRooftopShard({
			standardDir: options.standardDir,
			out: options.out,
			states: options.states?.split(","),
			release: options.release,
			buildSHA: options.buildSha,
			createdAt: options.createdAt,
			log: (line) => console.error(line),
		})

		return (
			`gnaf-rooftop: ${r.written.toLocaleString()} address points → ${r.out} — sealed 0444 ` +
			`(alias ${r.alias.toLocaleString()}, retired ${r.retired.toLocaleString()}, ` +
			`no-number ${r.noNumber.toLocaleString()}, no-geocode ${r.noGeocode.toLocaleString()}, no-street ${r.noStreet.toLocaleString()})`
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">✓ {state.result}</Text>

	return null
}

export default GazetteerBuildGNAFRooftop
