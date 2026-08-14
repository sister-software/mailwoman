/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval gauntlet-build <artifact>` — build the Gauntlet's data artifacts:
 *
 *   - `fdic-holdout` — the US verified-coord held-out pool (FDIC BankFind → fdic-us.csv, the fast
 *       fresh-draw source for `eval gauntlet --layer holdout --source us`).
 *   - `regression-db` — the curated regression corpus (`cases/<cc>/*.jsonl` →
 *       `$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`, build-on-copy).
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

export const description = "Build the Gauntlet data artifacts (fdic-holdout, regression-db)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "gauntlet-build",
	description,
	positionals: [
		{
			name: "artifact",
			required: true,
			choices: ["fdic-holdout", "regression-db"],
			description: "Which artifact to build (fdic-holdout, regression-db)",
		},
	],
} as const satisfies CommandSpec

const EvalGauntletBuild: ParsedCommandComponent<Record<string, never>, ["fdic-holdout" | "regression-db"]> = ({
	args,
}) => {
	const state = useCommandTask(async () => {
		const { buildFDICHoldout } = await import("../../eval-harness/gauntlet/build-fdic-holdout.ts")
		const { buildRegressionDB } = await import("../../eval-harness/gauntlet/build-regression-db.ts")

		switch (args[0]) {
			case "fdic-holdout":
				await buildFDICHoldout()

				return "fdic-holdout: pool refreshed"
			case "regression-db":
				await buildRegressionDB()

				return "regression-db: built"
		}
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default EvalGauntletBuild
