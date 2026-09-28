/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v0.4.0 model-card runtime label-vocabulary loader.
 *
 *   The tests stay hermetic, needing no model file and only temporary `model-card.json` fixtures.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/paths"
import { resolveWeights } from "@mailwoman/neural/weights"
import { readLabelsFromModelCard } from "@mailwoman/neural/weights-channels"
import type { PathBuilder } from "path-ts"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

let dir: TemporaryDirectory

beforeEach(async () => {
	dir = await temporaryDirectory("mailwoman-mc-")
})

afterEach(() => dir[Symbol.asyncDispose]())

async function writeCard(payload: unknown): Promise<PathBuilder> {
	const p = dir.path("model-card.json")
	await writeLocalJSONFile(payload, p)

	return p
}

describe("readLabelsFromModelCard", () => {
	test("returns the labels array when the card carries one", async () => {
		const labels = ["O", "B-country", "I-country"]
		const out = await readLabelsFromModelCard(await writeCard({ labels }))
		expect(out).toEqual(labels)
	})

	test("returns a frozen copy (mutating it does not change the on-disk semantics)", async () => {
		const labels = ["O", "B-country", "I-country"]
		const out = (await readLabelsFromModelCard(await writeCard({ labels })))!
		expect(Object.isFrozen(out)).toBe(true)
	})

	test("returns undefined when the card has no labels field (legacy v3.0.0 cards)", async () => {
		const out = await readLabelsFromModelCard(await writeCard({ components_supported: ["country"] }))
		expect(out).toBeUndefined()
	})

	test("returns undefined when the path is undefined", async () => {
		expect(await readLabelsFromModelCard(undefined)).toBeUndefined()
	})

	test("returns undefined when the file does not exist", async () => {
		expect(await readLabelsFromModelCard(dir.path("missing.json"))).toBeUndefined()
	})

	test("returns undefined when the file is not valid JSON", async () => {
		const p = dir.path("model-card.json")
		await writeLocalTextFile("{ not: json,", p)
		expect(await readLabelsFromModelCard(p)).toBeUndefined()
	})

	test("throws when labels is present but the wrong type (number instead of array)", async () => {
		const p = await writeCard({ labels: 21 })
		await expect(readLabelsFromModelCard(p)).rejects.toThrow(/malformed `labels` field/)
	})

	test("throws when labels array contains non-strings", async () => {
		const p = await writeCard({ labels: ["O", 1, "I-country"] })
		await expect(readLabelsFromModelCard(p)).rejects.toThrow(/malformed `labels` field/)
	})

	test("throws when labels array is empty", async () => {
		const p = await writeCard({ labels: [] })
		await expect(readLabelsFromModelCard(p)).rejects.toThrow(/malformed `labels` field/)
	})
})

describe("resolveWeights — modelCardPath surface", () => {
	test("explicit-path mode does not set modelCardPath (caller is responsible)", async () => {
		// The dev tokenizer fixture serves both paths, since explicit mode only
		// checks that the model path exists.
		const r = await resolveWeights({ modelPath: TOKENIZER_PATH, tokenizerPath: TOKENIZER_PATH })
		expect(r.modelCardPath).toBeUndefined()
		expect(r.source).toBe("explicit")
	})
})
