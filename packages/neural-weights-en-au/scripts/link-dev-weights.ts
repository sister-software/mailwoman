#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { committedSoftFeedLinks, materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

const softFeed = await committedSoftFeedLinks()

await materializeDevOverlay({
	locale: "en-au",
	model: { kind: "inherit" },
	softFeed: [softFeed.country],
	evidenceLexiconsFromCard: true,
	streetMorphologyFST: true,
})
