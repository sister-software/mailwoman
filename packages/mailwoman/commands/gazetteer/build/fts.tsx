import { pathExists } from "@mailwoman/core/fs/readers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { Text } from "ink"

import { type Check, CheckList, type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fts",
	description: "Build FTS and spatial indexes for WOF SQLite distributions.",
	positionals: [
		{
			name: "wof-db",
			required: true,
			multiple: true,
			description: "WOF SQLite distribution(s) to index, processed in sequence",
		},
	],
	options: { drop: { type: "boolean", default: false, description: "Drop and rebuild place_search and place_bbox" } },
} as const satisfies CommandSpec

interface Options {
	drop: boolean
}

const GazetteerBuildFTS: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const { buildPlaceSearchFTS } = await import("@mailwoman/resolver-wof-sqlite/fts")

			const checks: Check[] = []

			for (const path of args) {
				if (!(await pathExists(path))) {
					checks.push({ ok: false, check: path, detail: "file not found" })

					continue
				}

				using db = new DatabaseClient<WOFDatabase>(path)

				try {
					const result = buildPlaceSearchFTS(db, {
						drop: options.drop,
						onProgress: (phase, detail) => console.error(`  [${phase}]${detail ? ` — ${detail}` : ""}`),
					})

					checks.push({
						ok: true,
						check: path,
						detail: `${result.created ? "built" : "already present"}: ${result.indexedRows.toLocaleString()} rows (${(result.durationMs / 1000).toFixed(2)}s)`,
					})
				} catch (error) {
					checks.push({ ok: false, check: path, detail: error instanceof Error ? error.message : String(error) })
				}
			}

			return { checks, ok: checks.every((c) => c.ok) }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	return null
}

export default GazetteerBuildFTS
