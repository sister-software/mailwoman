/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The plan → execute contract for external writes. `computeReleasePlan` describes what a release of
 *   THIS checkout would publish — HEAD, the version, every release workspace at its manifest version,
 *   every weights artifact a checkout does not carry, and the destinations — and seals it under a
 *   digest. An external-write operation takes the plan file back, recomputes the plan from the
 *   checkout it is about to publish, and refuses when HEAD is dirty, HEAD moved, or the digest
 *   differs: the tree being published is then not the tree that was planned.
 *
 *   The digest covers everything but itself, over canonical JSON (sorted keys), so two checkouts of
 *   the same commit with the same manifests produce the same plan regardless of where they live.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { dirtyTrackedFiles, gitHead } from "@mailwoman/core/git"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "mailwoman/eval-harness/preregistration"
import { resolvePath } from "path-ts"

import { releaseWorkspaces } from "#release/stage"
import {
	type ArtifactOrigin,
	hfVersionBase,
	planWeightsMaterialization,
	readBaseModelVersion,
} from "#weights/fetch-hf-weights"

export interface ReleasePlanPackage {
	workspace: string
	name: string
	version: string
}

export interface ReleasePlanDestinations {
	npmRegistry: string
	/**
	 * The versioned Hugging Face bucket directory the weights artifacts are read from.
	 */
	hfBase: string
}

export interface ReleasePlan {
	gitHead: string
	version: string
	packages: ReleasePlanPackage[]
	artifacts: Array<{ workspace: string; filename: string; origin: ArtifactOrigin["kind"]; expectedMD5?: string }>
	destinations: ReleasePlanDestinations
	planDigest: string
}

const NPM_REGISTRY = "https://registry.npmjs.org"

export async function computeReleasePlan(repoRoot: string): Promise<ReleasePlan> {
	const head = await gitHead(repoRoot)
	const root = await readLocalJSONFile<{ version: string }>(resolvePath(repoRoot, "package.json"))
	const packages: ReleasePlanPackage[] = []

	for (const workspace of await releaseWorkspaces(repoRoot)) {
		const manifest = await readLocalJSONFile<{ name: string; version: string }>(
			resolvePath(repoRoot, workspace, "package.json")
		)

		packages.push({ workspace, name: manifest.name, version: manifest.version })
	}

	const artifacts: ReleasePlan["artifacts"] = (await planWeightsMaterialization(repoRoot)).map((artifact) => ({
		workspace: artifact.workspace,
		filename: artifact.filename,
		origin: artifact.origin.kind,
		...(artifact.expectedMD5 ? { expectedMD5: artifact.expectedMD5 } : {}),
	}))

	const modelVersion = await readBaseModelVersion(repoRoot)

	const body = {
		gitHead: head,
		version: root.version,
		packages,
		artifacts,
		destinations: { npmRegistry: NPM_REGISTRY, hfBase: await hfVersionBase(repoRoot, modelVersion) },
	}

	return { ...body, planDigest: sha256Hex(canonicalJSON(body)) }
}

/**
 * Read a plan file and refuse unless the checkout still matches it. Answers the recomputed plan so the caller publishes
 * from what it verified.
 */
export async function assertPlanHolds(repoRoot: string, planPath: string): Promise<ReleasePlan> {
	const planned = await readLocalJSONFile<ReleasePlan>(resolvePath(repoRoot, planPath))
	const dirty = await dirtyTrackedFiles(repoRoot)

	if (dirty.length) {
		throw new Error(
			`release plan: HEAD is dirty — ${dirty.length} tracked file(s) carry uncommitted changes:\n${dirty.join("\n")}`
		)
	}

	const current = await computeReleasePlan(repoRoot)

	if (current.gitHead !== planned.gitHead) {
		throw new Error(`release plan: HEAD is ${current.gitHead} but the plan was computed at ${planned.gitHead}.`)
	}

	if (current.planDigest !== planned.planDigest) {
		throw new Error(
			`release plan: the recomputed digest ${current.planDigest} differs from the planned ${planned.planDigest} — ` +
				"the version, the release list, a manifest, or the weights artifact set changed since the plan was written."
		)
	}

	return current
}
