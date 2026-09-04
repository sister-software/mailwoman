/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { text } from "#operations/inputs"
import { generateSBOM } from "#release/sbom"

/**
 * `release.sbom` — writes inside the checkout or the data root. Listed in `registry.ts`; the description on the
 * operation is what `mwops` prints.
 */
export const sbom = defineOperation({
	id: "release.sbom",
	description:
		"Generate SPDX 2.3 + CycloneDX 1.5 SBOMs for the PUBLISHED mailwoman package (--version, default: the workspace version) into docs/static/sbom (--out).",
	effect: OperationEffect.LocalWrite,
	inputSchema: z.object({ version: text, out: text }).strict(),
	outputSchema: z.object({ version: z.string(), spdxPath: z.string(), cdxPath: z.string(), dependencies: z.number() }),
	run: (input, context) =>
		generateSBOM({
			repoRoot: context.repoRoot,
			...(input.version ? { version: input.version } : {}),
			...(input.out ? { out: input.out } : {}),
			log: context.log,
		}),
})
