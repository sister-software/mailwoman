/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval poi-board` — the curated POI query board (spec §3.6, exotic-POI arc). Runs the
 *   real `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })` surface against every
 *   committed fixture and grades the ASSEMBLED answer (matched category + coordinate), not label F1.
 *
 *   v1 is REPORT-ONLY (pre-registration discipline — see `eval-harness/poi-board.ts`'s header): this
 *   command always exits 0 on case failures. A non-zero exit means the HARNESS broke (missing
 *   fixtures, missing db, a pipeline construction error), never a graded case failing. Floors land in
 *   a follow-up PR once the v1 numbers exist to set them against.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { runPoiBoard } from "../../eval-harness/poi-board.ts"

export const description = "POI query board (spec §3.6) — graded on the assembled answer, v1 report-only"

const OptionsSchema = zod.object({
	locale: zod
		.string()
		.optional()
		.default("en-US")
		.describe("Weights package locale for the classifier (default en-US)"),
	weightsCache: zod
		.string()
		.optional()
		.describe("Package-shaped candidate weights dir (mirrors eval parity --weights-cache)"),
	fixtures: zod.string().optional().describe("Fixture JSONL override (default: the committed poi-board fixtures)"),
	db: zod
		.string()
		.optional()
		.describe("Sealed poi.db to query (default <data-root>/poi/poi.db — the gazetteer build poi default)"),
	resolveDb: zod
		.string()
		.optional()
		.describe("WOF admin shard path(s) for anchor resolution, comma-separated (same as `mailwoman poi --resolve-db`)"),
	candidateDb: zod
		.string()
		.optional()
		.describe(
			"Byte-range candidate.db for anchor resolution (same as `mailwoman poi --candidate-db`; wins over --resolve-db)"
		),
	json: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Print the full report as JSON instead of the human-readable table"),
})

export { OptionsSchema as options }

const EvalPoiBoard: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { report } = await runPoiBoard({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				fixturesPath: options.fixtures,
				db: options.db,
				resolveDb: options.resolveDb,
				candidateDb: options.candidateDb,
				quiet: options.json,
			})

			return { report, exitCode: 0 }
		},
		({ exitCode }) => exitCode
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (options.json && state.status === "done") {
		return <Text>{JSON.stringify(state.result.report, null, 2)}</Text>
	}

	// Non-json mode: the runner narrates its table on stdout directly.
	return null
}

export default EvalPoiBoard
