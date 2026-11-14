// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman gazetteer digest <db...>` — the content digest of each built database:
 *   one digest per table and a root digest, equal for two builds that hold the
 *   same rows (`@mailwoman/sqlite/sealed/digest`).
 *
 *   It compares a cached build with a build from scratch, where file md5s differ for the same rows.
 */

import { allKeyed } from "@mailwoman/core/promises"
import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "digest",
	description: "Print the content digest of built databases, table by table.",
	positionals: [{ name: "db", description: "Built databases to digest", required: true, multiple: true }],
	options: {
		"country-column": { type: "string", description: "Column that also splits each table's digest by country" },
		out: { type: "string", description: "Write the digests as JSON to this path" },
	},
} as const satisfies CommandSpec

const GazetteerDigest: ParsedCommandComponent<{ countryColumn?: string; out?: string }> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const {
			digest: { databaseContentDigest },
			sealed: { openBuiltClient },
			writers: { writeLocalJSONFile },
		} = await allKeyed({
			digest: import("@mailwoman/sqlite/sealed/digest"),
			sealed: import("@mailwoman/sqlite/sealed"),
			writers: import("@mailwoman/core/fs/writers"),
		})

		const digests: Record<string, Awaited<ReturnType<typeof databaseContentDigest>>> = {}

		for (const path of args) {
			using db = await openBuiltClient(path)

			digests[path] = databaseContentDigest(db, options.countryColumn ? { countryColumn: options.countryColumn } : {})
		}

		if (options.out) {
			await writeLocalJSONFile(digests, options.out)
		}

		return digests
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return (
		<Box flexDirection="column">
			{Object.entries(state.result).map(([path, digest]) => (
				<Box key={path} flexDirection="column">
					<Text color="green">
						{path} root {digest.root}
					</Text>
					{Object.entries(digest.tables).map(([table, { rows, digest: tableDigest }]) => (
						<Text key={table}>
							{"  "}
							{table} {rows} rows {tableDigest}
						</Text>
					))}
				</Box>
			))}
			{options.out ? <Text>wrote {options.out}</Text> : null}
		</Box>
	)
}

export default GazetteerDigest
