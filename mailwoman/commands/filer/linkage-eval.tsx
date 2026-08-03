/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman filer linkage-eval` — the corporate-family recovery eval. Geocode-free,
 *   database-free (builds its own scratch `filer.db` artifacts from an embedded synthetic corpus); emits
 *   the markdown scorecard to stdout and, when `--out-md` is given, to that path too. `--date` overrides
 *   the report's dated H1 so the committed scorecard can be regenerated without editing code.
 */

import { filerLinkageEval } from "@mailwoman/filer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	outMd: zod.string().optional().describe("Also write the markdown report here"),
	date: zod.string().optional().describe("Report date (YYYY-MM-DD) for the H1 — defaults to today"),
})

export { OptionsSchema as options }

/**
 * `null` renders as `N/A`, never as `0.000` — the withheld run makes no positive call, so its precision and F1 are
 * undefined rather than zero (see `linkage-metrics.ts`).
 */
function formatScoreValue(value: number | null): string {
	return value === null ? "N/A" : value.toFixed(3)
}

const FilerLinkageEval: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		filerLinkageEval({ outMd: options.outMd, date: options.date }, (line) => console.error(line))
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { withheld, control } = state.result

		// Both rows, always: the withheld number is the measurement and the control is what makes it falsifiable.
		return (
			<Text color="green">
				linkage-eval · withheld: recall {formatScoreValue(withheld.score.recall)} ({withheld.score.truePositivePairs}/
				{withheld.score.truthPositivePairs} pairs, F1 {formatScoreValue(withheld.score.f1)}) · control: F1{" "}
				{formatScoreValue(control.score.f1)} ({control.score.truePositivePairs}/{control.score.truthPositivePairs}{" "}
				pairs)
			</Text>
		)
	}

	return null
}

export default FilerLinkageEval
