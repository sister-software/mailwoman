/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer promote [<candidate-db>]` — point the drop-in convention path
 *   `<data-root>/db/wof/candidate.db` at a candidate build (a symlink — a pointer swap, never a DB
 *   mutation). The nominatim/photon CLIs auto-use this path for worldwide resolution. Defaults to
 *   the canonical `candidate-global.db`.
 */

import { Box, Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import { DEFAULT_CANDIDATE_OUT } from "#gazetteer-pipeline/defaults"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "promote",
	description: "Promote a candidate gazetteer database.",
	positionals: [
		{
			name: "candidate-db",
			description: `Candidate DB to promote. Default <data-root>/db/wof/${DEFAULT_CANDIDATE_OUT}`,
		},
	],
} as const satisfies CommandSpec

const GazetteerPromote: ParsedCommandComponent<Record<string, never>> = ({ args }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { promoteCandidate, wofDir } = await import("#gazetteer-pipeline")

		const root = dataRootPath()
		const candidateDB = args[0] ?? wofDir(DEFAULT_CANDIDATE_OUT)
		const linkPath = await promoteCandidate(candidateDB, root)

		return { from: linkPath, to: candidateDB }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				<Text color="green">
					✓ promoted: {state.result.from} → {state.result.to}
				</Text>
				<Text> drop-ins (nominatim/photon) now auto-use this gazetteer worldwide — no --candidate-db needed</Text>
			</Box>
		)
	}

	return null
}

export default GazetteerPromote
