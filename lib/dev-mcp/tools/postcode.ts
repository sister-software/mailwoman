/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { lookupPostcodeRegions } from "#dev-mcp/postcode"
import type { DevTool } from "#dev-mcp/tool-kit"

const INPUT = z.object({
	postcode: z.string().trim().min(1).max(64).describe("A complete postcode, preserving leading zeroes."),
	data_root: z
		.string()
		.min(1)
		.optional()
		.describe("Data root containing geonames-postal. Defaults to the configured data root."),
})

/**
 * Exposes postcode format candidates, source records and administrative associations.
 */
export const postcodeTool = (): DevTool => ({
	name: "mwdev_postcode",
	description:
		"Look up a complete postcode across matching address systems. Returns raw GeoNames postal records, " +
		"source paths and a resolved table of places and administrative names and codes. Reads local TXT or ZIP exports. " +
		"Missing or unreadable data raises an error. Source administrative codes carry no WOF identity.",
	inputSchema: INPUT,
	handler: async (args) => {
		const input = INPUT.parse(args)

		return lookupPostcodeRegions(input.postcode, input.data_root)
	},
})
