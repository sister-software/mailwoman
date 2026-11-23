// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The WOF record a corpus group belongs to, and the groups a corpus's evaluation-group policy lists.
 *
 *   A `rendered-prominent-places` row's group is its `base_source_id`, `wof-admin-<record>`.
 *   A `wof-admin` row's is `wof-admin-<record>-<name slot>-<hierarchy variant>`.
 *
 *   Both read back as `<record>`, so every group of a place's own rows reads as that place's record.
 *
 *   The prominent-place receipt (`coverage.ts`) reads the listed groups' rows
 *   to find the forms the corpus holds out by design, and the held-out draws
 *   (`../required-groups.ts`) skip a required place's groups.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { readEvaluationGroupPolicy } from "@mailwoman/corpus/utils/validation-groups"

/**
 * The WOF record a corpus row's group belongs to, as a DuckDB `BIGINT` expression
 * over a group expression, `NULL` for a group of no WOF record.
 */
export function prominentPlaceRecordSQL(group: string): string {
	return `TRY_CAST(regexp_extract(${group}, '^wof-admin-([0-9]+)(-|$)', 1) AS BIGINT)`
}

/**
 * The groups a corpus's evaluation-group policy lists, and the lists that hold them.
 */
export interface ListedGroups {
	/**
	 * The two lists of the corpus's evaluation-group policy, or `null` for a
	 * corpus split under no such policy.
	 */
	policy: {
		evaluation_groups: { path: string; sha256: string }
		validation_groups: { path: string; sha256: string }
	} | null
	/**
	 * Every group on the frozen list or the validation list.
	 * The policy's re-split sends their rows to `test` and `val`.
	 */
	groups: ReadonlySet<string>
}

interface PolicyManifest {
	evaluation_groups?: {
		paths?: { evaluationGroups?: string; validationGroups?: string }
		evaluationGroups?: { sha256?: string }
		validationGroups?: { sha256?: string }
	} | null
}

/**
 * Reads the groups of the lists the manifest records under `evaluation_groups.paths`,
 * each checked against the sha256 the manifest records.
 *
 * A repository-relative list path is resolved from the repository root.
 *
 * @throws When the manifest records the policy without both paths,
 * or a list's sha256 isn't the one it records.
 */
export async function readListedGroups(manifestPath: string): Promise<ListedGroups> {
	const manifest = await readLocalJSONFile<PolicyManifest>(manifestPath)
	const record = manifest.evaluation_groups

	if (record == null) return { policy: null, groups: new Set() }

	const { evaluationGroups, validationGroups } = record.paths ?? {}

	if (!evaluationGroups || !validationGroups) {
		throw new Error(`${manifestPath} records an evaluation-group policy without both list paths`)
	}

	const resolve = (path: string) => (path.startsWith("/") ? path : repoRootPath(...path.split("/")))

	const policy = await readEvaluationGroupPolicy({
		evaluationGroups: resolve(evaluationGroups),
		validationGroups: resolve(validationGroups),
	})

	for (const [list, expected] of [
		[policy.frozen, record.evaluationGroups?.sha256],
		[policy.validation, record.validationGroups?.sha256],
	] as const) {
		if (list.sha256 !== expected) {
			throw new Error(`${list.path} has sha256 ${list.sha256}, but ${manifestPath} records ${expected}`)
		}
	}

	return {
		policy: {
			evaluation_groups: { path: evaluationGroups, sha256: policy.frozen.sha256 },
			validation_groups: { path: validationGroups, sha256: policy.validation.sha256 },
		},
		groups: new Set([...policy.frozen.groups, ...policy.validation.groups]),
	}
}
