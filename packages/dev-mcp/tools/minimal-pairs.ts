/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_minimal_pairs` tool definition — the description an agent reads, the input schema, and the handler
 *   wiring. The measurement lives in `../minimal-pairs.ts`.
 */

import { z } from "zod"

import { runMinimalPairs, type Ladder } from "../minimal-pairs.ts"
import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { ENGINE_CONFIG_SCHEMA } from "../tool-kit.ts"

const RUNGS_SCHEMA = z
	.array(z.string())
	.min(2)
	.describe(
		"Ordered inputs, each differing MINIMALLY from the one before it. Order matters: the diff is against the " +
			"previous rung, so put the simplest form first and add one element at a time."
	)

const LADDER_SCHEMA = z.object({
	label: z.string().optional().describe("Name for this ladder in the output. Defaults to ladder-<n>."),
	rungs: RUNGS_SCHEMA,
})

export const minimalPairsTool = ({ registry }: DevToolDeps): DevTool => ({
	name: "mwdev_minimal_pairs",
	description:
		"WHICH TOKEN BREAKS IT. Walk a ladder of near-identical inputs through ONE engine and report the first rung " +
		"whose components or coordinate change, plus what changed as gained / lost / value-changed tags. Every other " +
		"measurement here varies the CONFIGURATION and holds the input fixed; this varies the INPUT and holds the " +
		"configuration fixed, which is the only way to attribute a failure to a token rather than a setting. Use it " +
		"when a row fails and you do not yet know WHERE: strip the address to its bare admin tail, then add back one " +
		"element per rung. `07691 Portopetro, Illes Balears, Spain` discards the region that `Portopetro, Illes " +
		"Balears, Spain` keeps, and adding `15, ` then displaces the locality — two separate stages, no street " +
		"involved, and neither is visible in a per-country score. RUNGS ARE YOURS TO WRITE: nothing is generated, " +
		"because generating them asserts a component order that would be silently wrong for some locale. A ladder " +
		"that does not diverge is a MEASURED negative and says so.",
	inputSchema: z.object({
		ladders: z
			.array(LADDER_SCHEMA)
			.min(1)
			.describe("One or more ladders. Several are measured through the same engine, so they are comparable."),
		config: ENGINE_CONFIG_SCHEMA.optional().describe(
			"Held FIXED across every rung of every ladder — varying it would make the input attribution meaningless."
		),
	}),
	handler: async (args) =>
		runMinimalPairs(registry, {
			ladders: args["ladders"] as Ladder[],
			config: args["config"] as never,
		}),
})

export { MOVED_KM } from "../minimal-pairs.ts"
