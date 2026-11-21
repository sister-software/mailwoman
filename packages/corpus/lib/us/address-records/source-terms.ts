// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Joins each US address-layer source id to the register rows its data comes from,
 *   and reads each row's terms for redistribution.
 *
 *   The join goes through `us-situs-sources.json`, the table the situs databases already read:
 *   `overture:<dataset>`, `openaddresses:<member>` and `usgov-nad` each map to register rows.
 *   A source the table doesn't map is returned with no rows, so a reader reports it as uncovered.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { PathBuilderLike } from "path-ts"

import { readAddressSourceRegister } from "#source-register/register"
import { registerRowTerms, type RegisterRowTerms, type RegisterTermsInput } from "#source-register/terms"
import { usSitusSourcesPath } from "#us/recipes/house-venue-tuples"

/**
 * The register rows one layer source maps to, each with its terms for redistribution.
 */
export interface USAddressSourceTerms {
	source: string
	/**
	 * The rows in the table's order: the publishing body's own row first,
	 * then any aggregator it reached the layer through.
	 *
	 * Empty when the table maps the source to no row.
	 */
	rows: readonly RegisterRowTerms[]
}

/**
 * Reads a layer source's register terms.
 */
export type USAddressSourceTermsReader = (source: string) => USAddressSourceTerms

/**
 * Reads the register and the source table once, and returns a reader over both.
 *
 * @param register The committed register when absent.
 * @param tablePath The committed `us-situs-sources.json` when absent.
 * @throws When the table doesn't exist, naming it.
 */
export async function readUSAddressSourceTerms(
	register?: RegisterTermsInput,
	tablePath: PathBuilderLike = usSitusSourcesPath()
): Promise<USAddressSourceTermsReader> {
	if (!(await pathExists(tablePath))) throw new Error(`No US situs source table at ${tablePath.toString()}`)

	const [decisions, table] = await Promise.all([
		register ?? readAddressSourceRegister(),
		readLocalJSONFile<{ sources: Record<string, readonly string[]> }>(tablePath),
	])

	const cache = new Map<string, RegisterRowTerms>()

	const rowTerms = (registerSource: string): RegisterRowTerms => {
		let terms = cache.get(registerSource)

		if (!terms) {
			terms = registerRowTerms(decisions, registerSource)
			cache.set(registerSource, terms)
		}

		return terms
	}

	return (source) => ({
		source,
		rows: (Object.hasOwn(table.sources, source) ? table.sources[source]! : []).map(rowTerms),
	})
}
