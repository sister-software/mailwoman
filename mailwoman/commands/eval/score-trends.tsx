/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval score-trends` — regenerate `docs/records/evals/score-trends.md` from the eval
 *   ledger. Run it after `eval ledger-append`: the new row is not visible in the docs until the page
 *   is rebuilt.
 */

import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

export const description = "Regenerate the per-tag score-trend page from evals/scores-by-version.json"

const OptionsSchema = zod.object({
	ledger: zod.string().optional().describe("The eval ledger (default: evals/scores-by-version.json)"),
	out: zod.string().optional().describe("Destination markdown (default: docs/records/evals/score-trends.md)"),
})

export { OptionsSchema as options }

const EvalScoreTrends: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildScoreTrends } = await import("../../eval-harness/score-trends.ts")

		return buildScoreTrends(options)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status !== "done") return null

	return (
		<Text>
			✓ wrote {state.result.outPath} — {state.result.versions} of {state.result.runs} ledger rows carried per-tag
			metrics
		</Text>
	)
}

export default EvalScoreTrends
