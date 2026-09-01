/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer verify` — the structural promotion gate, standalone: node census vs the
 *   committed baseline (#1026), coverage floor, region-abbrev/place_abbr spot-checks (#440/#1015),
 *   FTS/bbox coverage, degenerate-extent spot-check (#1015), and the reverse EU panel. Exits non-zero
 *   on any failure — do not swap an artifact that fails here. `build admin` runs this automatically;
 *   the standalone command is for gating an existing DB (e.g. before promoting a staging artifact).
 *
 *   It also prints a DERIVED-ARTIFACT FRESHNESS section (2026-08-05): which FST binaries were built
 *   from this exact database and which were built from some earlier generation of it. That section
 *   never touches the exit code. The admin DB is a sealed artifact a rebuild REPLACES, so every FST
 *   derived from it goes stale silently and on its own schedule — the 2026-08-04 swap left
 *   `fst-global-priority.bin` at a 2026-05-28 build and nothing anywhere noticed. A stale FST is a
 *   decode-time bias list that is merely OLD, not a reason to refuse a database that is fine, and dev
 *   trees must keep running; so it warns, names the rebuild command, and gets out of the way.
 */

import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"

import { CheckList, type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "verify",
	description: "Run the admin-gazetteer promotion gate.",
	options: {
		db: { type: "string", description: "Admin DB to verify" },
		"reverse-panel": { type: "boolean", default: true, description: "Run the reverse EU panel" },
		"fst-freshness": { type: "boolean", default: true, description: "Report stale derived FSTs" },
	},
} as const satisfies CommandSpec

interface Options {
	db?: string
	reversePanel: boolean
	fstFreshness: boolean
}

const GazetteerVerify: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { loadDefaultBaseline, verifyAdmin, verifyReversePanel, wofDir } = await import("#gazetteer-pipeline")

			const dbPath = options.db ?? join(wofDir(), "admin-global-priority.db")

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
				// Lazy: the FST module pulls the resolver + the libpostal dictionaries, and a verify run
				// that skips this section should not pay for either.
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
