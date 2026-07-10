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

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { DEFAULT_CANDIDATE_OUT, promoteCandidate, wofDir } from "../../gazetteer-pipeline/index.ts"

const ArgumentsSchema = zod.array(
	zod.string().describe(`Candidate DB to promote. Default <data-root>/wof/${DEFAULT_CANDIDATE_OUT}`)
)
const OptionsSchema = zod.object({})

export { ArgumentsSchema as args, OptionsSchema as options }

const GazetteerPromote: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args }) => {
	const state = useCommandTask(async () => {
		const root = mailwomanDataRoot()
		const candidateDb = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
		const linkPath = promoteCandidate(candidateDb, root)

		return { from: linkPath, to: candidateDb }
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
