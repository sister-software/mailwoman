// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Loads the default `en-us` release the way Earth does, without its gazetteer: the gazetteer Worker answers place
 *   lookups, so this isolate holds the classifier, the FST prior, the street-morphology matcher, the pair indexes and
 *   the anchor regions.
 */

import { runClassifyStage } from "mailwoman/browser-runtime/classify"
import { silentAssetProgress } from "mailwoman/browser-runtime/family-bundles"
import { loadReleaseAssets } from "mailwoman/browser-runtime/load-assets"
import { fetchReleasesManifest } from "mailwoman/browser-runtime/manifest"

import { installBundledWasm, ORT_WASM_TAG_URL } from "#bundled-wasm"
import type { ReleasePipeline } from "#engine"

/**
 * Loads the releases manifest's default release and returns its parse stack.
 *
 * @throws When the manifest is missing or lists no default release.
 */
export async function loadDefaultReleasePipeline(): Promise<ReleasePipeline> {
	installBundledWasm()

	const manifest = await fetchReleasesManifest("en-us")
	const release = manifest?.releases.find((entry) => entry.version === manifest.defaultVersion)

	if (!release) throw new Error("The en-us releases manifest lists no default release")

	const assets = await loadReleaseAssets(release, silentAssetProgress(), { ortWASMURL: ORT_WASM_TAG_URL })

	return {
		version: release.version,
		parse: async (input) => {
			const { tree } = await runClassifyStage(input, {
				classifier: assets.classifier,
				fst: assets.fstMatcher,
				streetMorphology: assets.streetMorphologyMatcher,
				selectPairIndex: assets.selectPairIndex,
				anchorRegions: assets.anchorRegions,
			})

			return tree
		},
	}
}
