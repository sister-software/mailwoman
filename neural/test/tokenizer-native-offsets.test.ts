/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convention pins for the SP 0.2.2 native-offsets runtime (task #26 — the
 *   `@mailwoman/sentencepiece-wasm` swap). Three behaviors are pinned:
 *
 *   1. **Non-BMP correctness** — the old reconstruction's DEFERRED hazard ("surrogate-pair
 *      codepoints would need `Array.from(s).length` accounting"): a piece following a non-BMP
 *      character now lands on the correct UTF-16 range, and alignment holds for the rest of the
 *      input. This was wrong before the swap, by one code unit per preceding non-BMP char.
 *   2. **Whitespace-trim of ▁ spans** — SentencePiece's native span for a `▁`-prefixed piece
 *      includes the whitespace the sentinel consumed; the TS layer trims to the word start,
 *      preserving the decoder contract the shipped model was decoded with. The bare-`▁` piece
 *      collapses to the zero-width-after-space range the word grouper expects.
 *   3. **Normalizer-granular alignment is the TRAINING convention, not a bug** — on inputs where
 *      the model's normalizer aligns coarsely (the ALL-CAPS class: `CALLE` → `▁C`[0,0) +
 *      `AL`[0,3)), the native offsets match what `EncodeAsImmutableProto` fed the trainer
 *      (corpus-python/src/mailwoman_train/tokenizer.py builds BIO gold from the SAME proto
 *      spans). The old TS reconstruction disagreed with training on exactly this class — 102 of
 *      1,066 rows in the swap's parity battery, every one offset-only (pieces + ids were
 *      byte-identical across all 1,066).
 */

import { existsSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { MailwomanTokenizer } from "../tokenizer.ts"

// The dev tokenizer, same source link-dev-weights pins (v0.9.0-multisplice) — resolved via the
// data root; skip cleanly on hosts without it.
const TOKENIZER_PATH = String(dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model"))
const haveTokenizer = existsSync(TOKENIZER_PATH)

describe("MailwomanTokenizer — native offsets (SP 0.2.2)", () => {
	test.skipIf(!haveTokenizer)("non-BMP input stays aligned after the surrogate pair", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "12 𝔘nicode St"
		const { pieces } = tokenizer.encode(text)

		// 𝔘 (U+1D518) is two UTF-16 code units; the piece containing it spans them exactly…
		const un = pieces.find((p) => p.piece === "▁Un")
		expect(un).toBeDefined()
		expect(text.slice(un!.start, un!.end)).toBe("𝔘n")

		// …and the rest of the input does NOT desync (the old reconstruction drifted by one code
		// unit per preceding non-BMP char).
		const st = pieces.at(-1)!
		expect(st.piece).toBe("▁St")
		expect(text.slice(st.start, st.end)).toBe("St")
	})

	test.skipIf(!haveTokenizer)("▁ spans are trimmed to the word start; bare ▁ is zero-width", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "«12» Main St"
		const { pieces } = tokenizer.encode(text)

		// ▁Main starts at "M" (index 5), not at the preceding space — the decoder contract.
		const main = pieces.find((p) => p.piece === "▁Main")!
		expect(text.slice(main.start, main.end)).toBe("Main")

		// The bare ▁ before « owns no chars: zero-width at the word position.
		const bare = pieces[0]!
		expect(bare.piece).toBe("▁")
		expect(bare.start).toBe(bare.end)
	})

	test.skipIf(!haveTokenizer)(
		"coarse normalizer alignment matches the training convention (ALL-CAPS class)",
		async () => {
			const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
			const text = "CALLE MAYOR 4"
			const { pieces } = tokenizer.encode(text)

			// EncodeAsImmutableProto attributes "CAL" to the second piece on this input (verified
			// against Python sentencepiece on the same model bytes) — the spans BIO gold was built
			// from. Pinning it here keeps runtime and trainer on one convention; do NOT "fix" this
			// back to per-char intuition without re-deriving training gold.
			expect(pieces[0]!.piece).toBe("▁C")
			expect(pieces[0]!.start).toBe(pieces[0]!.end)
			expect(pieces[1]!.piece).toBe("AL")
			expect(text.slice(pieces[1]!.start, pieces[1]!.end)).toBe("CAL")

			// Word-level union is unchanged either way — the class is invisible at component grain.
			const wordEnd = pieces[3]!
			expect(wordEnd.piece).toBe("E")
			expect(text.slice(pieces[0]!.start, wordEnd.end)).toBe("CALLE")
		}
	)
})
