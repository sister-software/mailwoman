/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_vocab` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The measurement itself lives in the package root; this file is the CONTRACT, and the description is the
 *   load-bearing half of it.
 */

import { z } from "zod"

import type { DevTool, DevToolDeps } from "../tool-kit.ts"
import { runVocabulary } from "../vocabulary.ts"

export const vocabTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_vocab",
	description:
		"Can the tokenizer REPRESENT this input at all? A parse defect on a non-Latin locale has two causes that " +
		"look identical from a trace — the corpus never taught the format, or the VOCABULARY cannot express the " +
		"string and the model is learning a byte sequence instead of a word. Proposing corpus rows for the second " +
		"works against the representation. SentencePiece marks what it could not represent by falling back to raw " +
		"UTF-8 bytes, so this is one measurement: pieces, byte-fallback share, and pieces-per-character (Latin " +
		"runs ~0.4 against this tokenizer; near or above 1.0 means the string is being spelled out). PASS A " +
		"`control` — usually the same addresses transliterated — because a fallback share alone has nothing to be " +
		"high or low against. The per-character report is the actionable half and is on by default: Vietnamese " +
		"measured 40.6% fallbacks against 3.7% for its Latin control, and the gap was not 'Vietnamese' but TWELVE " +
		"codepoints, every one a vowel carrying two marks — `add twelve characters` is a decision somebody can " +
		"price, `add Vietnamese` is not. Normalization is not a knob: NFC and NFD measured byte-identical, since " +
		"SentencePiece normalizes internally.",
	inputSchema: z.object({
		texts: z.array(z.string().min(1)).min(1).max(200),
		control: z
			.array(z.string().min(1))
			.max(200)
			.optional()
			.describe("The comparison arm — the same content the tokenizer handles well."),
		locale: z.string().optional().describe("Weights locale whose tokenizer to load. Default en-us."),
		tokenizer_path: z.string().optional().describe("Explicit tokenizer.model, bypassing weights resolution."),
		sequences: z
			.boolean()
			.default(false)
			.describe("Emit the piece sequence per line — shows WHERE a word shatters, and makes the reply long."),
		per_character: z.boolean().default(true),
	}),
	handler: async (args) =>
		runVocabulary({
			texts: args["texts"] as string[],
			...(args["control"] ? { control: args["control"] as string[] } : {}),
			...(args["locale"] ? { locale: args["locale"] as string } : {}),
			...(args["tokenizer_path"] ? { tokenizerPath: args["tokenizer_path"] as string } : {}),
			sequences: args["sequences"] as boolean,
			perCharacter: args["per_character"] as boolean,
		}),
})
