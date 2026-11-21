// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-ja-jp`.
 *
 *   This file is the manifest for `materializeDevOverlay`.
 *   The package declares `mailwoman.baseWeights` on `@mailwoman/neural-weights-cjk`.
 *
 *   The graph, the character vocabulary and the encoder are therefore the cjk card's.
 *   This links the card and the per-locale FST (`fst-ja-jp.bin`).
 */
import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "ja-jp",
	model: { kind: "inherit" },
	localeFST: true,
})
