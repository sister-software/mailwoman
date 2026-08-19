/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_rig` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import { ENGINE_RIGS, rigQuery, rigStart, rigStatus, rigStop, type EngineRigName } from "../engine-rigs.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"

export const rigTool = ({ registry, jobs }: DevToolDeps): DevTool => ({
	name: "mwdev_rig",
	description:
		"Drive the LOCAL comparison rigs — Pelias and Photon — that `mwdev_compare`'s external arm grades but " +
		"never starts. `status` reports container state and whether the endpoint answers (a running container " +
		"that is not answering yet is an Elasticsearch warm-up, not a fault); `start` waits for a real answer " +
		"rather than for the container; `stop` never removes a container or its frozen index; `query` asks a " +
		"handful of strings and reports each result's SOURCE id — `whosonfirst:locality:101750331` vs " +
		"`geonames:locality:2639268` is how a coverage question gets settled. Endpoints are pinned to loopback " +
		"and cannot be overridden: a comparison against another host is `mwdev_compare`'s external arm, which " +
		"refuses the shared public instances by name. Queries here are OBSERVATIONS — no grading, no rate, no " +
		"verdict. Building a rig (dump download, checksum verification, index extraction) stays manual in its " +
		"own script, and this tool says which one when the containers are absent.",
	inputSchema: z.object({
		engine: z.enum(Object.keys(ENGINE_RIGS) as [EngineRigName, ...EngineRigName[]]),
		action: z.enum(["status", "start", "stop", "query"]).default("status"),
		queries: z
			.array(z.string().min(1))
			.min(1)
			.max(25)
			.optional()
			.describe('Required for "query". Asked sequentially, paced by the house APIClient.'),
	}),
	handler: async (args) => {
		const engine = args["engine"] as EngineRigName
		const action = (args["action"] as string | undefined) ?? "status"

		if (action === "start") return rigStart(engine)

		if (action === "stop") return rigStop(engine)

		if (action === "query") {
			const queries = args["queries"] as string[] | undefined

			if (!queries?.length) {
				throw new Error(
					'mwdev_rig: action "query" needs `queries`. Call it with "status" first to check the rig is up.'
				)
			}

			const status = await rigStatus(engine)

			if (!status.answering) {
				throw new Error(
					`mwdev_rig: ${engine} is not answering at ${status.endpoint} — ` +
						(status.built
							? 'start it first (action: "start").'
							: `build it first with ${ENGINE_RIGS[engine].rigScript}.`)
				)
			}

			return { engine, endpoint: status.endpoint, rows: await rigQuery(engine, queries) }
		}

		return rigStatus(engine)
	},
})
