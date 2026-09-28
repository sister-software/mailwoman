#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-us overlay's dev artifacts, the base package that contains the model and
 *   tokenizer every other overlay inherits, the soft-feed lexicons, the US postcode binary, the
 *   FSTs and the US placetype-pair index.
 *
 *   `neural/test/integration/weights.test.ts` runs this on every `yarn test`, so the model pair is
 *   held to this package's `model-card.json` `files_md5`. The linked default bytes must match the
 *   digests the release re-verifies against the published tarball.
 *   A mismatch fails loudly and prevents grading an eval shift against the wrong weights.
 *   On release, bump `release.config.json`'s
 *   `weights.model` and `weights.tokenizer` and the card's `files_md5` in lockstep, since a path
 *   bumped without the card or the reverse fails here.
 *
 *   The evidence lexicons (`street_type`, `locality_surface`) are linked by the generation the card
 *   records rather than by a literal in this file, so a card bump moves the artifact with it.
 *   `postcode-us.bin` is derived from the WOF US postcode extract and built skip-if-present.
 *   A
 *   fresh worktree without it parses anchor-off. The pair index has no source CSV, since the US has
 *   no postal register carrying dependent localities (USPS routes city, state and ZIP), so every
 *   pair comes from the shared WOF admin database. `PAIR_INDEX_PARENT_DELTA` is the whole-edge
 *   parent bias, default-on for US.
 */

import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import {
	committedSoftFeedLinks,
	materializeDevOverlay,
	PAIR_INDEX_DELTA,
	PAIR_INDEX_PARENT_DELTA,
	PAIR_INDEX_TRANSITION_BETA,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-us",
	model: { kind: "link", digestCard: "neural-weights-en-us" },
	softFeed: [softFeed.anchor, softFeed.country],
	evidenceLexiconsFromCard: true,
	postcodeBinary: { country: "us", database: wofDatabasePath("postalcode-us.db") },
	pairIndex: {
		country: "us",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
