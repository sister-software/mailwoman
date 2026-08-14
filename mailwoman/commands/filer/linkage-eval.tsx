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

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "linkage-eval",
	description: "Evaluate corporate-family linkage recovery.",
	options: {
		"out-md": { type: "string", description: "Also write the markdown report here" },
		date: { type: "string", description: "Report date (YYYY-MM-DD) for the H1 — defaults to today" },
	},
} as const satisfies CommandSpec

interface Options {
	outMd?: string
	date?: string
}

/**
 * `null` renders as `N/A`, never as `0.000` — the withheld run makes no positive call, so its precision and F1 are
 * undefined rather than zero (see `linkage-metrics.ts`).
 */
function formatScoreValue(value: number | null): string {
	return value === null ? "N/A" : value.toFixed(3)
}

const FilerLinkageEval: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { filerLinkageEval } = await import("@mailwoman/filer/tools")

		return filerLinkageEval({ outMd: options.outMd, date: options.date }, (line) => console.error(line))
	})

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
