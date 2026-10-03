// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The committed compiled geographic model, read once for whichever observation route asks.
 */

import type { CompiledGeographicModel } from "@mailwoman/geographic-model"
import { readCompiledGeographicModel } from "@mailwoman/geographic-model/packaged"

/**
 * The committed compiled artifact, read through the package that owns it.
 *
 * The runtime consumes a committed artifact produced from the authoring records,
 * and traversing authoring JSON is what the boundary record excludes.
 */
export async function readCommittedModel(): Promise<CompiledGeographicModel> {
	return await readCompiledGeographicModel()
}
