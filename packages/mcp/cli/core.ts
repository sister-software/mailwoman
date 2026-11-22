// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The classifier, resolver and state databases behind the MCP server's core-backed tools,
 *   and the geocode of one address over them.
 *
 *   The module is separate from `main.ts` because that file connects the server when it loads.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { memoizeResettable } from "@mailwoman/core/memoize"
import type { Resolver } from "@mailwoman/core/resolver"
import { NeuralAddressClassifier, type ScriptRoutedClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import { buildNoGazetteerMessage, createResolverBackend, resolveCandidateDBPath } from "mailwoman/resolver-backend"

import type { MCPGeocodeParent } from "#tools"

const CORE_BACKED_TOOLS = "mailwoman_parse, mailwoman_geocode, mailwoman_poi_search, mailwoman_overpass_export"

const CORE_FREE_TOOLS =
	"mailwoman_layer_manifest, mailwoman_bdc_filing_landscape, mailwoman_filer_lookup, mailwoman_filer_family"

/**
 * The classifier, resolver and state databases the core-backed tools share.
 *
 * A failed load, such as a missing gazetteer, is retried by the next tool call,
 * so installing the data needs no server restart.
 */
export const loadCore = memoizeResettable(
	async (): Promise<{
		classifier: ScriptRoutedClassifier<NeuralAddressClassifier>
		resolver: Resolver
		/**
		 * The concrete US provider, because `GeocodeDeps.databases` accepts a null state slug.
		 */
		databases: USStateDatabaseProvider
	}> => {
		const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		const wofPaths: string[] = []

		for (const extractPath of wofExtractPaths()) {
			if (await pathExists(extractPath)) {
				wofPaths.push(extractPath)
			}
		}

		const candidateDB = await resolveCandidateDBPath()

		if (!candidateDB && !wofPaths.length) {
			throw new Error(
				`${buildNoGazetteerMessage({
					dataRoot: dataRootPath(),
					docsPath: "/docs/reference/data-and-locales",
				})}\n\n  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
		const resolver = createWOFResolver(backend)

		let classifier: ScriptRoutedClassifier<NeuralAddressClassifier>

		try {
			classifier = await NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })
		} catch (error) {
			throw new Error(
				`✗ ${error instanceof Error ? error.message : String(error)}\n\n` +
					`  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		const databases = await USStateDatabaseProvider.create(resolverMod, dataRootPath())

		return { classifier, resolver, databases }
	}
)

/**
 * Geocodes one address over the shared core, inside `parent` when the caller gives one.
 */
export async function geocodeThroughCore(
	address: string,
	parent: MCPGeocodeParent | null = null
): Promise<GeocodeResult> {
	const { classifier, resolver, databases } = await loadCore()

	return geocodeAddress(address, {
		classifier,
		resolver,
		databases: databases.for,
		...(parent ? { parentPlace: { id: parent.id, source: "caller", strength: parent.scope } } : {}),
	})
}
