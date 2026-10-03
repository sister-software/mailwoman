#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the fr-fr overlay's dev artifacts through
 *   `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`.
 *
 *   fr-fr declares `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"` and inherits the model,
 *   so this overlay links no model or tokenizer and removes any leftover local pair.
 *
 *   `pair-index-fr.bin` is built from BAN's `nom_ld` (lieu-dit) through `ban/sdk`'s `cleanLieuDit`,
 *   rather than WOF. Its French neighborhood records are Paris quartiers that never appear in a postal
 *   address. BAN is a directory of 101 département files, so the guard md5s no file and instead
 *   refuses an artifact below `minimumPlausibleBytes` (the BAN-derived index is ~6 MB, the
 *   admin-DB borough recipe ~1.9 kB).
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Raw BAN dump the lieu-dit pairs are extracted from.
 *
 * A directory belongs in `inputs` (existence only), not `sources` (md5).
 */
const BAN_DIR = dataRootPath("corpus", "sources", "ban")

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "fr-fr",
	model: { kind: "inherit" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	postcodeBinary: { country: "fr", database: wofDatabasePath("postalcode-intl.db") },
	pairIndex: {
		country: "fr",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
		sources: [],
		inputs: [BAN_DIR],
		extraArgs: ["--ban-dir", BAN_DIR],
		minimumPlausibleBytes: 1_000_000,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
