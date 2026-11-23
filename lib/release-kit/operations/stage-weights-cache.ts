// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { OperationEffect } from "@mailwoman/core/scripting"
import { z } from "zod"

import { defineOperation } from "#release-kit/operation"
import { flag, list, text } from "#release-kit/operations/inputs"
import { stageWeightsCache } from "#release-kit/weights/stage-weights-cache"

const StagedPackageSchema = z.object({
	locale: z.string(),
	packageDir: z.string(),
	staged: z.array(z.string()),
	omitted: z.array(z.string()),
	modelSHA256: z.string(),
	resolvedModelSHA256: z.string(),
})

/**
 * `release.stage-weights-cache` — writes the root it is given and reads the checkout and the data root.
 *
 * Listed in `registry.ts`; the description on the operation is what `mwops` prints.
 */
export const stageWeightsCacheOperation = defineOperation({
	id: "release.stage-weights-cache",
	description:
		"Stage a weights root (--out) for grading: the family's graph package and every overlay, copied from the workspaces and the data-root overlay. --export <run>/export --recipe <config> stages a training export's graph with a card derived from the published one; --file [locale:]name=path, --omit [locale:]name and --card diverge it. Refuses a root missing a declared artifact or whose packages resolve another graph.",
	effect: OperationEffect.LocalWrite,
	options: {
		out: { type: "string", short: "o" },
		family: { type: "string" },
		locales: { type: "string" },
		export: { type: "string" },
		graph: { type: "string" },
		recipe: { type: "string" },
		"base-card": { type: "string" },
		card: { type: "string" },
		file: { type: "string" },
		omit: { type: "string" },
		replace: { type: "boolean" },
	},
	inputSchema: z
		.object({
			out: z.string({ error: "--out <dir> is required" }),
			family: text,
			locales: list,
			export: text,
			graph: text,
			recipe: text,
			"base-card": text,
			card: text,
			file: list,
			omit: list,
			replace: flag,
		})
		.strict(),
	outputSchema: z.object({
		cacheRoot: z.string(),
		family: z.string(),
		graph: z.object({ source: z.string(), md5: z.string(), sha256: z.string() }),
		card: z.enum(["published", "derived", "given"]),
		packages: z.array(StagedPackageSchema),
	}),
	run: async (input, context) => {
		const report = await stageWeightsCache({
			repoRoot: context.repoRoot,
			out: input.out,
			locales: input.locales,
			file: input.file,
			omit: input.omit,
			replace: input.replace,
			log: context.log,
			...(input.family ? { family: input.family } : {}),
			...(input.export ? { exportDirectory: input.export } : {}),
			...(input.graph ? { graph: input.graph } : {}),
			...(input.recipe ? { recipe: input.recipe } : {}),
			...(input["base-card"] ? { baseCard: input["base-card"] } : {}),
			...(input.card ? { card: input.card } : {}),
		})

		// `outputSchema` serializes the report to JSON.
		// That's the boundary where the directory builders become strings.
		return {
			...report,
			cacheRoot: report.cacheRoot.toString(),
			packages: report.packages.map((staged) => ({ ...staged, packageDir: staged.packageDir.toString() })),
		}
	},
})
