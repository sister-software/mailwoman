// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The `parallelMapWorkers` handler behind `ingestWOF`: reads one WOF record and extracts its stored fields.
 *
 * The record's walk index travels with it, so the caller can write records in walk order
 * although the pool returns them in completion order.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { workerUserData } from "@mailwoman/core/workers"

import { type ExtractedWOFFeature, extractWOFFeature } from "#tools/pipeline/admin/wof-feature"

/**
 * What every worker receives.
 */
export interface WOFFeatureWorkerData {
	/**
	 * The placetypes to keep.
	 * Every other record extracts to `null`.
	 */
	placetypes: string[]
}

/**
 * One record to read: its position in the walk and its path.
 */
export interface WOFFeatureItem {
	index: number
	path: string
}

/**
 * One record's extraction, under its position in the walk.
 */
export interface WOFFeatureResult {
	index: number
	feature: ExtractedWOFFeature | null
}

const placetypes = new Set(workerUserData<WOFFeatureWorkerData>().placetypes)

/**
 * Reads and extracts one record.
 */
export async function handleItem(item: WOFFeatureItem): Promise<WOFFeatureResult> {
	return { index: item.index, feature: extractWOFFeature(await readLocalTextFile(item.path), placetypes) }
}
