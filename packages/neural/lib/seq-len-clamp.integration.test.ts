/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   An input that tokenizes past the model's fixed sequence length must parse rather than throw.
 *
 *   `ONNXRunner.infer` truncates to `fixedSeqLen` and trims `logits` to what it ran; `pieces` must
 *   follow, or every lockstep consumer (`logits[i]` in the token build, `emissions[pi]` in
 *   `enforceWordConsistency`) indexes past the end.
 *
 *   The limit is reachable by ordinary input — 128 pieces is roughly 330 characters — so the fixtures
 *   grow a real address by repetition instead of using a synthetic blob. The test asserts both sides of the
 *   boundary. A throw here reaches drop-in servers as a 500 on a well-formed query.
 *   The raw and healed paths are both covered because they failed with different messages. That difference
 *   the difference invites diagnosing this as a word-consistency bug.
 */

import { WORD_CONSISTENCY_SHIP_DEFAULT } from "@mailwoman/core/pipeline"
import { describe, expect, test, vi } from "vitest"

import { NeuralAddressClassifier } from "#classifier"

import { MODEL_LOAD_TEST_TIMEOUT_MS, testModelAssets } from "../test/model-assets.ts"

const haveModel = (await testModelAssets()) !== null

vi.setConfig({ testTimeout: MODEL_LOAD_TEST_TIMEOUT_MS })

const TAIL = "1600 Amphitheatre Parkway, Mountain View, California, 94043, United States"
/**
 * A department/division prefix of the kind a web form concatenates in front of a delivery address.
 */
const PREFIX = "Attention Accounts Payable Department Global Logistics Division "

let loadedClassifier: Promise<NeuralAddressClassifier> | undefined

/**
 * The en-US classifier, loaded by the first test that asks for it.
 *
 * `parse` and `traceParse` take their options per call and write no instance state,
 * so every test can read the same instance.
 */
function enUSClassifier(): Promise<NeuralAddressClassifier> {
	loadedClassifier ??= NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

	return loadedClassifier
}

describe.skipIf(!haveModel)("sequence-length clamp", () => {
	test("an address that tokenizes PAST the model limit parses instead of throwing", async () => {
		const classifier = await enUSClassifier()
		// Six repeats produce about 394 characters, past the 128-piece limit.
		// This is the shortest case that threw.
		const long = PREFIX.repeat(6) + TAIL

		const tree = await classifier.parse(long, { enforceWordConsistency: WORD_CONSISTENCY_SHIP_DEFAULT })

		expect(tree).toBeDefined()
		expect(Array.isArray(tree.roots)).toBe(true)
	})

	test("the same input parses on the RAW classifier path too (the throw was not heal-specific)", async () => {
		// The two paths failed with different messages — `emissions[pi] is not iterable`
		// with the repair on, `Cannot read properties of undefined` with it off —
		// which made the crash look like a word-consistency bug.
		// It was upstream of both.
		const classifier = await enUSClassifier()
		const long = PREFIX.repeat(6) + TAIL

		await expect(classifier.parse(long, { enforceWordConsistency: false })).resolves.toBeDefined()
		await expect(classifier.traceParse(long)).resolves.toBeDefined()
	})

	test("pieces are clamped to the emissions the model returned", async () => {
		const classifier = await enUSClassifier()
		const trace = await classifier.traceParse(PREFIX.repeat(10) + TAIL)

		// The invariant the crash violated: one row of emissions per piece, whatever the input length.
		expect(trace.pieces).toHaveLength(trace.logits.length)
		expect(trace.pieces.length).toBeLessThanOrEqual(128)
	})

	test("an input UNDER the limit is untouched by the clamp", async () => {
		const classifier = await enUSClassifier()
		const trace = await classifier.traceParse(TAIL)

		expect(trace.pieces).toHaveLength(trace.logits.length)
		expect(trace.pieces.length).toBeLessThan(128)
	})
})
