#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-nz overlay's dev artifacts.
 *
 *   en-nz declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so `resolveWeights`
 *   falls through to the en-us package for `model.onnx` and `tokenizer.model`. This overlay links
 *   no model or tokenizer and instead removes any leftover local pair, because a stale local file
 *   would shadow the base fallback and silently serve outdated bytes.
 *
 *   `resolveFromPackageDir` resolves these locally from the overlay dir with no base fallback:
 *
 *   - `anchor-lexicon-v1.json` and `country-surface-lexicon-v1.json`, checked-in repo files.
 *   - `street-type-lexicon-v*.json` and `locality-surface-lexicon-v*.json`, the evidence lexicons
 *       recorded by the card under `requires.<channel>.lexicon`, the same pair the `files` array ships.
 *   - `pair-index-nz.bin`, derived from the linz-derived OpenAddresses NZ countrywide CSV through
 *       the shared `buildPairIndexOverlay`. Its freshness guard compares the format, every
 *       calibrated magnitude and the source md5. The build is sidecar-cached because the CSV
 *       has 2.12M rows. `--delta 10` is the calibrated value and the artifact header records it.
 *       This locale ships without a `transitionBeta` because none was measured there.
 *
 *   There is no postcode binary to build, since no WOF NZ postcode extract exists and
 *   `release.config.json`'s `softFeed.postcodeDBByCountry` has no `nz` entry, so the anchor channel
 *   resolves off for en-nz until that extract is built.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * The linz-derived OpenAddresses NZ countrywide CSV, the build's one source, md5-recorded in the header.
 */
const NZ_SOURCE_CSV = dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv")

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-nz",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	pairIndex: {
		country: "nz",
		delta: PAIR_INDEX_DELTA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [NZ_SOURCE_CSV],
		extraArgs: ["--source", NZ_SOURCE_CSV],
	},
	streetMorphologyFST: true,
})
