/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer promote [<candidate-db>]` — point the drop-in convention path
 *   `<data-root>/wof/candidate.db` at a candidate build (a symlink — a POINTER swap, never a DB
 *   mutation). The nominatim/photon CLIs auto-use this path for worldwide resolution. Defaults to
 *   the canonical `candidate-global.db`.
 */

import { join } from "node:path"

import { Box, Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import { DEFAULT_CANDIDATE_OUT } from "mailwoman/gazetteer-pipeline/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "promote",
	description: "Promote a candidate gazetteer database.",
	positionals: [
		{ name: "candidate-db", description: `Candidate DB to promote. Default <data-root>/wof/${DEFAULT_CANDIDATE_OUT}` },
	],
} as const satisfies CommandSpec

const GazetteerPromote: ParsedCommandComponent<Record<string, never>> = ({ args }) => {
	const state = useCommandTask(async () => {
		const { mailwomanDataRoot } = await import("@mailwoman/core/utils")
		const { promoteCandidate, wofDir } = await import("mailwoman/gazetteer-pipeline")

		const root = mailwomanDataRoot()
		const candidateDB = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
		const linkPath = promoteCandidate(candidateDB, root)

		return { from: linkPath, to: candidateDB }
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

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
