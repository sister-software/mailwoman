/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { Box, Text } from "ink"
import { dirname, isAbsolute, relative, resolvePath, sep } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import { DEFAULT_COVERAGE_FLOOR } from "#gazetteer-pipeline/defaults"

/**
 * Command specification for `gazetteer granularity`, which reports the deepest
 * admin placetype the gazetteer covers in each country.
 */
export const spec = {
	name: "granularity",
	description: "Build the gazetteer-depth scorecard.",
	options: {
		out: {
			type: "string",
			default: "docs/records/evals/coverage/gazetteer-depth-scorecard.md",
			description: "Output markdown",
		},
		source: { type: "string", description: "WOF admin DB" },
		floor: { type: "number", default: DEFAULT_COVERAGE_FLOOR, description: "Parent-coverage floor" },
	},
} as const satisfies CommandSpec

const GazetteerGranularity: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { md5File } = await import("@mailwoman/core/utils")
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { bottomsOutAt, buildGranularityLadder } = await import("#gazetteer-pipeline/granularity/index")
		const { renderGranularityReport } = await import("#gazetteer-pipeline/granularity/report")

		const sourcePath = options.source ?? wofDatabasePath("admin-global-priority.db")
		const rows = buildGranularityLadder(sourcePath)

		if (!rows.length) {
			throw new Error(`granularity: no countries measured from ${sourcePath} — is this an admin DB?`)
		}

		// The report is committed, so a source under the data root is recorded relative to it.
		const fromDataRoot = relative(dataRootPath(), resolvePath(sourcePath))
		const underDataRoot = !isAbsolute(fromDataRoot) && fromDataRoot !== ".." && !fromDataRoot.startsWith(`..${sep}`)

		const markdown = renderGranularityReport(rows, {
			sourcePath: underDataRoot ? `$MAILWOMAN_DATA_ROOT/${fromDataRoot.split(sep).join("/")}` : String(sourcePath),
			sourceMD5: await md5File(sourcePath),
			buildDate: new Date().toISOString(),
			floor: options.floor,
		})

		await makeDirectories(dirname(options.out))
		await writeLocalFile(markdown, options.out)

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

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
