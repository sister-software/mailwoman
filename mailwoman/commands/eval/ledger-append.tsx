/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval ledger-append` — turn a promotion-gate out-dir into one row of
 *   `evals/scores-by-version.json` (#885). `eval gate` prints this command pre-filled on every
 *   PASS. Refuses duplicates without `--replace` and refuses un-excepted FAIL verdicts; exit codes
 *   mirror the retired script (0 appended, 1 refused, 2 usage).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { ledgerAppend } from "../../eval-harness/ledger-append.ts"

export const description = "Append a promotion-gate run to evals/scores-by-version.json (#885)"

const OptionsSchema = zod.object({
	outDir: zod.string().optional().describe("The promotion-gate out-dir carrying verdict.json (required)"),
	modelVersion: zod.string().optional().describe("The npm semver being ledgered (required)"),
	runId: zod.string().optional().describe("Stable run id, ^[a-z0-9-]+$ (required)"),
	modelPath: zod
		.string()
		.optional()
		.describe('Published artifact pointer, e.g. "@mailwoman/neural-weights-en-us@5.0.0" (required)'),
	card: zod
		.string()
		.default("neural-weights-en-us/model-card.json")
		.describe("Model card JSON (run-metadata defaults)"),
	ledger: zod.string().default("evals/scores-by-version.json").describe("The ledger file"),
	trainedAt: zod.string().optional().describe("ISO date the model trained (default: today)"),
	notes: zod.string().default("").describe("Free-text notes appended to the row"),
	replace: zod.boolean().default(false).describe("Overwrite an existing row for the same run_id / model_version"),
	operatorException: zod
		.array(zod.string())
		.optional()
		.describe("Name an adjudicated failing check to ledger a FAIL verdict (repeatable)"),
})

export { OptionsSchema as options }

const EvalLedgerAppend: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => ledgerAppend(options),
		(exitCode) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// ledgerAppend narrates its own ✓/✗ lines.
	return null
}

export default EvalLedgerAppend
