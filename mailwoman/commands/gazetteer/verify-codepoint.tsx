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
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	codepoint: zod
		.string()
		.optional()
		.describe("Candidate shard. Default <data-root>/wof/postalcode-gb-codepoint-<YYYY-MM-DD>.db"),
	incumbent: zod
		.string()
		.optional()
		.describe("Incumbent shard. Default <data-root>/wof/frozen-backup-2026-08-04/postalcode-geonames-tail.db"),
	json: zod.boolean().optional().describe("Emit the raw report as JSON instead of the rendered table"),
})

export { OptionsSchema as options }

const GazetteerVerifyPostcodeCodePoint: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/utils")

		const { runCodePointGate, formatCodePointGateReport } =
			await import("../../gazetteer-pipeline/postcode/codepoint-gate.ts")

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
