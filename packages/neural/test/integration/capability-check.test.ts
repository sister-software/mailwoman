import { ADDRESS_SYSTEM_CONVENTIONS, type AddressSystemConventions } from "@mailwoman/codex"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { workspacePath, repoRootPath } from "@mailwoman/core/paths"
import { $public } from "@mailwoman/neural/env"
import { createScorer } from "@mailwoman/neural/scorer"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const MODEL =
	$public.MAILWOMAN_CAPABILITY_ONNX_MODEL ?? dataRootPath("models", "quantized", "model-v150-step-40000-int8.onnx")

const TOKENIZER = dataRootPath("models", "tokenizer", "v0.6.0-a0", "tokenizer.model")
const ANCHOR = dataRootPath("anchor", "pilot-anchor-lookup.json")
const GAZETTEER = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
const MODEL_CARD = workspacePath("neural-weights-en-us", "model-card.json")

const haveAll = (await Promise.all([MODEL, TOKENIZER, ANCHOR, GAZETTEER, MODEL_CARD].map((p) => pathExists(p)))).every(
	(exists) => exists
)

const baseOpts = {
	modelPath: MODEL,
	tokenizerPath: TOKENIZER,
	modelCardPath: MODEL_CARD,
	anchorLookupPath: ANCHOR,
	gazetteerLexiconPath: GAZETTEER,
	strict: true as const,
}

describe.skipIf(!haveAll)("CreateScorer capability delta check", () => {
	let savedFr: AddressSystemConventions | undefined

	beforeEach(() => {
		savedFr = ADDRESS_SYSTEM_CONVENTIONS.fr
	})

	afterEach(() => {
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = savedFr
	})

	test("PASSES on the real post-D2 conventions (FR forbids only street_suffix, which the model does not emit)", async () => {
		expect(ADDRESS_SYSTEM_CONVENTIONS.fr!.forbiddenTags).toEqual(["street_suffix"])
		const scorer = await createScorer(baseOpts)
		expect(scorer).toBeDefined()
	})

	test("THROWS when a synthetic FR forbid re-adds street_prefix — a CERTIFIED tag (catches the bug at load)", async () => {
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = {
			...savedFr,
			forbiddenTags: ["street_prefix", "street_suffix"],
		}

		await expect(createScorer(baseOpts)).rejects.toThrow(
			/conventions forbids `street_prefix` for system `fr`.*certified to emit it.*#718\/#719/s
		)
	})

	test("pocket tier is conditional against its own certified capabilities", async () => {
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = {
			...savedFr,
			forbiddenTags: ["street_prefix"],
		}

		await expect(createScorer({ ...baseOpts, tier: "pocket", overrides: { gazetteer: false } })).rejects.toThrow(
			/tier `pocket`.*maskOff F1 \d/s
		)
	})
})
