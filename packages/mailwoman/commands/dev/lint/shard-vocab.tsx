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

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "shard-vocab",
	description: "Lint a synthetic shard against base-corpus token labels.",
	options: {
		shard: { type: "string", required: true, description: "The shard parquet to lint" },
		"base-version": { type: "string", default: "v0.5.0", description: "Base corpus version" },
		"base-root": { type: "string", description: "Base corpus root (default $MAILWOMAN_DATA_ROOT/corpus/versioned)" },
		threshold: { type: "number", default: 0.7, description: "Base-majority confidence floor for a contradiction" },
		"min-count": { type: "number", default: 50, description: "Minimum base support to judge a token" },
		fraction: {
			type: "number",
			default: 1,
			description: "Fraction of base parts to scan (proportional per-source below 1.0)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	shard: string
	baseVersion: string
	baseRoot?: string
	threshold: number
	minCount: number
	fraction: number
}

const DevLintShardVocab: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { lintShardVocab } = await import("@mailwoman/corpus/tools")

			return lintShardVocab({
				shard: options.shard,
				baseVersion: options.baseVersion,
				baseRoot: options.baseRoot,
				threshold: options.threshold,
				minCount: options.minCount,
				fraction: options.fraction,
			})
		},
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
