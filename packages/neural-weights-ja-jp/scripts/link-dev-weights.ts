// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Dev-weights linker for `@mailwoman/neural-weights-ja-jp`.
 *
 *   The steps live in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`
 *   and this file is the manifest — the weights overlay declares `mailwoman.baseWeights` on
 *   `@mailwoman/neural-weights-cjk`, so the graph and the character vocabulary are the family's
 *   and this links only the per-locale FST (`fst-ja-jp.bin`) from the shared build area,
 *   so `resolveWeights({locale: "ja-jp"})` surfaces `fstPath` in local dev.
 *
 *   This weights overlay directory holds no card.
 *   `resolveWeights` reads the encoder from the overlay's own card when one is present,
 *   and this card declares none, so the overlay would read as a SentencePiece package
 *   missing its tokenizer and resolution would fall through to the bare cjk base.
 */
import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "ja-jp",
	model: { kind: "inherit" },
	localeFST: true,
	writeCard: false,
})
