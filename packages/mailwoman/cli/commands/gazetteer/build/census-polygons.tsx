// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build census-polygons --state PR --out …` — a polygon database
 *   keyed by WOF id, from the Census TIGER/Line county, county subdivision and place
 *   boundaries whose GEOID a WOF record holds as its `uscensus:geoid` concordance.
 *   Sealed 0444.
 */

import { stringifyJSON } from "@mailwoman/core/json"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "census-polygons",
	description: "Build a WOF-keyed boundary file from Census TIGER/Line boundaries, joined by uscensus:geoid.",
	options: {
		state: { type: "string", multiple: true, required: true, description: "USPS state or territory code, repeatable" },
		out: {
			type: "string",
			required: true,
			description: "Output database, such as <data-root>/db/wof/wof-polygons-…db",
		},
		admin: { type: "string", description: "Admin gazetteer. Default: the live admin-global-priority.db" },
		vintage: { type: "string", description: "TIGER/Line vintage. Default 2024" },
		tolerance: { type: "string", description: "Simplification tolerance in degrees. Default 0.001" },
	},
} as const satisfies CommandSpec

const GazetteerBuildCensusPolygons: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const [{ buildCensusPolygonsDatabase }, { isStateLevelAbbreviation }] = await Promise.all([
			import("@mailwoman/gazetteer/tools/pipeline/us/census-polygons"),
			import("@mailwoman/tiger/state"),
		])

		const states = options.state.map((code) => code.toUpperCase())

		for (const code of states) {
			if (!isStateLevelAbbreviation(code))
				throw new Error(`census-polygons: ${code} is no USPS state or territory code`)
		}

		const { out, counts } = await buildCensusPolygonsDatabase({
			states: states.filter(isStateLevelAbbreviation),
			out: options.out,
			...(options.admin ? { adminPath: options.admin } : {}),
			...(options.vintage ? { vintage: Number(options.vintage) } : {}),
			...(options.tolerance ? { tolerance: Number(options.tolerance) } : {}),
		})

		return `census-polygons: ${stringifyJSON(counts)} → ${out} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildCensusPolygons
