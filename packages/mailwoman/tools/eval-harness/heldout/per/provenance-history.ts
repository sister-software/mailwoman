// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"

import type { ProvenanceHistory, ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"
import { HELDOUT_PROVENANCE_CLASSES } from "#tools/eval-harness/release/requirements"

/**
 * Merges the `rows` of provenance files (`heldout/dataset/overlap.run.ts` writes them) into one history.
 *
 * @throws When a file holds no `rows` object, a row records `unknown`, another class
 * or no evidence, or two files class one row differently.
 */
export async function readProvenanceHistory(paths: readonly string[]): Promise<ProvenanceHistory> {
	const merged = new Map<string, ProvenanceRecord>()

	for (const path of paths) {
		const file = await readLocalJSONFile<{
			rows?: Record<string, ProvenanceRecord>
		}>(path)

		if (!file.rows) throw new Error(`${path} holds no rows object`)

		for (const [rowID, record] of Object.entries(file.rows)) {
			if (
				!(HELDOUT_PROVENANCE_CLASSES as readonly string[]).includes(record.provenance) ||
				(record.provenance as string) === "unknown"
			) {
				throw new Error(`${path} row ${rowID} has provenance ${String(record.provenance)}`)
			}

			if (typeof record.evidence !== "string" || !record.evidence) {
				throw new Error(`${path} row ${rowID} records no evidence`)
			}

			const earlier = merged.get(rowID)

			if (earlier && earlier.provenance !== record.provenance) {
				throw new Error(
					`${path} classes row ${rowID} ${record.provenance}; an earlier file classes it ${earlier.provenance}`
				)
			}

			merged.set(rowID, earlier ?? record)
		}
	}

	return merged
}
