// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer build overture-part` — the Overture Divisions part of a built candidate
 *   gazetteer as its own sealed ODbL 1.0 database, the file a published gazetteer offers under ODbL 4.6.
 *
 *   It writes the file to the given path and doesn't publish it.
 *   The pipeline module is lazy-imported so `--help` never faults without the
 *   optional `@mailwoman/resolver-wof-sqlite` peer.
 */

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "overture-part",
	description: "Copy the Overture Divisions part of a candidate gazetteer into its own ODbL database.",
	options: {
		candidate: { type: "string", description: "Built candidate gazetteer to copy the part out of.", required: true },
		out: { type: "string", description: "Output database (a staging path).", required: true },
		release: {
			type: "string",
			description: "Overture release the admin gazetteer read its divisions from.",
			required: true,
		},
		"part-version": {
			type: "string",
			description: "Version of the part, such as the gazetteer version.",
			required: true,
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildOverturePart: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildOverturePart } = await import("@mailwoman/gazetteer/tools/pipeline/collective-offer")

		const r = await buildOverturePart({
			candidateDB: options.candidate,
			out: options.out,
			overtureRelease: options.release,
			version: options.partVersion,
		})

		const counts = Object.entries(r.rows)
			.map(([table, rows]) => `${table} ${rows}`)
			.join(", ")

		return `overture-part: ${r.places} places (${counts}) from candidate md5 ${r.candidateMD5.slice(0, 8)} → ${r.out} — sealed 0444`
	})

	return <CommandTaskResult state={state} />
}

export default GazetteerBuildOverturePart
