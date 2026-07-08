/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the v0.4.0 model-card runtime label-vocabulary loader (issue #116 §5(a)).
 *
 *   Two paths under test:
 *
 *   - `readLabelsFromModelCard` — pure helper. Reads `model-card.json`'s `labels` field, returns the
 *       frozen array on success, returns `undefined` for legacy cards that predate the field (and
 *       for missing / unreadable files), throws on a present-but-malformed `labels` field.
 *   - `resolveWeights` — surfaces `modelCardPath` when a card exists alongside the resolved model.
 *
 *   The end-to-end `loadFromWeights` path is exercised by `weights.test.ts`. Here we keep the tests
 *   hermetic: no model file required, just tmp model-card.json fixtures.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { readLabelsFromModelCard, resolveWeights } from "../weights.js"

const TOKENIZER_PATH = repoRootPath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mailwoman-mc-"))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function writeCard(payload: unknown): string {
	const p = join(dir, "model-card.json")
	writeFileSync(p, JSON.stringify(payload, null, 2), "utf8")

	return p
}

describe("readLabelsFromModelCard", () => {
	test("returns the labels array when the card carries one", () => {
		const labels = ["O", "B-country", "I-country"]
		const out = readLabelsFromModelCard(writeCard({ labels }))
		expect(out).toEqual(labels)
	})

	test("returns a frozen copy (mutating it does not change the on-disk semantics)", () => {
		const labels = ["O", "B-country", "I-country"]
		const out = readLabelsFromModelCard(writeCard({ labels }))!
		expect(Object.isFrozen(out)).toBe(true)
	})

	test("returns undefined when the card has no labels field (legacy v3.0.0 cards)", () => {
		const out = readLabelsFromModelCard(writeCard({ components_supported: ["country"] }))
		expect(out).toBeUndefined()
	})

	test("returns undefined when the path is undefined", () => {
		expect(readLabelsFromModelCard(undefined)).toBeUndefined()
	})

	test("returns undefined when the file does not exist", () => {
		expect(readLabelsFromModelCard(join(dir, "missing.json"))).toBeUndefined()
	})

	test("returns undefined when the file is not valid JSON", () => {
		const p = join(dir, "model-card.json")
		writeFileSync(p, "{ not: json,", "utf8")
		expect(readLabelsFromModelCard(p)).toBeUndefined()
	})

	test("throws when labels is present but the wrong type (number instead of array)", () => {
		const p = writeCard({ labels: 21 })
		expect(() => readLabelsFromModelCard(p)).toThrow(/malformed `labels` field/)
	})

	test("throws when labels array contains non-strings", () => {
		const p = writeCard({ labels: ["O", 1, "I-country"] })
		expect(() => readLabelsFromModelCard(p)).toThrow(/malformed `labels` field/)
	})

	test("throws when labels array is empty", () => {
		const p = writeCard({ labels: [] })
		expect(() => readLabelsFromModelCard(p)).toThrow(/malformed `labels` field/)
	})
})

describe("resolveWeights — modelCardPath surface", () => {
	test("explicit-path mode does not set modelCardPath (caller is responsible)", () => {
		// Use the dev tokenizer fixture for the tokenizer path; reuse it for modelPath
		// too — existsSync is all the resolver checks for in explicit mode.
		const r = resolveWeights({ modelPath: TOKENIZER_PATH, tokenizerPath: TOKENIZER_PATH })
		expect(r.modelCardPath).toBeUndefined()
		expect(r.source).toBe("explicit")
	})
})
