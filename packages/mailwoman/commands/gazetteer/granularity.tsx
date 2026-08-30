import { writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { dirname } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

import { DEFAULT_COVERAGE_FLOOR } from "../../gazetteer-pipeline/defaults.ts"

/**
 * Native command-line contract consumed by the filesystem command router.
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

interface Options {
	out: string
	source?: string
	floor: number
}

const GazetteerGranularity: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath, md5File } = await import("@mailwoman/core/utils")
		const { bottomsOutAt, buildGranularityLadder } = await import("../../gazetteer-pipeline/granularity.ts")
		const { renderGranularityReport } = await import("../../gazetteer-pipeline/granularity-report.ts")

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
