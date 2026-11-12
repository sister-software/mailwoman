// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OperationEffect } from "@mailwoman/core/scripting"
import { z } from "zod"

import { defineOperation } from "#release-kit/operation"
import { writeWeightsRightsFiles } from "#release-kit/weights/rights/write"

const rightsFileState = z.object({ file: z.string(), changed: z.boolean() })

/**
 * `release.write-rights-files` — writes inside the checkout.
 *
 * Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const writeRightsFiles = defineOperation({
	id: "release.write-rights-files",
	description:
		"Regenerate every published weights package's LICENSE.md and PROVENANCE.json from its package.json and model-card.json. The `weights-rights` health check holds the tree equal to this output.",
	effect: OperationEffect.LocalWrite,
	options: {},
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({ files: z.array(rightsFileState) }),
	async run(_input, context) {
		return { files: await writeWeightsRightsFiles(context.repoRoot, context.log) }
	},
})
