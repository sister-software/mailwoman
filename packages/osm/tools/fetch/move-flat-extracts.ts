/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Move a flat directory of Geofabrik extracts into dated snapshot vintages, one vintage per file.
 *   `flat-extracts.ts` states how each file's vintage and region are chosen.
 *
 *   Without `--apply` the command prints, for each file, the vintage and region it would use, where each came
 *   from, and where the file would land, and it changes no file. With `--apply` it moves each file it can
 *   place, with its receipt, and refuses to start while any file's region is unsettled.
 *
 *   Usage:
 *     node packages/osm/tools/fetch/move-flat-extracts.ts --from <flat directory> \
 *       [--region berlin=europe/germany/berlin …] [--out-root <snapshot root>] [--apply]
 */

import { snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder } from "path-ts"

import { applyFlatExtractMove, describeFlatExtractMove, planFlatExtractMove } from "#tools/fetch/flat-extracts"

const { values } = parseArguments({
	options: {
		from: { type: "string" },
		region: { type: "string", multiple: true },
		"out-root": { type: "string" },
		apply: { type: "boolean" },
	},
})

if (!values.from) {
	throw new Error(
		"usage: move-flat-extracts --from <flat directory> [--region <leaf>=<geofabrik/path> …] [--out-root <dir>] [--apply]"
	)
}

const regions = new Map(
	(values.region ?? []).map((pair) => {
		const [leaf, region] = pair.split("=")

		if (!leaf || !region) {
			throw new Error(`--region ${pair}: expected <leaf>=<geofabrik/path>, such as berlin=europe/germany/berlin`)
		}

		return [leaf, region] as const
	})
)

const snapshotRoot = values["out-root"] ? PathBuilder.from(values["out-root"]) : snapshotSourcesRoot()
const moves = await planFlatExtractMove(values.from, snapshotRoot, regions)

for (const move of moves) {
	console.log(describeFlatExtractMove(move))
}

const unsettled = moves.filter((move) => !move.region)
const blocked = moves.filter((move) => move.blocked).length

console.log(
	`[osm] ${moves.length} extracts: ${moves.length - blocked} to move, ${blocked} not moved, ${unsettled.length} with no region`
)

if (!values.apply) {
	console.log("[osm] dry run; no file changed. Pass --apply to move them.")
} else {
	if (unsettled.length) {
		throw new Error(
			`--apply refused: ${unsettled.map((move) => move.leaf).join(", ")} have no region; pass --region <leaf>=<geofabrik/path> for each`
		)
	}

	const applied = await applyFlatExtractMove(moves, snapshotRoot, (line) => console.log(`[osm] ${line}`))

	console.log(`[osm] moved ${applied.length} extracts`)
}
