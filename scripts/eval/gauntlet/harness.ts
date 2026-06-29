/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared Gauntlet harness: build the full-pipeline geocode deps (optionally with a CANDIDATE model, so a
 *   gate can compare candidate-vs-production on the same inputs) and run one address end-to-end. The
 *   Gauntlet grades the ASSEMBLED output — coordinate + tier — not raw parse F1, the lesson this project
 *   paid for once (#566 / reconcile-retirement).
 */

import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { OsmShardProvider } from "@mailwoman/osm/sdk"
import { createWofResolver } from "@mailwoman/resolver"
import { type GeocodeResult, geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

export interface GauntletDeps {
	geocode(input: string): Promise<GeocodeResult>
	close(): void
}

/**
 * Build the geocode deps. `modelPath` swaps ONLY the ONNX (same tokenizer/card/anchor/gazetteer soft-feed),
 * so the held-out gate can grade a candidate against production fairly; omit it for the shipped default.
 */
export async function buildGauntletDeps(opts: { modelPath?: string } = {}): Promise<GauntletDeps> {
	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const classifier = opts.modelPath
		? await NeuralAddressClassifier.loadFromWeights({ locale: "en-US", modelPath: resolve(opts.modelPath) })
		: await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const resolver = createWofResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
	const shardProvider = new ShardProvider(resolverMod, mailwomanDataRoot())
	const osmProvider = new OsmShardProvider(mailwomanDataRoot())

	return {
		geocode: (input: string) =>
			geocodeAddress(input, { classifier, resolver, shards: shardProvider.for, osmShards: osmProvider.for }),
		close: () => {
			shardProvider.close()
			osmProvider.close()
		},
	}
}

/** The slice of the assembled result the Gauntlet asserts on. */
export interface GauntletResult {
	lat: number | null
	lon: number | null
	tier: GeocodeResult["resolution_tier"]
	locality: string | null
	region: string | null
	postcode: string | null
}

export async function runOne(input: string, deps: GauntletDeps): Promise<GauntletResult> {
	const g = await deps.geocode(input)

	return { lat: g.lat, lon: g.lon, tier: g.resolution_tier, locality: g.locality, region: g.region, postcode: g.postcode }
}
