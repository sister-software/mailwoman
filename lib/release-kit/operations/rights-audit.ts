/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#release-kit/operation"
import { auditRights, packagesWithoutFrozenManifest, renderRightsAudit } from "#release-kit/release/rights-audit"

const registerAudit = z.object({
	sources: z.number(),
	eligible: z.number(),
	refusals: z.array(z.object({ because: z.string(), sources: z.number() })),
})

const packageAudit = z.object({
	package: z.string(),
	version: z.string(),
	versionSeries: z.string(),
	modelCardVersion: z.string().nullable(),
	artifacts: z.number(),
	digestsRecorded: z.number(),
	attributionEntries: z.number(),
	entriesNamingNoLicense: z.number(),
	entriesNotTraining: z.number(),
	entriesStatingNoUse: z.number(),
	foreignAttribution: z.number(),
	lineage: z.array(z.string()),
	lineageUnresolved: z.string().nullable(),
	shipsRightsFiles: z.boolean(),
	openQuestions: z.number(),
})

const trainingAudit = z.object({
	package: z.string(),
	corpusNamed: z.string().nullable(),
	manifest: z
		.object({
			corpusVersion: z.string(),
			profile: z.string(),
			sources: z.number(),
			totalRows: z.number(),
			problems: z.array(z.string()),
		})
		.nullable(),
	unresolved: z.string().nullable(),
})

/**
 * `release.rights-audit` — reads and makes no change.
 *
 * An empty `unresolved` list means this pass could read every item it examined.
 * Whether any artifact is cleared for use is a separate question.
 *
 * @throws After printing the report, when a package's model card records a corpus
 * and the repository holds no frozen training manifest for it.
 * The release workflow runs this operation, so that package stops the release
 * until the record is committed.
 */
export const rightsAudit = defineOperation({
	id: "release.rights-audit",
	description:
		"Read the source register, every published weights package's provenance record, and any frozen training manifest, and report what the chain from a source's terms to a published tarball establishes and what it leaves open. Fails when a model card records a corpus that has no frozen training manifest.",
	effect: OperationEffect.Read,
	inputSchema: z.object({}).strict(),
	outputSchema: z.object({
		register: registerAudit,
		packages: z.array(packageAudit),
		training: z.array(trainingAudit),
		established: z.array(z.string()),
		unresolved: z.array(z.string()),
	}),
	run: async (_input, context) => {
		const audit = await auditRights(context.repoRoot)

		for (const line of renderRightsAudit(audit)) {
			context.log(line)
		}

		const missing = packagesWithoutFrozenManifest(audit)

		if (missing.length) {
			throw new Error(
				`${missing.length} package(s) record a training corpus that has no frozen training manifest under ` +
					`packages/corpus/data/training-manifests/, so which records trained the model is unrecorded: ` +
					`${missing.join(", ")}. Write the record with freeze-overlay-manifest.run.ts or commit the build's ` +
					`TRAINING_SOURCES.json under the corpus version the card records.`
			)
		}

		return audit
	},
})
