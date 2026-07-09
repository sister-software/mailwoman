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

import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import {
	loadDefaultBaseline,
	verifyAdmin,
	type VerifyCheckResult,
	verifyReversePanel,
	wofDir,
} from "../../gazetteer-pipeline/index.ts"
import type { CommandComponent } from "../../sdk/cli.ts"

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("Admin DB to verify. Default <data-root>/wof/admin-global-priority.db"),
	reversePanel: zod
		.boolean()
		.default(true)
		.describe("Run the reverse EU panel (end-to-end leg). --no-reverse-panel to skip"),
})

export { OptionsSchema as options }

const GazetteerVerify: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [result, setResult] = useState<{ ok: boolean; checks: VerifyCheckResult[] }>()

	useEffect(() => {
		void (async () => {
			try {
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
				setResult({ ok, checks })
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (result || error) {
			setImmediate(() => process.exit(error || !result?.ok ? 1 : 0))
		}
	}, [result, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (result) {
		return (
			<Box flexDirection="column">
				{result.checks.map((c, i) => (
					<Text key={i} color={c.ok ? "green" : "red"}>
						{c.ok ? "✓" : "✗"} {c.check}: {c.detail}
					</Text>
				))}
				<Text color={result.ok ? "green" : "red"}>
					{result.ok ? "PASS" : "FAIL"} ({result.checks.filter((c) => c.ok).length}/{result.checks.length} checks)
				</Text>
			</Box>
		)
	}

	return null
}

export default GazetteerVerify
