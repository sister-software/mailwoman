/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Load-time capability delta-gate (#718/#719). The structural fix that makes the D2/#719 bug-class
 *   — a conventions `forbiddenTags` row destroying a tag the model demonstrably emits — impossible to
 *   ship: `createScorer` reads the model-card's `capabilities` block and FAILS CLOSED when a
 *   conventions row forbids a certified tag (`maskOffF1 − maskOnF1 > 5pp`).
 *
 *   Two load-bearing assertions:
 *   1. PASSES on the REAL post-D2 config — FR forbids only `street_suffix`, which the model does NOT
 *      emit (no capability entry → legal); the certified FR `street_prefix` (maskOff 80) is no longer
 *      forbidden, so nothing trips.
 *   2. THROWS when a synthetic FR forbid re-adds `street_prefix` (a CERTIFIED tag at maskOff 80) — the
 *      exact #719 shape. This proves the guard would have caught the original bug at LOAD time.
 *
 *   Requires the production v1.5.0 int8 + its real feed channels on disk; skips otherwise (mirrors
 *   weights.test.ts) so stripped-down CI still passes.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { ADDRESS_SYSTEM_CONVENTIONS, type AddressSystemConventions } from "@mailwoman/codex"
import { createScorer } from "../scorer.js"

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, "../..")

const MODEL =
	process.env.MAILWOMAN_CAPABILITY_ONNX_MODEL ??
	"/mnt/playpen/mailwoman-data/models/quantized/model-v150-step-40000-int8.onnx"
const TOKENIZER = "/mnt/playpen/mailwoman-data/models/tokenizer/v0.6.0-a0/tokenizer.model"
const ANCHOR = "/mnt/playpen/mailwoman-data/anchor/pilot-anchor-lookup.json"
const GAZETTEER = resolve(REPO, "data/gazetteer/anchor-lexicon-v1.json")
const MODEL_CARD = resolve(REPO, "neural-weights-en-us/model-card.json")

// All channels must be feedable: createScorer runs the gate in `strict` mode, and the v1.5.0 card
// declares anchor+gazetteer required — a missing channel would throw an UnfedChannelError that masks
// the capability-gate behavior we're testing. Skip the whole suite unless the full feed is present.
const haveAll = [MODEL, TOKENIZER, ANCHOR, GAZETTEER, MODEL_CARD].every((p) => existsSync(p))

const baseOpts = {
	modelPath: MODEL,
	tokenizerPath: TOKENIZER,
	modelCardPath: MODEL_CARD,
	anchorLookupPath: ANCHOR,
	gazetteerLexiconPath: GAZETTEER,
	strict: true as const,
}

describe.skipIf(!haveAll)("createScorer capability delta-gate (#718/#719)", () => {
	// Save/restore the live FR conventions row — the gate reads the shared in-memory codex table, so a
	// synthetic forbid mutates it for the duration of one test and must be reverted.
	let savedFr: AddressSystemConventions | undefined
	beforeEach(() => {
		savedFr = ADDRESS_SYSTEM_CONVENTIONS.fr
	})
	afterEach(() => {
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = savedFr
	})

	test("PASSES on the real post-D2 conventions (FR forbids only street_suffix, which the model does not emit)", async () => {
		// Sanity: the shipped table is the post-#719 fix — street_suffix only, NO street_prefix.
		expect(ADDRESS_SYSTEM_CONVENTIONS.fr!.forbiddenTags).toEqual(["street_suffix"])
		const scorer = await createScorer(baseOpts)
		expect(scorer).toBeDefined()
	})

	test("THROWS when a synthetic FR forbid re-adds street_prefix — a CERTIFIED tag (catches the #719 bug at load)", async () => {
		// Re-introduce the original bug: forbid street_prefix for FR. The model is certified at maskOff
		// F1 80 (server tier) with NO benign maskOn measurement → the gate must reject this mask.
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = {
			...savedFr,
			forbiddenTags: ["street_prefix", "street_suffix"],
		}
		await expect(createScorer(baseOpts)).rejects.toThrow(
			/conventions forbids `street_prefix` for system `fr`.*certified to emit it.*#718\/#719/s
		)
	})

	test("pocket tier is gated against its own certified capabilities", async () => {
		// The pocket tier (anchor-only) ALSO certifies FR street_prefix at maskOff 80; a forbid there is
		// equally illegal. Confirms the tier selector actually reads the pocket cell.
		;(ADDRESS_SYSTEM_CONVENTIONS as Record<string, AddressSystemConventions | undefined>).fr = {
			...savedFr,
			forbiddenTags: ["street_prefix"],
		}
		await expect(createScorer({ ...baseOpts, tier: "pocket", overrides: { gazetteer: false } })).rejects.toThrow(
			/tier `pocket`.*maskOff F1 80/s
		)
	})
})
