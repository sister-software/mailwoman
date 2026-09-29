/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Convention pins for the SP 0.2.2 native-offsets runtime over `@mailwoman/sentencepiece-wasm`.
 *
 *   Three behaviors are pinned: a piece following a non-BMP character lands on the correct UTF-16
 *   range while the rest of the input stays aligned. A `▁`-prefixed piece's native span is trimmed
 *   to the word start while a bare `▁` collapses to a zero-width range. The coarse normalizer
 *   alignment of the all-caps class matches the training convention.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { describe, expect, test } from "vitest"

import { MailwomanTokenizer } from "#tokenizer"

// The dev tokenizer that link-dev-weights pins (v0.9.0-multisplice), resolved through the data root.
// The suite skips on hosts without it.
const TOKENIZER_PATH = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")
const haveTokenizer = await pathExists(TOKENIZER_PATH)

describe("MailwomanTokenizer — native offsets (SP 0.2.2)", () => {
	test.skipIf(!haveTokenizer)("non-BMP input stays aligned after the surrogate pair", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "12 𝔘nicode St"
		const { pieces } = tokenizer.encode(text)

		// 𝔘 (U+1D518) is two UTF-16 code units.
		const un = pieces.find((p) => p.piece === "▁Un")
		expect(un).toBeDefined()
		expect(text.slice(un!.start, un!.end)).toBe("𝔘n")

		const st = pieces.at(-1)!
		expect(st.piece).toBe("▁St")
		expect(text.slice(st.start, st.end)).toBe("St")
	})

	test.skipIf(!haveTokenizer)("▁ spans are trimmed to the word start; bare ▁ is zero-width", async () => {
		const tokenizer = await MailwomanTokenizer.loadFromFile(TOKENIZER_PATH)
		const text = "«12» Main St"
		const { pieces } = tokenizer.encode(text)

		// ▁Main starts at the word start "M" (index 5) rather than at the preceding space.
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

			// EncodeAsImmutableProto attributes "CAL" to the second piece on this input,
			// the spans BIO gold was built from.
			// This fixture keeps runtime and trainer on one convention.
			// Do not "fix" this back to per-char intuition without re-deriving training gold.
			expect(pieces[0]!.piece).toBe("▁C")
			expect(pieces[0]!.start).toBe(pieces[0]!.end)
			expect(pieces[1]!.piece).toBe("AL")
			expect(text.slice(pieces[1]!.start, pieces[1]!.end)).toBe("CAL")

			const wordEnd = pieces[3]!
			expect(wordEnd.piece).toBe("E")
			expect(text.slice(pieces[0]!.start, wordEnd.end)).toBe("CALLE")
		}
	)
})
