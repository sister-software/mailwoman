/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build coincident-roles <admin.db>... [--no-drop]` — derive the
 *   `coincident_roles` relation (dual-role places: city-states, capital-seat provinces, consolidated
 *   city-counties — #403/#402) into one or more admin gazetteers. Additive + idempotent; rebuilds by
 *   default so the relation reflects the current spr/ancestors (`--no-drop` appends — incremental
 *   tests only). Absorbs the retired `mailwoman-wof-build-coincident-roles` bin.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import {
	type Check,
	CheckList,
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "coincident-roles",
	description: "Build coincident administrative roles.",
	positionals: [{ name: "admin-db", required: true, multiple: true, description: "Admin gazetteers to update" }],
	options: { drop: { type: "boolean", default: true, description: "Rebuild the relation; --no-drop appends" } },
} as const satisfies CommandSpec

interface Options {
	drop: boolean
}

const GazetteerBuildCoincidentRoles: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(
		async () => {
			const { buildCoincidentRoles } = await import("@mailwoman/resolver-wof-sqlite/coincident-roles")

			const checks: Check[] = []

			for (const path of args) {
				if (!(await pathExists(path))) {
					checks.push({ ok: false, check: path, detail: "file not found" })

					continue
				}

				using db = new DatabaseClient<WOFDatabase>(path)

				try {
					const result = buildCoincidentRoles(db, {
						drop: options.drop,
						onProgress: (phase, detail) => console.error(`  [${phase}]${detail ? ` — ${detail}` : ""}`),
					})

					const top = Object.entries(result.byCountry)
						.toSorted((a, b) => b[1] - a[1])
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
				}
			}

			return { checks, ok: checks.every((c) => c.ok) }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	return null
}

export default GazetteerBuildCoincidentRoles
