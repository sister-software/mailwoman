/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Dev-weights linker for `@mailwoman/neural-weights-zh-cn`.
 *
 *   The steps live in `@mailwoman/resolver-wof-sqlite/weights-overlay-linker` and this file is the manifest — the
 *   overlay declares `mailwoman.baseWeights` on `@mailwoman/neural-weights-cjk`, so the graph and the character vocabulary are the
 *   family's and this links only the per-locale FST (`fst-zh-cn.bin`) from the shared build area, so
 *   `resolveWeights({locale: "zh-cn"})` surfaces `fstPath` in local dev.
 */
import { materializeDevOverlay } from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

await materializeDevOverlay({
	locale: "zh-cn",
	model: { kind: "inherit" },
	localeFST: true,
})
