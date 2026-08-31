/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval poi-board` — the curated POI query board (spec §3.6, exotic-POI arc). Runs the
 *   real `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })` surface against every
 *   committed fixture and grades the ASSEMBLED answer (matched category + coordinate), not label F1.
 *
 *   Floors (spec §3.6, set off the v1 baseline): `overall ≥ 90%`, `abstain = 100%`, `address = 100%`.
 *   They are graded and printed on EVERY run. Pass `--enforce` to turn a breach into a non-zero exit
 *   (the CI-gate mode). Without `--enforce` the command stays report-only — it exits 0 on case
 *   failures, and a non-zero exit means the HARNESS broke (missing fixtures, missing db, a pipeline
 *   construction error), never a graded case failing.
 *
 *   `--semantic-observation` injects `mailwoman/observations`' semantic route as an additional phrase
 *   rung, which is the only arm the committed activity-phrased rows are reachable in. It is OFF by
 *   default and the floors are registered against the OFF arm: the board grades the construction that
 *   ships.
 */

import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "POI query board (spec §3.6) — graded on the assembled answer, v1 report-only"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "poi-board",
	description,
	options: {
		locale: { type: "string", default: "en-US", description: "Weights package locale" },
		"weights-cache": { type: "string", description: "Candidate weights dir" },
		fixtures: { type: "string", description: "Fixture JSONL override" },
		db: { type: "string", description: "Sealed poi.db" },
		"resolve-db": { type: "string", description: "WOF admin shards" },
		"candidate-db": { type: "string", description: "Byte-range candidate.db" },
		"semantic-observation": {
			type: "boolean",
			default: false,
			description: "Inject the semantic observation route as an extra phrase rung",
		},
		json: { type: "boolean", default: false, description: "Print JSON" },
		enforce: { type: "boolean", default: false, description: "Enforce registered floors" },
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	weightsCache?: string
	fixtures?: string
	db?: string
	resolveDB?: string
	candidateDB?: string
	semanticObservation: boolean
	json: boolean
	enforce: boolean
}

const EvalPoiBoard: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(
		async () => {
			const { runPOIBoard } = await import("#eval-harness/poi-board")

			const { report, exitCode } = await runPOIBoard({
				locale: options.locale,
				weightsCacheRoot: options.weightsCache,
				fixturesPath: options.fixtures,
				db: options.db,
				resolveDB: options.resolveDB,
				candidateDB: options.candidateDB,
				semanticObservation: options.semanticObservation,
				quiet: options.json,
				enforce: options.enforce,
			})

			return { report, exitCode }
		},
		({ exitCode }) => exitCode
	)

	if (state.status !== "done") return <CommandTaskResult state={state} />

	if (options.json && state.status === "done") {
		return <Text>{JSON.stringify(state.result.report, null, 2)}</Text>
	}

	// Non-json mode: the runner narrates its table on stdout directly.
	return null
}

export default EvalPoiBoard
