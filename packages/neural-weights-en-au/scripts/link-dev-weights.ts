#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { committedSoftFeedLinks, materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-au",
	model: { kind: "inherit" },
	softFeed: [softFeed.country],
	evidenceLexiconsFromCard: true,
	streetMorphologyFST: true,
})
