// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The validation groups of the evaluation-group policy, chosen by a per-country quota.
 *
 *   Under the evaluation-group policy (HOLDOUT_AND_EVALUATION section 4.6) `val` holds only what the trainer's
 *   validation loss and the launch preflight's validation audits read. For each country the quota walks the
 *   groups of the holdout policy's held-out places in the order of their group hash, lowest first, and takes
 *   groups until the country reaches its target rows and target street rows, or the cap. A country whose whole
 *   pool is under its target keeps the pool.
 *
 *   A target is `min(cap, max(margin × floor, minimum))`, the floor being the training config's
 *   `required_validation_coverage` entry for the country. The street target is `min(cap, margin × street floor)`.
 *   The quota parameters and the list's sha256 join the split policy hash.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"

import {
	type EvaluationGroups,
	type EvaluationGroupsIdentity,
	evaluationGroupsIdentity,
	readEvaluationGroups,
	type RequiredGroupSkip,
} from "#utils/evaluation-groups"
import { hashUint32 } from "#utils/split"

/**
 * The attribute name a validation-group file declares.
 */
export const VALIDATION_GROUPS_ATTRIBUTE = "validation-groups"

/**
 * The quota's parameters.
 */
export interface ValidationQuota {
	/**
	 * The multiple of a country's validation floor its target asks for.
	 */
	margin: number
	/**
	 * The rows every country with a held-out pool aims at, floor or none.
	 */
	minimumRows: number
	/**
	 * The most rows one country's validation groups may hold.
	 */
	capRows: number
}

/**
 * The quota the v0.8.19 corpus is split under.
 */
export const DEFAULT_VALIDATION_QUOTA: ValidationQuota = { margin: 2, minimumRows: 200, capRows: 20_000 }

/**
 * A country's validation floor, as the training config states it.
 */
export interface ValidationFloor {
	minRows: number
	minStreetRows: number
}

/**
 * A country's quota target.
 */
export interface ValidationTarget {
	rows: number
	streetRows: number
}

/**
 * The target of one country under a quota: `min(cap, max(margin × floor, minimum))` rows
 * and `min(cap, margin × street floor)` street rows.
 * A country without a floor aims at the minimum.
 */
export function validationTarget(floor: ValidationFloor | undefined, quota: ValidationQuota): ValidationTarget {
	return {
		rows: Math.min(quota.capRows, Math.max(Math.ceil(quota.margin * (floor?.minRows ?? 0)), quota.minimumRows)),
		streetRows: Math.min(quota.capRows, Math.ceil(quota.margin * (floor?.minStreetRows ?? 0))),
	}
}

/**
 * One group of a country's held-out pool.
 */
export interface ValidationCandidate {
	country: string
	group: string
	rows: number
	streetRows: number
}

/**
 * What the quota took from one country.
 */
export interface ValidationCountrySelection {
	target: ValidationTarget
	/**
	 * The country's held-out pool, as far as the caller read it.
	 */
	poolRows: number
	poolGroups: number
	rows: number
	streetRows: number
	groups: number
	/**
	 * The pool ran out before the target was met, so the country keeps all of it.
	 */
	exhausted: boolean
}

/**
 * Takes each country's groups lowest `hashUint32` first, ties broken by the group string,
 * until the country holds its target rows and street rows or reaches the cap.
 *
 * A caller may pass only the head of a country's pool in hash order, as long as the head reaches the cap.
 * `poolRows` and `poolGroups` then describe that head, and the caller records the whole pool's figures.
 */
export function selectValidationGroups(
	candidates: Iterable<ValidationCandidate>,
	targetOf: (country: string) => ValidationTarget,
	quota: ValidationQuota
): { groups: string[]; countries: Record<string, ValidationCountrySelection> } {
	const byCountry = Map.groupBy(candidates, (candidate) => candidate.country)
	const groups: string[] = []
	const countries: Record<string, ValidationCountrySelection> = {}

	for (const country of [...byCountry.keys()].toSorted()) {
		const pool = byCountry
			.get(country)!
			.map((candidate) => ({ ...candidate, hash: hashUint32(candidate.group) }))
			.toSorted((a, b) => a.hash - b.hash || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))

		const target = targetOf(country)

		const selection: ValidationCountrySelection = {
			target,
			poolRows: pool.reduce((sum, candidate) => sum + candidate.rows, 0),
			poolGroups: pool.length,
			rows: 0,
			streetRows: 0,
			groups: 0,
			exhausted: false,
		}

		for (const candidate of pool) {
			const met = selection.rows >= target.rows && selection.streetRows >= target.streetRows

			if (met || selection.rows >= quota.capRows) break

			groups.push(candidate.group)
			selection.rows += candidate.rows
			selection.streetRows += candidate.streetRows

			selection.groups++
		}

		selection.exhausted =
			selection.groups === pool.length && (selection.rows < target.rows || selection.streetRows < target.streetRows)

		countries[country] = selection
	}

	return { groups: groups.toSorted(), countries }
}

/**
 * The file a quota pass writes beside the corpus it measured.
 */
export interface ValidationGroupsFile {
	attribute: typeof VALIDATION_GROUPS_ATTRIBUTE
	/**
	 * The corpus manifest whose held-out pool was read.
	 */
	drawnFrom: { manifest: string; sha256: string; corpusVersion: string | null }
	/**
	 * The training config whose validation floors set the targets.
	 */
	config: { path: string; sha256: string }
	/**
	 * The frozen group list the pool excluded.
	 */
	evaluationGroups: EvaluationGroupsIdentity
	/**
	 * The groups the config's training receipts require and the pool left out, by country.
	 * A file written before the skip records none.
	 */
	requiredTrainingGroups?: RequiredGroupSkip
	quota: ValidationQuota
	countries: Record<string, ValidationCountrySelection>
	groups: string[]
}

/**
 * The validation lookup a split applies.
 */
export interface ValidationGroups {
	path: string
	sha256: string
	quota: ValidationQuota
	/**
	 * The frozen list's sha256 the pool excluded.
	 */
	evaluationGroupsSHA256: string
	groups: ReadonlySet<string>
}

/**
 * Reads a validation-group file.
 *
 * @throws When the file declares another attribute or records no quota.
 */
export async function readValidationGroups(path: string): Promise<ValidationGroups> {
	const file = await readLocalJSONFile<ValidationGroupsFile>(path)

	if (file.attribute !== VALIDATION_GROUPS_ATTRIBUTE || !Array.isArray(file.groups)) {
		throw new Error(`${path} is not a validation-group file`)
	}

	if (!file.quota || typeof file.evaluationGroups?.sha256 !== "string") {
		throw new Error(`${path} records no quota or no frozen list`)
	}

	return {
		path,
		sha256: await sha256File(path),
		quota: file.quota,
		evaluationGroupsSHA256: file.evaluationGroups.sha256,
		groups: new Set(file.groups),
	}
}

/**
 * The two lists the evaluation-group policy applies.
 *
 * Frozen groups go to `test` and validation groups go to `val`.
 */
export interface EvaluationGroupPolicy {
	frozen: EvaluationGroups
	validation: ValidationGroups
}

/**
 * Pairs the two lists, refusing a validation list drawn against another frozen list
 * or one that holds a frozen group, since such a group's rows could take only one split.
 */
export function evaluationGroupPolicy(frozen: EvaluationGroups, validation: ValidationGroups): EvaluationGroupPolicy {
	if (validation.evaluationGroupsSHA256 !== frozen.sha256) {
		throw new Error(
			`${validation.path} was drawn against frozen list ${validation.evaluationGroupsSHA256}; ` +
				`${frozen.path} has sha256 ${frozen.sha256}`
		)
	}

	for (const group of validation.groups) {
		if (frozen.groups.has(group)) throw new Error(`${validation.path} lists frozen group ${group}`)
	}

	return { frozen, validation }
}

/**
 * Reads both lists and pairs them with {@linkcode evaluationGroupPolicy}.
 */
export async function readEvaluationGroupPolicy(paths: {
	evaluationGroups: string
	validationGroups: string
}): Promise<EvaluationGroupPolicy> {
	return evaluationGroupPolicy(
		await readEvaluationGroups(paths.evaluationGroups),
		await readValidationGroups(paths.validationGroups)
	)
}

/**
 * What a split policy hash and a corpus manifest record about the policy applied.
 */
export interface EvaluationGroupPolicyIdentity {
	evaluationGroups: EvaluationGroupsIdentity
	validationGroups: { sha256: string; quota: ValidationQuota; groups: number }
}

/**
 * The identity of a policy: both lists' sha256, the frozen sets, the quota and the group counts.
 */
export function evaluationGroupPolicyIdentity(policy: EvaluationGroupPolicy): EvaluationGroupPolicyIdentity {
	return {
		evaluationGroups: evaluationGroupsIdentity(policy.frozen),
		validationGroups: {
			sha256: policy.validation.sha256,
			quota: policy.validation.quota,
			groups: policy.validation.groups.size,
		},
	}
}
