/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer verify-codepoint` — the promotion gate for the Code-Point Open GB
 *   shard. Compares it against the incumbent GeoNames `GB_full` rows on row membership, coordinate
 *   agreement, Northern Ireland coverage, and ten hand-checked landmark probes.
 *
 *   Reports; does not decide. Both databases are opened read-only.
 */

import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "verify-codepoint",
	description: "Compare a Code-Point Open shard against its incumbent.",
	options: {
		codepoint: {
			type: "string",
			description: "Candidate shard. Default <data-root>/wof/postalcode-gb-codepoint-<YYYY-MM-DD>.db",
		},
		incumbent: {
			type: "string",
			description: "Incumbent shard. Default <data-root>/wof/frozen-backup-2026-08-04/postalcode-geonames-tail.db",
		},
		json: { type: "boolean", description: "Emit the raw report as JSON instead of the rendered table" },
	},
} as const satisfies CommandSpec

interface Options {
	codepoint?: string
	incumbent?: string
	json?: boolean
}

const GazetteerVerifyPostcodeCodePoint: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const { runCodePointGate, formatCodePointGateReport } = await import("#gazetteer-pipeline/postcode/codepoint-gate")

		const stamp = new Date().toISOString().slice(0, 10)

		const report = runCodePointGate({
			codepointPath: options.codepoint ?? String(dataRootPath("wof", `postalcode-gb-codepoint-${stamp}.db`)),
			incumbentPath:
				options.incumbent ?? String(dataRootPath("wof", "frozen-backup-2026-08-04", "postalcode-geonames-tail.db")),
			onPhase: (phase, detail) => console.error(`  [${phase}]${detail ? ` ${detail}` : ""}`),
		})

		return options.json ? [JSON.stringify(report, null, 2)] : formatCodePointGateReport(report)
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

export default GazetteerVerifyPostcodeCodePoint
