// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The geocode session behind the MCP server's core-backed tools, with the classifier
 *   and resolver its parse tools read, and the geocode of one address through it.
 *
 *   The module is separate from `main.ts` because that file connects the server when it loads.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { GeocodeResult } from "@mailwoman/core/geocode"
import { memoizeResettable } from "@mailwoman/core/memoize"
import type { Resolver } from "@mailwoman/core/resolver"
import type { NeuralAddressClassifier, ScriptRoutedClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import type { LayerContribution } from "mailwoman/geocode/contributions"
import type { GeocodeRun, GeocodeSession } from "mailwoman/geocode/session"
import { createDropInGeocodeSession } from "mailwoman/geocode/session/drop-in"
import { buildNoGazetteerMessage, resolveCandidateDBPath } from "mailwoman/resolver-backend"
import { NODE_LAYER_CONTRIBUTIONS } from "mailwoman/services/entry/node"

import type { MCPGeocodeParent } from "#tools"

const CORE_BACKED_TOOLS = "mailwoman_parse, mailwoman_geocode, mailwoman_poi_search, mailwoman_overpass_export"

const CORE_FREE_TOOLS =
	"mailwoman_layer_manifest, mailwoman_bdc_filing_landscape, mailwoman_filer_lookup, mailwoman_filer_family"

/**
 * The data layers the MCP server composes: every layer `mailwoman geocode` composes, in the same order.
 *
 * The `mailwoman_geocode` tool therefore answers as that command does with its country scope off.
 */
const MCP_LAYERS: readonly LayerContribution[] = NODE_LAYER_CONTRIBUTIONS

/**
 * The session {@linkcode loadCore} built, kept so the server can close it at shutdown without building one.
 */
let openSession: GeocodeSession | null = null

/**
 * The geocode session the core-backed tools share, with the classifier and resolver it geocodes through.
 *
 * The session owns both, so a tool reads them and never disposes one.
 * A failed load, such as a missing gazetteer, is retried by the next tool call,
 * so installing the data needs no server restart.
 */
export const loadCore = memoizeResettable(
	async (): Promise<{
		session: GeocodeSession
		/**
		 * The data layers the session composes.
		 */
		layers: readonly LayerContribution[]
		classifier: ScriptRoutedClassifier<NeuralAddressClassifier>
		resolver: Resolver
	}> => {
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

		let session: GeocodeSession

		try {
			session = await createDropInGeocodeSession(MCP_LAYERS, candidateDB ? { candidateDB } : {})
		} catch (error) {
			throw new Error(
				`✗ ${error instanceof Error ? error.message : String(error)}\n\n` +
					`  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		openSession = session

		const { routed, lookup } = session.services

		return { session, layers: MCP_LAYERS, classifier: routed, resolver: createWOFResolver(lookup) }
	}
)

/**
 * Closes the shared session when one was built: its databases, its layers
 * and its lease on the data generation.
 *
 * The server calls it once, at shutdown, after the pipelines that read the session's resolver are closed.
 */
export async function closeCore(): Promise<void> {
	const session = openSession

	openSession = null

	await session?.[Symbol.asyncDispose]()
}

/**
 * Geocodes one address through the shared session, inside `parent` when the caller gives one.
 *
 * `applied` states the locale and country scope the session answered under, with the source of each.
 */
export async function geocodeRunThroughCore(
	address: string,
	parent: MCPGeocodeParent | null = null
): Promise<Pick<GeocodeRun, "result" | "applied">> {
	const { session } = await loadCore()

	const { result, applied } = await session.geocode(
		address,
		parent ? { parentPlace: { id: parent.id, source: "caller", strength: parent.scope } } : {}
	)

	return { result, applied }
}

/**
 * The `result` of {@linkcode geocodeRunThroughCore}, for a caller that reads only the answer.
 */
export async function geocodeThroughCore(
	address: string,
	parent: MCPGeocodeParent | null = null
): Promise<GeocodeResult> {
	return (await geocodeRunThroughCore(address, parent)).result
}
