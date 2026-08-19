/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_runs` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { RETENTION_DAYS, RETENTION_MAX_RUNS, RUN_STORE_DIR, getRun, listRuns } from "../run-store.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"

export const runsTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_runs",
	description:
		'What is in the run store — the past comparisons a {kind:"recorded"} arm can replay. Newest first. A run ' +
		`is kept for ${RETENTION_DAYS} days and at most ${RETENTION_MAX_RUNS} are kept at once, so a run_id that is ` +
		"absent was pruned or never existed; those two are indistinguishable, and the answer to both is to " +
		"re-measure. This is a CACHE, not a record — evals/scores-by-version.json and docs/records/evals/ are the " +
		"record.",
	inputSchema: z.object({
		action: z.enum(["list", "get"]).default("list"),
		run_id: z.string().optional().describe('Required for "get".'),
		limit: z.number().int().positive().max(200).default(25),
	}),
	handler: async (args) => {
		const fingerprint = registry.fingerprint().digest

		if (args["action"] === "get") {
			const runID = args["run_id"] as string | undefined

			if (!runID) throw new Error('mwdev_runs: action "get" needs a run_id. Call it with "list" first.')

			const run = getRun(runID)

			if (!run) {
				throw new Error(
					`No stored run ${JSON.stringify(runID)}. It was pruned or never existed — those are not ` +
						"distinguishable after the fact, so re-measure."
				)
			}

			return {
				...run,
				fingerprint_matches_now: run.tree_fingerprint === fingerprint,
				replayable_arms: Object.keys(run.answers ?? {}),
			}
		}

		const all = listRuns(RUN_STORE_DIR, fingerprint)
		const limit = (args["limit"] as number | undefined) ?? 25
		const sameTree = all.filter((run) => run.fingerprint_matches_now).length

		// One measurement often writes several runs in the same second against the same tool, input set and
		// tree — a burst of arms, not several comparisons. Listed row by row those fill the reply with rows
		// that differ only in `run_id` and byte count, and push the older, genuinely different runs past the
		// limit. Group them; the newest of each group is the one a {kind:"recorded"} arm would replay, and the
		// rest are named by count and stay reachable through `get`.
		const groups = new Map<string, typeof all>()

		for (const run of all) {
			const key = `${run.tool}\u0000${run.input_set_id}\u0000${run.tree_fingerprint}\u0000${run.engine_id ?? ""}`
			const bucket = groups.get(key)

			if (bucket) {
				bucket.push(run)
			} else {
				groups.set(key, [run])
			}
		}

		const collapsed = [...groups.values()].map((bucket) => {
			const [newest, ...rest] = bucket

			return rest.length
				? { ...newest!, repeats_collapsed: rest.length, repeat_run_ids: rest.map((r) => r.run_id) }
				: newest!
		})

		const shown = collapsed.slice(0, limit)
		const hidden = collapsed.slice(limit).length

		return {
			// Named rather than left as a bare truncation: a listing that silently showed the newest 25 of 200 reads
			// as a store holding 25.
			summary:
				`${all.length} stored run${all.length === 1 ? "" : "s"} in ${collapsed.length} group${collapsed.length === 1 ? "" : "s"} ` +
				`(same tool + input set + tree + engine), ${sameTree} against the current tree ` +
				`(${fingerprint.slice(0, 12)})${hidden ? `. Showing the newest ${shown.length} group(s)` : ""}.`,
			n_stored: all.length,
			n_groups: collapsed.length,
			n_shown: shown.length,
			n_matching_current_tree: sameTree,
			retention: { days: RETENTION_DAYS, max_runs: RETENTION_MAX_RUNS, directory: RUN_STORE_DIR },
			runs: shown,
		}
	},
})
