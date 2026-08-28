/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_provenance` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   required half of it.
 */

import { z } from "zod"

import { runProvenance } from "../provenance.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"

export const provenanceTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_provenance",
	description:
		"WHAT AM I MEASURING AGAINST — the state of the artifacts under the engine, before a number from any " +
		"other tool is believed. A gazetteer artifact never complains when it is wrong: `ingestWOF` globs a " +
		"directory and builds whatever is there, so a repo six months stale, a checkout still pulled from " +
		"upstream over our own corrections, or a database swapped an hour ago each produce a plausible artifact " +
		"and a confident answer. Reports per artifact: size, mtime, symlink target (`candidate.db` is a POINTER " +
		"that `gazetteer promote` swaps, so the target name carries the build's identity), and whether it is " +
		"SEALED — an owner-writable database is mid-build or one a verify gate refused, and must not be graded " +
		"against. Also reports each WOF repo's origin, vintage and shallowness from the `repos-sync` stamp, plus " +
		"the last admin build-log entries. READ-ONLY: the repairs are `gazetteer repos-sync` and `gazetteer " +
		"inspect sync`, opt-in because they change what the next build ingests. An absent repo stamp is reported " +
		"as ABSENT, never as 'current'.",
	inputSchema: z.object({
		extra: z
			.array(z.string().min(1))
			.max(10)
			.optional()
			.describe("Additional artifact paths to report — a scratch build under measurement, say."),
		build_log_entries: z.number().int().positive().max(20).default(3),
	}),
	handler: async (args) =>
		runProvenance({
			...(args["extra"] ? { extra: args["extra"] as string[] } : {}),
			buildLogEntries: args["build_log_entries"] as number,
		}),
})
