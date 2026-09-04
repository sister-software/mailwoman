#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-us overlay's dev artifacts — the BASE package: the model + tokenizer every other overlay
 *   inherits, the soft-feed lexicons, the US postcode binary, the FSTs, and the US placetype-pair index. The steps
 *   themselves live in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`; this file is the manifest.
 *
 *   `neural/test/integration/weights.test.ts` runs this on every `yarn test`, so the model pair is held to this
 *   package's `model-card.json` `files_md5` (the #397 drift guard): the linked default bytes must match the digests the
 *   release re-verifies against the published tarball, and a mismatch fails loud instead of grading an eval shift
 *   against the wrong weights. ON SHIP, bump `release.config.json`'s `weights.model` / `weights.tokenizer` and the
 *   card's `files_md5` in lockstep — a path bumped without the card, or the reverse, fails here.
 *
 *   The evidence lexicons (`street_type`, `locality_surface`) are linked by the generation the card names, not by a
 *   literal in this file, so a card bump moves the artifact with it. `postcode-us.bin` is derived from the WOF US
 *   postcode extract and built skip-if-present; without it a fresh worktree parses anchor-OFF ("Paris, TX" resolving
 *   to Paris, France on a fresh checkout was this gap). The pair index has NO source CSV — the US has no postal register
 *   carrying dependent localities (USPS routes city/state/ZIP), so every pair comes from the shared WOF admin database
 *   — and `PAIR_INDEX_PARENT_DELTA` is the whole-edge parent bias (#46), default-on for US; receipt
 *   `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
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
	postcodeBinary: { country: "us", database: String(dataRootPath("wof", "postalcode-us.db")) },
	pairIndex: {
		country: "us",
		delta: PAIR_INDEX_DELTA,
		transitionBeta: PAIR_INDEX_TRANSITION_BETA,
		parentDelta: PAIR_INDEX_PARENT_DELTA,
	},
	localeFST: true,
	streetMorphologyFST: true,
})
