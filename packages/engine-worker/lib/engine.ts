/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine behind the Worker's `/v1/parse` and `/v1/geocode`: Earth's browser pipeline for the parse, and the
 *   gazetteer cascade over a place lookup for the coordinate. The serve engine's `extractGeocodeResult` projects the
 *   resolved tree, so a geocode answer has the serve engine's shape at the admin tier.
 */

import type { MailwomanAPIEngine } from "@mailwoman/api/engine"
import { type AddressTree, decodeAsTuples, decodeAsXML } from "@mailwoman/core/decoder"
import type { ResolveOpts } from "@mailwoman/core/resolver"
import { CandidateResolverBackend, type MailwomanLookupLike } from "@mailwoman/resolver-wof-wasm/browser-cascade"
import { createWOFResolver } from "@mailwoman/resolver/resolve"
import { extractGeocodeResult } from "mailwoman/geocode/result"

/**
 * The loaded parse stack of one release.
 */
export interface ReleasePipeline {
	/**
	 * The release's version, such as `10.8.0`.
	 */
	version: string

	/**
	 * Parses an address into its decoded tree.
	 */
	parse(input: string): Promise<AddressTree>
}

export interface EngineWorkerEngineOptions {
	/**
	 * Resolves the pipeline, loading it on the first call.
	 * Every request awaits the same load.
	 */
	pipeline: () => Promise<ReleasePipeline>

	/**
	 * The place lookup the cascade sends each gazetteer query to, such as the gazetteer Worker's binding.
	 */
	lookup: MailwomanLookupLike

	/**
	 * The landmark layers a bare place name reads, such as the gazetteer Worker's `findLandmarks`.
	 */
	landmarkLayers?: Pick<ResolveOpts, "landmarks" | "osmPlaces">
}

/**
 * The Worker's `MailwomanAPIEngine`: `parse`, `geocode` and `health`.
 *
 * The parse runs `runClassifyStage`, the same stage Earth runs in the browser,
 * so the request's `input_mode` has no effect.
 * The geocode resolves the parsed tree through the gazetteer cascade and answers at
 * admin tier: the street tiers' databases are not reachable from the Worker.
 */
export function createEngineWorkerEngine({
	pipeline,
	lookup,
	landmarkLayers = {},
}: EngineWorkerEngineOptions): MailwomanAPIEngine {
	const resolver = createWOFResolver(new CandidateResolverBackend(lookup))

	return {
		parse: async (address, opts) => {
			const tree = await (await pipeline()).parse(address)

			return {
				input: address,
				components: decodeAsTuples(tree).map(([tag, value]) => ({ tag, value })),
				tree,
				debug: opts.debug ? decodeAsXML(tree) : null,
			}
		},

		geocode: async (address, init) => {
			const tree = await (await pipeline()).parse(address)

			const resolved = await resolver.resolveTree(tree, {
				writtenInput: address,
				...landmarkLayers,
				...(init.bias.length ? { bias: init.bias.map((point) => ({ ...point })) } : {}),
			})

			return { ...extractGeocodeResult(address, resolved), tree: init.includeTree ? tree : null }
		},

		health: async () => ({ engine: "worker" }),
	}
}
