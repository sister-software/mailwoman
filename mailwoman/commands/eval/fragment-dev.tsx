/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval fragment-dev` — probe-1 separator metrics on the held-out fragment split
 *   (span-exact vs tag-accuracy; trailing-number→postcode rate). See eval-harness/fragment-dev.ts.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runFragmentDev } from "../../eval-harness/fragment-dev.ts"

export const description = "Fragment-dev read-out — probe-1 separator metrics (span-exact vs tag accuracy)"

const OptionsSchema = zod.object({
	locale: zod.string().optional().default("en-US").describe("Weights package locale"),
	weightsCache: zod.string().optional().describe("Package-shaped candidate dir (see eval parity --weights-cache)"),
	fixtures: zod.string().describe("fragment-dev.jsonl path (held-out split from build_fragment_shard)"),
	limit: zod.coerce.number().int().min(0).optional().default(0).describe("Row cap for a fast read (0 = all)"),
})

export { OptionsSchema as options }

const EvalFragmentDev: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		await runFragmentDev({
			locale: options.locale,
			weightsCacheRoot: options.weightsCache,
			fixturesPath: options.fixtures,
			limit: options.limit,
		})

		return 0
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default EvalFragmentDev
