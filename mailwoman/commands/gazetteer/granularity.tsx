/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer granularity` — the per-country gazetteer depth scorecard.
 *
 *   Answers "where does the admin gazetteer bottom out?" for every country it knows, which nobody
 *   had measured: the shipped artifact stocks 9 of WOF's 34 placetypes and carries a
 *   `dependent_locality` tier in 11 of 244 countries. Read-only, no network, no model — three
 *   grouped queries over `spr`/`ancestors` and a markdown render.
 *
 *   The report is a COMMITTED artifact (the `fill-rates.md` precedent), so the source md5 and the
 *   parent-coverage floor are pinned in its header. Re-running against a rebuilt gazetteer and
 *   diffing the report is the intended workflow.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { dataRootPath, md5File } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { renderGranularityReport } from "../../gazetteer-pipeline/granularity-report.ts"
import { DEFAULT_COVERAGE_FLOOR, bottomsOutAt, buildGranularityLadder } from "../../gazetteer-pipeline/granularity.ts"

const OptionsSchema = zod.object({
	out: zod
		.string()
		.default("docs/records/evals/coverage/gazetteer-depth-scorecard.md")
		.describe("Output path for the markdown scorecard"),
	source: zod.string().optional().describe("WOF admin DB. Default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db"),
	floor: zod
		.number()
		.default(DEFAULT_COVERAGE_FLOOR)
		.describe(
			`Parent-coverage floor for crediting a sub-locality rung. Default ${DEFAULT_COVERAGE_FLOOR} — set low on ` +
				"purpose, to catch thin-but-real tiers rather than certify them."
		),
})

export { OptionsSchema as options }

const GazetteerGranularity: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const sourcePath = options.source ?? String(dataRootPath("wof", "admin-global-priority.db"))
		const rows = buildGranularityLadder(sourcePath)

		if (!rows.length) {
			throw new Error(`granularity: no countries measured from ${sourcePath} — is this an admin DB?`)
		}

		const markdown = renderGranularityReport(rows, {
			// Display the portable form; never bake the resolved lab path into a committed artifact.
			sourcePath: "$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db",
			sourceMD5: await md5File(sourcePath),
			buildDate: new Date().toISOString(),
			floor: options.floor,
		})

		mkdirSync(dirname(options.out), { recursive: true })
		writeFileSync(options.out, markdown)

		const byBottom = new Map<string, number>()

		for (const row of rows) {
			const bottom = bottomsOutAt(row, options.floor) ?? "(none)"

			byBottom.set(bottom, (byBottom.get(bottom) ?? 0) + 1)
		}

		const distribution = [...byBottom.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.map(([rung, n]) => `  ${rung}: ${n.toLocaleString()} countries`)

		return [
			`gazetteer depth scorecard → ${options.out}`,
			`countries measured: ${rows.length.toLocaleString()} (floor ${(options.floor * 100).toFixed(1)}%)`,
			"bottoms out at:",
			...distribution,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerGranularity
