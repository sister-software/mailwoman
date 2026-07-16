/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval oracle-k` — oracle-recall@k over segment-level k-best decodes (#727 stage-2
 *   instrumentation). Measures the k-best rerank headroom the top-1 gates can't see: how often the
 *   gold value appears ANYWHERE in the top-k whole-segmentation hypotheses decoded from the current
 *   model's emissions. Informational (always exits 0) — the standing floors stay on `eval parity`.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runOracleK } from "../../eval-harness/oracle-k.ts"

export const description = "Oracle-recall@k — k-best segment-decode headroom over the parity corpus (#727 stage-2)"

const OptionsSchema = zod.object({
	locale: zod.string().optional().default("en-US").describe("Weights package locale (default en-US)"),
	weightsCache: zod
		.string()
		.optional()
		.describe("Package-shaped candidate weights dir (mirrors eval parity --weights-cache)"),
	fixtures: zod.string().optional().describe("Fixture JSONL override (default: the ratified triaged parity corpus)"),
	goldenDir: zod
		.string()
		.optional()
		.describe("Golden dev dir for the transition-bigram estimate (default data/eval/golden/v0.1.2/dev)"),
	k: zod.coerce.number().int().min(1).max(50).optional().default(10).describe("Hypotheses kept per input"),
	assertBaseline: zod
		.string()
		.optional()
		.describe("Registered baseline profile (v264, v301) — refuse to report if the instruments read wrong"),
})

export { OptionsSchema as options }

const EvalOracleK: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () =>
			(
				await runOracleK({
					locale: options.locale,
					weightsCacheRoot: options.weightsCache,
					fixturesPath: options.fixtures,
					goldenDir: options.goldenDir,
					k: options.k,
					assertBaseline: options.assertBaseline,
				})
			).exitCode,
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The runner narrates its table on stdout.
	return null
}

export default EvalOracleK
