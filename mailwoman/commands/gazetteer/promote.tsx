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
import { useEffect, useState } from "react"
import zod from "zod"

import { DEFAULT_CANDIDATE_OUT, promoteCandidate, wofDir } from "../../gazetteer-pipeline.js"
import type { CommandComponent } from "../../sdk/cli.js"

const ArgumentsSchema = zod.array(
	zod.string().describe(`Candidate DB to promote. Default <data-root>/wof/${DEFAULT_CANDIDATE_OUT}`)
)
const OptionsSchema = zod.object({})

export { ArgumentsSchema as args, OptionsSchema as options }

const GazetteerPromote: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args }) => {
	const [error, setError] = useState<string>()
	const [link, setLink] = useState<{ from: string; to: string }>()

	useEffect(() => {
		try {
			const root = mailwomanDataRoot()
			const candidateDb = args[0] ?? join(wofDir(root), DEFAULT_CANDIDATE_OUT)
			const linkPath = promoteCandidate(candidateDb, root)
			setLink({ from: linkPath, to: candidateDb })
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}, [args])

	useEffect(() => {
		if (link || error) setImmediate(() => process.exit(error ? 1 : 0))
	}, [link, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (link) {
		return (
			<Box flexDirection="column">
				<Text color="green">
					✓ promoted: {link.from} → {link.to}
				</Text>
				<Text> drop-ins (nominatim/photon) now auto-use this gazetteer worldwide — no --candidate-db needed</Text>
			</Box>
		)
	}

	return null
}

export default GazetteerPromote
