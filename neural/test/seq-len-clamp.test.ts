/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An input that tokenizes past the model's fixed sequence length must PARSE, not throw.
 *
 *   `ONNXRunner.infer` clamps its input to `fixedSeqLen` (128) and returns `logits` sliced to what it
 *   actually ran, but nothing clamped `pieces` to match — so the token build (`logits[i]`) and
 *   `enforceWordConsistency` (`emissions[pi]`) walked past the end of the emissions and threw. It
 *   presented as a garbage-input bug and is not one: 128 pieces is roughly 330 characters of ordinary
 *   address text, so a form-concatenated delivery address with a department line reaches it, and the
 *   throw propagated through `parseForGeocode` to the Nominatim/Photon/libpostal drop-ins as an HTTP
 *   500 on a well-formed query.
 *
 *   The test walks a REAL address grown by repetition rather than a synthetic blob, because the whole
 *   point is that the boundary is reachable by legitimate input. It asserts on both sides: under the
 *   limit the parse is unchanged, over it the parse still returns and its piece count is pinned to
 *   what the model saw.
 */

import { existsSync } from "node:fs"

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { describe, expect, test } from "vitest"

import { NeuralAddressClassifier } from "../classifier.ts"
import { resolveWeights } from "../weights.ts"

function modelIsMaterialized(): boolean {
	try {
		const weights = resolveWeights({ locale: "en-US" })

		return !!weights.modelPath && existsSync(weights.modelPath)
	} catch {
		// Lean checkout with no materialized weights — skip, like the other model-gated suites here.
		return false
	}
}

const haveModel = modelIsMaterialized()

const TAIL = "1600 Amphitheatre Parkway, Mountain View, California, 94043, United States"
/**
 * A department/division prefix of the kind a web form concatenates in front of a delivery address.
 */
const PREFIX = "Attention Accounts Payable Department Global Logistics Division "

describe.skipIf(!haveModel)("sequence-length clamp", () => {
	test("an address that tokenizes PAST the model limit parses instead of throwing", async () => {
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		// 6 repeats ≈ 394 characters — comfortably past 128 pieces, and the shortest case that threw.
		const long = PREFIX.repeat(6) + TAIL

		const tree = await classifier.parse(long, { enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT })

		expect(tree).toBeDefined()
		expect(Array.isArray(tree.roots)).toBe(true)
	})

	test("the same input parses on the RAW classifier path too (the throw was not heal-specific)", async () => {
		// The two paths failed with different messages — `emissions[pi] is not iterable` with the repair
		// on, `Cannot read properties of undefined` with it off — which made the crash look like a
		// word-consistency bug. It was upstream of both.
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const long = PREFIX.repeat(6) + TAIL

		await expect(classifier.parse(long, { enforceWordConsistency: false })).resolves.toBeDefined()
		await expect(classifier.traceParse(long)).resolves.toBeDefined()
	})

	test("pieces are clamped to the emissions the model returned", async () => {
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const trace = await classifier.traceParse(PREFIX.repeat(10) + TAIL)

		// The invariant the crash violated: one row of emissions per piece, whatever the input length.
		expect(trace.pieces).toHaveLength(trace.logits.length)
		expect(trace.pieces.length).toBeLessThanOrEqual(128)
	})

	test("an input UNDER the limit is untouched by the clamp", async () => {
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const trace = await classifier.traceParse(TAIL)

		expect(trace.pieces).toHaveLength(trace.logits.length)
		expect(trace.pieces.length).toBeLessThan(128)
	})
})
