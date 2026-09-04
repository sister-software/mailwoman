/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { z } from "zod"

import { defineOperation, OperationEffect } from "#operation"
import { computeReleasePlan, type ReleasePlanDestinations, type ReleasePlanPackage } from "#release/plan"

const planPackage: z.ZodType<ReleasePlanPackage> = z.object({
	workspace: z.string(),
	name: z.string(),
	version: z.string(),
})

const planDestinations: z.ZodType<ReleasePlanDestinations> = z.object({ npmRegistry: z.string(), hfBase: z.string() })

const planSchema = z.object({
	gitHead: z.string(),
	version: z.string(),
	packages: z.array(planPackage),
	artifacts: z.array(
		z.object({
			workspace: z.string(),
			filename: z.string(),
			origin: z.enum(["hf", "repo"]),
			expectedMD5: z.string().optional(),
		})
	),
	destinations: planDestinations,
	planDigest: z.string(),
})

/**
 * `release.plan` — reads and changes nothing. Listed in `registry.ts`; the description on the operation is what `mwops`
 * prints.
 */
export const plan = defineOperation({
	id: "release.plan",
	description:
		"Describe what a release of this checkout publishes — HEAD, version, packages, weights artifacts, destinations — sealed under a digest that publish-workspace and bless-package re-verify.",
	effect: OperationEffect.Read,
	inputSchema: z.object({}),
	outputSchema: planSchema,
	run: (_input, context) => computeReleasePlan(context.repoRoot),
})
