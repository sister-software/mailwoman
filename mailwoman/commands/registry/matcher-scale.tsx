/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry matcher-scale` — the pure-Node matcher scale eval (block → Fellegi-Sunter →
 *   cluster over synthetic geo-clustered records at increasing N; wall-clock + peak RSS). Emits the
 *   markdown report to stdout. Tip: run with `node --expose-gc` for cleaner per-size RSS.
 */

import { matcherScale } from "@mailwoman/registry/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	sizes: zod.string().default("10000,50000,100000,250000,500000").describe("Comma-separated record counts to sweep"),
	dup: zod.number().default(3).describe("Average records per distinct place"),
	em: zod.boolean().default(false).describe("Fit the FS m/u with EM per size (slower)"),
	outMd: zod.string().optional().describe("Also write the markdown report here"),
})

export { OptionsSchema as options }

const RegistryMatcherScale: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		matcherScale(
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
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">matcher-scale: report emitted</Text>

	return null
}

export default RegistryMatcherScale
