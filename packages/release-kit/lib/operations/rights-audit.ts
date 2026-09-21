/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { auditRights, renderRightsAudit } from "#release/rights-audit"

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
 * `release.rights-audit` — reads and changes nothing.
 *
 * Its output is a report rather than a verdict.
 * An empty `unresolved` list means this pass found nothing it could not read,
 * which is not a statement that any artifact is cleared for any use.
 */
export const rightsAudit = defineOperation({
	id: "release.rights-audit",
	description:
		"Read the source register, every published weights package's provenance record, and any frozen training manifest, and report what the chain from a source's terms to a published tarball establishes and what it leaves open.",
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

		return audit
	},
})
