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

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Append a promotion-gate run to evals/scores-by-version.json (#885)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "ledger-append",
	description,
	options: {
		"out-dir": { type: "string", description: "The promotion-gate out-dir carrying verdict.json (required)" },
		"model-version": { type: "string", description: "The npm semver being ledgered (required)" },
		"run-id": { type: "string", description: "Stable run id, ^[a-z0-9-]+$ (required)" },
		"model-path": {
			type: "string",
			description: "Published artifact pointer, e.g. @mailwoman/neural-weights-en-us@5.0.0 (required)",
		},
		card: {
			type: "string",
			default: "packages/neural-weights-en-us/model-card.json",
			description: "Model card JSON (run-metadata defaults)",
		},
		ledger: { type: "string", default: "evals/scores-by-version.json", description: "The ledger file" },
		"trained-at": { type: "string", description: "ISO date the model trained (default: today)" },
		notes: { type: "string", default: "", description: "Free-text notes appended to the row" },
		replace: {
			type: "boolean",
			default: false,
			description: "Overwrite an existing row for the same run_id / model_version",
		},
		"operator-exception": {
			type: "string",
			multiple: true,
			description: "Name an adjudicated failing check to ledger a FAIL verdict (repeatable)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	outDir?: string
	modelVersion?: string
	runId?: string
	modelPath?: string
	card: string
	ledger: string
	trainedAt?: string
	notes: string
	replace: boolean
	operatorException?: string[]
}

const EvalLedgerAppend: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { ledgerAppend } = await import("#eval-harness/ledger-append")

			return await ledgerAppend(options)
		},
		(exitCode) => exitCode
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	// ledgerAppend narrates its own ✓/✗ lines.
	return null
}

export default EvalLedgerAppend
