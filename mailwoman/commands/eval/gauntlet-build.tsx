/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval gauntlet-build <artifact>` — build the Gauntlet's data artifacts:
 *
 *   - `fdic-holdout` — the US verified-coord held-out pool (FDIC BankFind → fdic-us.csv, the fast
 *       fresh-draw source for `eval gauntlet --layer holdout --source us`).
 *   - `regression-db` — the curated regression corpus (`cases/regression.ts` →
 *       `$MAILWOMAN_DATA_ROOT/gauntlet/regression.db`, build-on-copy).
 */

import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { buildFDICHoldout } from "../../eval-harness/gauntlet/build-fdic-holdout.ts"
import { buildRegressionDB } from "../../eval-harness/gauntlet/build-regression-db.ts"

export const description = "Build the Gauntlet data artifacts (fdic-holdout, regression-db)"

export const args = zod.tuple([
	zod.enum(["fdic-holdout", "regression-db"]).describe(
		argument({
			name: "artifact",
			description: "Which artifact to build (fdic-holdout, regression-db)",
		})
	),
])

const OptionsSchema = zod.object({})

export { OptionsSchema as options }

const EvalGauntletBuild: CommandComponent<typeof OptionsSchema, typeof args> = ({ args }) => {
	const state = useCommandTask(async () => {
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
