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
 */

import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { Text } from "ink"
import zod from "zod"

import { CheckList, type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { loadDefaultBaseline, verifyAdmin, verifyReversePanel, wofDir } from "../../gazetteer-pipeline/index.ts"

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("Admin DB to verify. Default <data-root>/wof/admin-global-priority.db"),
	reversePanel: zod
		.boolean()
		.default(true)
		.describe("Run the reverse EU panel (end-to-end leg). --no-reverse-panel to skip"),
})

export { OptionsSchema as options }

const GazetteerVerify: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const dbPath = options.db ?? join(wofDir(), "admin-global-priority.db")
			console.error(`Verifying ${dbPath}...`)
			const db = new DatabaseSync(dbPath, { readOnly: true })
			const structural = verifyAdmin(db, loadDefaultBaseline())
			db.close()
			const checks = [...structural.checks]
			let ok = structural.ok

			if (options.reversePanel) {
				const reverse = await verifyReversePanel(dbPath)
				checks.push(...reverse.checks)
				ok = ok && reverse.ok
			}

			return { ok, checks }
		},
		(result) => (result.ok ? 0 : 1)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <CheckList checks={state.result.checks} verdict={state.result.ok} />

	return null
}

export default GazetteerVerify
