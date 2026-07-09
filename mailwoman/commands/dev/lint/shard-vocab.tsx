/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev lint shard-vocab --shard <shard.parquet>` — the #511 base-consistency lint,
 *   country-scoped (v2): flags any token a synthetic shard labels one tag while the BASE corpus
 *   dominantly labels it another. Affix-split rows (shard street_suffix/_prefix vs base "street")
 *   are surfaced separately — the loader's affix-relabel handles them. Exits 1 on any real
 *   contradiction.
 */

import { lintShardVocab } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	shard: zod.string().describe("The shard parquet to lint"),
	baseVersion: zod.string().default("v0.5.0").describe("Base corpus version"),
	baseRoot: zod.string().optional().describe("Base corpus root (default $MAILWOMAN_DATA_ROOT/corpus/versioned)"),
	threshold: zod.number().default(0.7).describe("Base-majority confidence floor for a contradiction"),
	minCount: zod.number().default(50).describe("Minimum base support to judge a token"),
	fraction: zod.number().default(1.0).describe("Fraction of base parts to scan (proportional per-source below 1.0)"),
})

export { OptionsSchema as options }

const DevLintShardVocab: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		() =>
			lintShardVocab({
				shard: options.shard,
				baseVersion: options.baseVersion,
				baseRoot: options.baseRoot,
				threshold: options.threshold,
				minCount: options.minCount,
				fraction: options.fraction,
			}),
		(summary) => (summary.errors > 0 ? 1 : 0)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done" && state.result.errors > 0) {
		return (
			<Text color="red">
				✗ {state.result.errors} contradiction(s) ({state.result.warnings} affix-split rows)
			</Text>
		)
	}

	return null
}

export default DevLintShardVocab
