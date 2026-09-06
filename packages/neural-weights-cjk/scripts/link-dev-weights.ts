#!/usr/bin/env node

/**
 * Materialize the CJK char-path base into the data-root overlay (`$MAILWOMAN_DATA_ROOT/weights/cjk/`): the graph and
 * the sealed character vocabulary named by `release.config.json`'s `charWeights.cjk`, no tokenizer and no soft-feed
 * siblings — the char path is channel-free by contract. The tracked workspace stays bare, the way every weights
 * workspace does on a dev checkout.
 */

import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "cjk",
	model: { kind: "char", family: "cjk" },
})
