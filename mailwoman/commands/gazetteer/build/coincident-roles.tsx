/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build coincident-roles <admin.db>... [--no-drop]` — derive the
 *   `coincident_roles` relation (dual-role places: city-states, capital-seat provinces, consolidated
 *   city-counties — #403/#402) into one or more admin gazetteers. Additive + idempotent; rebuilds by
 *   default so the relation reflects the current spr/ancestors (`--no-drop` appends — incremental
 *   tests only). Absorbs the retired `mailwoman-wof-build-coincident-roles` bin (Pastel Phase 3).
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { buildCoincidentRoles } from "@mailwoman/resolver-wof-sqlite/coincident-roles"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type Check, CheckList, type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

export const args = zod.array(
	zod.string().describe(
		argument({
			name: "admin-db",
			description: "Admin gazetteer(s) to derive the relation into, processed in sequence",
		})
	)
)

const OptionsSchema = zod.object({
	drop: zod
		.boolean()
		.default(true)
		.describe("Rebuild the relation from the current spr/ancestors (default). --no-drop appends instead"),
})

export { OptionsSchema as options }

const GazetteerBuildCoincidentRoles: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			if (args.length === 0) throw new Error("expected at least one <admin-db> path")
			const checks: Check[] = []

			for (const path of args) {
				if (!existsSync(path)) {
					checks.push({ ok: false, check: path, detail: "file not found" })
					continue
				}
				const db = new DatabaseSync(path)

				try {
					const result = buildCoincidentRoles(db, {
						drop: options.drop,
						onProgress: (phase, detail) => console.error(`  [${phase}]${detail ? ` — ${detail}` : ""}`),
					})
					const top = Object.entries(result.byCountry)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 8)
						.map(([cc, n]) => `${cc} ${n}`)
						.join(", ")
					checks.push({
						ok: true,
						check: path,
						detail: `${result.rowCount} rows (${(result.durationMs / 1000).toFixed(2)}s) — ${top}`,
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

export default GazetteerBuildCoincidentRoles
