/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Structural promotion eval for the admin gazetteer: exits non-zero on any failure, so do not swap
 *   an artifact that fails here; the derived-FST freshness section is advisory and never affects the verdict.
 */

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { CheckList, type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "verify",
	description: "Run the admin-gazetteer promotion check.",
	options: {
		db: { type: "string", description: "Admin DB to verify" },
		"reverse-panel": { type: "boolean", default: true, description: "Run the reverse EU panel" },
		"fst-freshness": { type: "boolean", default: true, description: "Report stale derived FSTs" },
	},
} as const satisfies CommandSpec

const GazetteerVerify: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { loadDefaultBaseline, verifyAdmin, verifyReversePanel } = await import("#gazetteer-pipeline")
			const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")

			const dbPath = options.db ?? wofDatabasePath("admin-global-priority.db")

			console.error(`Verifying ${dbPath}...`)

			using db = new DatabaseClient<WOFDatabase>(dbPath, { readOnly: true })
			const structural = verifyAdmin(db, loadDefaultBaseline())
			const checks = [...structural.checks]
			let ok = structural.ok

			if (options.reversePanel) {
				const reverse = await verifyReversePanel(dbPath)
				checks.push(...reverse.checks)
				ok = ok && reverse.ok
			}

			if (options.fstFreshness) {
				// Lazy: the FST module pulls the resolver and libpostal dictionaries a
				// skipped section should not pay for.
				const { checkAdminDerivedFSTFreshness } = await import("#gazetteer-pipeline/fst")
				const rows = await checkAdminDerivedFSTFreshness(dbPath)
				const stale = rows.filter((row) => row.staleReason)
				const missing = rows.filter((row) => !row.present)

				console.error(`\nDerived FST artifacts vs ${dbPath} (advisory — does not affect the verdict):`)

				for (const row of rows) {
					if (!row.present) {
						console.error(`  – ${row.artifact}: absent`)
					} else if (row.staleReason) {
						console.error(`  ✗ ${row.artifact}: ${row.staleReason}`)
						console.error(`      rebuild: ${row.rebuildCommand}`)
					} else {
						console.error(`  ✓ ${row.artifact}: built ${row.builtAt} from this database`)
					}
				}

				console.error(
					`  ${stale.length} stale, ${missing.length} absent, ${rows.length - stale.length - missing.length} current`
				)
			}

			return { ok, checks }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	return null
}

export default GazetteerVerify
