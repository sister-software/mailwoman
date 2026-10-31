/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The holdout split of one stored parquet file, written as an attribute file keyed by its policy hash.
 *
 *   A stored file holds the rows of every split, and the attribute decides each row's split by its `source_id`:
 *   an id the attribute lists under `val` or `test` belongs there, and every other row belongs to `train`. The
 *   held-out lists are short, because a holdout keeps out a few small places.
 *
 *   The policy hash covers the holdout table and the code of `#utils/split`, the module whose `splitForRow`
 *   decides each row, so a change to either writes a new attribute file rather than relabeling an old one.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { canonicalJSON } from "@mailwoman/core/json"

import { moduleGraphHash } from "#build/code-hash"
import type { CountryHoldout, SplitName } from "#utils/split"

/**
 * The module whose `splitForRow` the policy hash covers, repository-relative.
 */
export const SPLIT_POLICY_MODULE = "packages/corpus/lib/utils/split.ts"

/**
 * The attribute name a version manifest records as deciding `split`.
 */
export const SPLIT_ATTRIBUTE = "split"

/**
 * The attribute file of one stored parquet file.
 */
export interface SplitAttributeFile {
	attribute: typeof SPLIT_ATTRIBUTE
	policyHash: string
	policy: { holdouts: Record<string, CountryHoldout>; codeHash: string }
	/**
	 * The parquet file the attribute describes, by name and sha256.
	 */
	file: { name: string; sha256: string; rows: number }
	counts: Record<SplitName, number>
	/**
	 * The held-out `source_id` values, sorted.
	 * A row whose id neither list holds belongs to `train`.
	 */
	val: string[]
	test: string[]
}

/**
 * The hash of one holdout policy: the holdout table and the code that applies it.
 */
export async function splitPolicyHash(
	holdouts: Record<string, CountryHoldout>
): Promise<{ policyHash: string; codeHash: string }> {
	const codeHash = await moduleGraphHash([SPLIT_POLICY_MODULE])

	return { policyHash: sha256Hex(canonicalJSON({ holdouts, codeHash })), codeHash }
}

/**
 * The attribute filename for a parquet file and a policy: `<stem>.split.<policy hash>.json`.
 */
export function splitAttributeFilename(parquetName: string, policyHash: string): string {
	return `${parquetName.replace(/\.parquet$/u, "")}.${SPLIT_ATTRIBUTE}.${policyHash}.json`
}

/**
 * The split one row belongs to under an attribute.
 */
export function splitOfSourceID(attribute: Pick<SplitAttributeFile, "val" | "test">, sourceID: string): SplitName {
	if (attribute.val.includes(sourceID)) return "val"

	if (attribute.test.includes(sourceID)) return "test"

	return "train"
}

/**
 * Read a split attribute file.
 *
 * @throws When the file declares a different attribute or its held-out lists are missing.
 */
export async function readSplitAttribute(path: string): Promise<SplitAttributeFile> {
	const attribute = await readLocalJSONFile<SplitAttributeFile>(path)

	if (attribute.attribute !== SPLIT_ATTRIBUTE || !Array.isArray(attribute.val) || !Array.isArray(attribute.test)) {
		throw new Error(`${path} is not a split attribute file`)
	}

	return attribute
}
