/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build fts <wof.db>... [--drop]` — add the `place_search` FTS5 +
 *   `place_bbox` R*Tree virtual tables to one or more WOF SQLite distributions so production
 *   `WOFSqlitePlaceLookup` instances skip the lazy-build cost at first open. Absorbs the retired
 *   `mailwoman-wof-build-fts` bin (Pastel Phase 3).
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { buildPlaceSearchFTS } from "@mailwoman/resolver-wof-sqlite/fts"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type Check, CheckList, type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

export const args = zod.array(
	zod.string().describe(
		argument({
			name: "wof-db",
			description: "WOF SQLite distribution(s) to index, processed in sequence",
		})
	)
)

const OptionsSchema = zod.object({
	drop: zod
		.boolean()
		.default(false)
		.describe("Drop and rebuild place_search + place_bbox if they already exist (after refreshing spr/names)"),
})

export { OptionsSchema as options }

const GazetteerBuildFTS: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			if (args.length === 0) throw new Error("expected at least one <wof-db> path")
			const checks: Check[] = []

			for (const path of args) {
				if (!existsSync(path)) {
					checks.push({ ok: false, check: path, detail: "file not found" })
					continue
				}
				const db = new DatabaseSync(path)

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
				} finally {
					db.close()
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
