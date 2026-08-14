/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry matcher-scale` — the pure-Node matcher scale eval (block → Fellegi-Sunter →
 *   cluster over synthetic geo-clustered records at increasing N; wall-clock + peak RSS). Emits the
 *   markdown report to stdout. Tip: run with `node --expose-gc` for cleaner per-size RSS.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "matcher-scale",
	description: "Measure matcher throughput and peak memory across corpus sizes.",
	options: {
		sizes: {
			type: "string",
			default: "10000,50000,100000,250000,500000",
			description: "Comma-separated record counts to sweep",
		},
		dup: { type: "number", default: 3, description: "Average records per distinct place" },
		em: { type: "boolean", default: false, description: "Fit the FS m/u with EM per size (slower)" },
		"out-md": { type: "string", description: "Also write the markdown report here" },
	},
} as const satisfies CommandSpec

interface Options {
	sizes: string
	dup: number
	em: boolean
	outMd?: string
}

const RegistryMatcherScale: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { matcherScale } = await import("@mailwoman/registry/tools")

		return matcherScale(
			{
				sizes: options.sizes
					.split(",")
					.map((s) => Number(s.trim()))
					.filter((n) => n > 0),
				dup: options.dup,
				em: options.em,
				outMd: options.outMd,
			},
			(line) => console.error(line)
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">matcher-scale: report emitted</Text>

	return null
}

export default RegistryMatcherScale
