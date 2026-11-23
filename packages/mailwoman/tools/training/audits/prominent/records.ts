// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The WOF record a corpus group belongs to, and the records a corpus holds out by design.
 *
 *   A `rendered-prominent-places` row's group is its `base_source_id`, `wof-admin-<record>`.
 *   A `wof-admin` row's is `wof-admin-<record>-<name slot>-<hierarchy variant>`.
 *
 *   Both read back as `<record>`, so every group of a place's own rows reads as that place's record.
 *
 *   The prominent-place receipt (`coverage.ts`) neither requires nor counts a place the corpus holds
 *   out by design, and the held-out draws (`../required-groups.ts`) skip a required place's groups.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { recordIDSQL } from "@mailwoman/corpus/adapters/record-id"
import { type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { parquetColumnNames } from "@mailwoman/corpus/parquet/readers"
import type { CorpusDeletion } from "@mailwoman/corpus/tools/overlay/deletions"
import { baseManifestFiles, localManifestFilePath } from "@mailwoman/corpus/tools/overlay/manifest"
import { stageTrainRows, type TrainManifestFile } from "@mailwoman/corpus/tools/support-index"
import { readEvaluationGroupPolicy } from "@mailwoman/corpus/utils/validation-groups"

/**
 * The WOF record a corpus row's group belongs to, as a DuckDB `BIGINT` expression
 * over a group expression, `NULL` for a group of no WOF record.
 */
export function prominentPlaceRecordSQL(group: string): string {
	return `TRY_CAST(regexp_extract(${group}, '^wof-admin-([0-9]+)(-|$)', 1) AS BIGINT)`
}

/**
 * The places a corpus holds out by design, and the lists that hold them out.
 */
export interface HeldOutByDesign {
	/**
	 * The two lists of the corpus's evaluation-group policy, or `null` for a
	 * corpus split under no such policy.
	 */
	policy: {
		evaluation_groups: { path: string; sha256: string }
		validation_groups: { path: string; sha256: string }
	} | null
	/**
	 * WOF records with a group on either list.
	 */
	listed_records: number
	/**
	 * Listed records with a train row in a group of theirs that no list holds.
	 */
	trained_records: number
	/**
	 * Listed records with no such row: every one of their groups is frozen for grading
	 * or in the validation set.
	 */
	records: ReadonlySet<number>
}

interface PolicyManifest {
	deletions?: CorpusDeletion[]
	evaluation_groups?: {
		paths?: { evaluationGroups?: string; validationGroups?: string }
		evaluationGroups?: { sha256?: string }
		validationGroups?: { sha256?: string }
	} | null
}

const BATCH = 5000

/**
 * Reads the WOF records whose every group the corpus's evaluation-group policy holds out:
 * the lists the manifest records under `evaluation_groups.paths`, each checked against
 * the sha256 the manifest records, and the corpus's train rows of each listed record.
 *
 * Under the policy a group on neither list trains, so a listed record holds out by
 * design exactly when no train row belongs to any group of its.
 * A repository-relative list path is resolved from the repository root.
 *
 * @throws When the manifest records the policy without both paths,
 * or a list's sha256 isn't the one it records.
 */
export async function readHeldOutByDesign(
	manifestPath: string,
	limits?: DuckDBLimits,
	log?: (line: string) => void
): Promise<HeldOutByDesign> {
	const manifest = await readLocalJSONFile<PolicyManifest>(manifestPath)
	const record = manifest.evaluation_groups

	if (record == null) return { policy: null, listed_records: 0, trained_records: 0, records: new Set() }

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

	using db = await openDuckDB(limits)

	await db.run("CREATE TEMP TABLE excluded_ids (id VARCHAR)")
	await db.run("CREATE TEMP TABLE listed_groups (g VARCHAR)")
	await db.run("CREATE TEMP TABLE trained_records (id BIGINT)")

	const groups = [...policy.frozen.groups, ...policy.validation.groups]

	for (let start = 0; start < groups.length; start += BATCH) {
		await db.run(
			`INSERT INTO listed_groups VALUES ${groups
				.slice(start, start + BATCH)
				.map((group) => `('${escapeSQLString(group)}')`)
				.join(", ")}`
		)
	}

	await db.run(
		`CREATE TEMP TABLE listed_records AS SELECT DISTINCT ${prominentPlaceRecordSQL("g")} AS id FROM listed_groups ` +
			`WHERE ${prominentPlaceRecordSQL("g")} IS NOT NULL`
	)

	const listed = new Set(
		(await db.runAndReadAll("SELECT id FROM listed_records")).getRowObjectsJson().map((row) => Number(row["id"]))
	)

	const trained = new Set<number>()

	if (listed.size) {
		const files = baseManifestFiles<TrainManifestFile>(manifest)

		for (const [index, file] of files.entries()) {
			const columns = await parquetColumnNames(localManifestFilePath(file.path))
			const base = columns.includes("base_source_id") ? "CAST(base_source_id AS VARCHAR)" : "CAST(NULL AS VARCHAR)"
			const group = recordIDSQL(`coalesce(${base}, CAST(source_id AS VARCHAR))`)

			const staged = await stageTrainRows(
				db,
				manifestPath,
				file,
				manifest.deletions ?? [],
				`${prominentPlaceRecordSQL(group)} AS id`,
				limits,
				`starts_with(${group}, 'wof-admin-')`
			)

			if (staged) {
				await db.run(
					"INSERT INTO trained_records SELECT DISTINCT id FROM r WHERE id IN (SELECT id FROM listed_records) " +
						"AND id NOT IN (SELECT id FROM trained_records)"
				)
			}

			if ((index + 1) % 200 === 0 || index + 1 === files.length) {
				log?.(`[prominent] held out by design: ${index + 1}/${files.length} files read for listed records' train rows`)
			}
		}

		for (const row of (await db.runAndReadAll("SELECT id FROM trained_records")).getRowObjectsJson()) {
			trained.add(Number(row["id"]))
		}
	}

	return {
		policy: {
			evaluation_groups: { path: evaluationGroups, sha256: policy.frozen.sha256 },
			validation_groups: { path: validationGroups, sha256: policy.validation.sha256 },
		},
		listed_records: listed.size,
		trained_records: trained.size,
		records: new Set([...listed].filter((id) => !trained.has(id))),
	}
}
