#!/usr/bin/env node

import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "cjk",
	model: { kind: "char", family: "cjk" },
})
