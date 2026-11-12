#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "cjk",
	model: { kind: "char", family: "cjk" },
})
