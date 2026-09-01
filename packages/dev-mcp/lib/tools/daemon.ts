/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_daemon` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   required half of it.
 */

import { z } from "zod"

import type { DevTool, DevToolDeps } from "#tool-kit"
import { staleEngineMessage } from "#tree-fingerprint"

export const daemonTool = (deps: DevToolDeps): DevTool => {
	const { registry } = deps

	return {
		name: "mwdev_daemon",
		description:
			"Status of the warm engine registry: what is resident, what it cost to build, and whether the working " +
			"tree has moved since this process imported its modules. `reload` drops every session so the next call " +
			"rebuilds them against the artifacts on disk — it CANNOT re-import source, and REFUSES once the tree has " +
			"moved rather than reporting a reload it did not perform. A source edit needs `mwdev_restart`; to A/B a " +
			"source change, run each arm in its own process.",
		inputSchema: z.object({
			action: z.enum(["status", "reload", "evict"]).default("status"),
			engine_id: z.string().optional(),
		}),
		handler: async (args) => {
			const action = (args["action"] as string) ?? "status"
			const fingerprint = await registry.fingerprint()

			if (action === "reload") {
				// The refusal is the whole point. `reload` used to close the sessions, return the CURRENT digest and a
				// note admitting it could not re-import — a success shape carrying its own contradiction, which a
				// caller reading `engines_closed` and a fresh fingerprint reasonably takes for a completed reload. It
				// then measures new-tree answers out of old-tree code with nothing left to flag it.
				if (await registry.sourceMoved()) {
					throw new Error(staleEngineMessage(registry.bootFingerprint, fingerprint))
				}

				const closed = registry.evictAll()

				return {
					action,
					engines_closed: closed,
					tree_fingerprint: fingerprint.digest,
					note:
						"Sessions dropped; the next call rebuilds them against the artifacts on disk. The tree has NOT moved " +
						"since this process imported its modules, so the rebuilt engines run the same source you are reading. " +
						"This never re-imports source; had the tree moved, this call would have refused.",
				}
			}

			if (action === "evict") {
				const id = args["engine_id"] as string | undefined

				if (!id) throw new Error("mwdev_daemon: `evict` needs an `engine_id` (see `status`).")

				return { action, evicted: registry.evict(id), engine_id: id }
			}

			return {
				action,
				pid: process.pid,
				uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
				repo_root: registry.repoRoot,
				tree_fingerprint: fingerprint.digest,
				// The pair, always, so "can this process still answer for the source on disk" is readable without
				// comparing a digest against one remembered from an earlier call.
				boot_tree_fingerprint: registry.bootFingerprint.digest,
				source_moved_since_boot: await registry.sourceMoved(),
				git_head: fingerprint.gitHead,
				dirty_files: fingerprint.dirtyFiles,
				newest_source: fingerprint.newestPath,
				newest_source_mtime_iso: new Date(fingerprint.newestMtimeMs).toISOString(),
				source_files_walked: fingerprint.filesWalked,
				engines: registry.summaries(),
				max_resident: registry.maxResident,
			}
		},
	}
}
