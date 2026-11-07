/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_directories` tool definition provides the agent-facing description and input schema.
 *   Its handler reads data-directories in the package root.
 */

import { z } from "zod"

import { listDataDirectories } from "#dev-mcp/data-directories"
import type { DevTool, DevToolDeps } from "#dev-mcp/tool-kit"

export const directoriesTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_directories",
	description:
		"WHERE IS THE DATA — the data root's directories, what each holds, and what each has misled a search about, read " +
		"from the disk. Call this before saying a source, repository, extract or database is absent from this host: a " +
		"directory that holds a subset reads as absence. `match` narrows to directories holding a name, such as `admin-gb`. " +
		"`mwdev_provenance` reports the state of the artifacts the engine reads, and this reports where sources live.",
	inputSchema: z.object({
		match: z.string().min(1).optional().describe("Show only directories holding an entry whose name contains this."),
	}),
	handler: async (args) => listDataDirectories(args["match"] as string | undefined),
})
