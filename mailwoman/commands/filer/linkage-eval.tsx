/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman filer linkage-eval` — the 3b Task 4 held-out record-linkage eval. Geocode-free,
 *   database-free (builds its own scratch `filer.db` from an embedded synthetic corpus); emits the
 *   markdown scorecard to stdout and, when `--out-md` is given, to that path too.
 */

import { filerLinkageEval } from "@mailwoman/filer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	outMd: zod.string().optional().describe("Also write the markdown report here"),
})

export { OptionsSchema as options }

const FilerLinkageEval: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => filerLinkageEval({ outMd: options.outMd }, (line) => console.error(line)))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { score } = state.result

		return (
			<Text color="green">
				linkage-eval: F1 {score.f1.toFixed(3)} ({score.truePositivePairs}/{score.truthPositivePairs} truth pairs
				recovered)
			</Text>
		)
	}

	return null
}

export default FilerLinkageEval
