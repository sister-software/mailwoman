/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The char path through the runtime (#2164): the card's `encoder` block, weights resolution without a tokenizer,
 *   the char feed packer, and a classifier that encodes per code point, feeds `inferChars`, and skips the SentencePiece
 *   word-consistency repair — the repair that folded `東京都千代田区丸の内1丁目9-1` into one municipality span on the first
 *   served parse, because a Japanese address has no whitespace and so is one "word".
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { scriptFamilyBase } from "@mailwoman/neural/char-encoder"
import { NeuralAddressClassifier, type NeuralRunner } from "@mailwoman/neural/classifier"
import { packCharFeed } from "@mailwoman/neural/onnx-runner"
import { resolveWeights } from "@mailwoman/neural/weights"
import { readEncoderFromModelCard } from "@mailwoman/neural/weights-channels"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const LABELS = [
	"O",
	"B-prefecture",
	"I-prefecture",
	"B-municipality",
	"I-municipality",
	"B-house_number",
	"I-house_number",
]

const VOCAB = { "<pad>": 0, "<unk>": 1, "1": 2, "9": 3, 京: 4, 代: 5, 区: 6, 千: 7, 田: 8, 東: 9, 都: 10 }
const CONTRACT = { maxUnits: 16, maxUnitWidth: 5, ctxChars: 2 }

async function charPackage(cardExtra: Record<string, unknown> = {}): Promise<string> {
	const dir = resolvePath(fixtures.use(await temporaryDirectory("char-pkg-")).path)

	await writeLocalTextFile("not-a-real-graph", join(dir, "model.onnx"))
	await writeLocalTextFile(JSON.stringify(VOCAB), join(dir, "char-vocab.json"))

	await writeLocalTextFile(
		JSON.stringify({
			encoder: "char",
			char_vocab: "char-vocab.json",
			max_units: CONTRACT.maxUnits,
			max_unit_width: CONTRACT.maxUnitWidth,
			char_ctx: CONTRACT.ctxChars,
			labels: LABELS,
			...cardExtra,
		}),
		join(dir, "model-card.json")
	)

	return dir
}

describe("readEncoderFromModelCard", () => {
	it("reads a char card's vocabulary sibling and contract, and defaults an absent block to SentencePiece", async () => {
		const dir = await charPackage()

		expect(await readEncoderFromModelCard(join(dir, "model-card.json"))).toEqual({
			kind: "char",
			charVocab: "char-vocab.json",
			maxUnits: 16,
			maxUnitWidth: 5,
			ctxChars: 2,
		})

		expect(await readEncoderFromModelCard(undefined)).toEqual({ kind: "sentencepiece" })
	})

	it("refuses a char card missing part of the contract rather than guessing a window", async () => {
		const dir = await charPackage({ char_ctx: undefined })

		await expect(readEncoderFromModelCard(join(dir, "model-card.json"))).rejects.toThrow(/char_ctx/)
	})
})

describe("resolveWeights on a char package", () => {
	it("resolves an explicit model + charVocabPath without a tokenizer and reports the vocabulary as the second binary", async () => {
		const dir = await charPackage()

		const resolved = await resolveWeights({
			modelPath: join(dir, "model.onnx"),
			charVocabPath: join(dir, "char-vocab.json"),
			modelCardPath: join(dir, "model-card.json"),
		})

		expect(resolved.encoder.kind).toBe("char")
		expect(resolved.charVocabPath).toBe(join(dir, "char-vocab.json"))
		expect(resolved.artifacts.map((a) => a.name)).toContain("char-vocab.json")
		expect(resolved.artifacts.map((a) => a.name)).not.toContain("tokenizer.model")
	})

	it("refuses a char card given only a tokenizerPath", async () => {
		const dir = await charPackage()

		await writeLocalTextFile("", join(dir, "tokenizer.model"))

		await expect(
			resolveWeights({
				modelPath: join(dir, "model.onnx"),
				tokenizerPath: join(dir, "tokenizer.model"),
				modelCardPath: join(dir, "model-card.json"),
			})
		).rejects.toThrow(/charVocabPath/)
	})
})

describe("packCharFeed", () => {
	it("packs (S, W) ids into int64 tensors and counts the real units", () => {
		const packed = packCharFeed(
			[
				[1, 2, 3],
				[4, 5, 6],
				[0, 0, 0],
			],
			[1, 1, 0]
		)

		expect(packed.charIDs.dims).toEqual([1, 3, 3])
		expect(Array.from(packed.charIDs.data)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 0n, 0n, 0n])
		expect(packed.attentionMask.dims).toEqual([1, 3])
		expect(packed.seqLen).toBe(2)
	})
})

describe("NeuralAddressClassifier on the char path", () => {
	const RAW = "東京都千代田区9"

	// Per-unit labels a char graph would emit: prefecture 東京都, municipality 千代田区, house number 9.
	const PER_UNIT = [
		"B-prefecture",
		"I-prefecture",
		"I-prefecture",
		"B-municipality",
		"I-municipality",
		"I-municipality",
		"I-municipality",
		"B-house_number",
	]

	function charRunner(seen: { charIDs: number[][][] }): NeuralRunner {
		return {
			async infer() {
				throw new Error("the char path must not call infer")
			},
			async inferChars(charIDs) {
				seen.charIDs.push(charIDs.map((row) => [...row]))
				const units = charIDs.filter((row) => row.some((id) => id !== 0)).length

				return {
					logits: Array.from({ length: units }, (_, i) => LABELS.map((label) => (label === PER_UNIT[i] ? 8 : 0))),
					numLabels: LABELS.length,
				}
			},
		}
	}

	it("encodes per code point, feeds inferChars, and keeps the per-unit spans the graph emitted", async () => {
		const seen = { charIDs: [] as number[][][] }

		const classifier = new NeuralAddressClassifier({
			charEncoder: { vocabulary: new Map(Object.entries(VOCAB)), contract: CONTRACT },
			runner: charRunner(seen),
			labels: LABELS,
		})

		const tree = await classifier.parse(RAW)

		const walk = (node: { tag: string; value: string; children: unknown[] }): Array<[string, string]> => [
			[node.tag, node.value],
			...(node.children as Array<{ tag: string; value: string; children: unknown[] }>).flatMap(walk),
		]

		expect(seen.charIDs).toHaveLength(1)
		expect(seen.charIDs[0]).toHaveLength(CONTRACT.maxUnits)

		expect(tree.roots.flatMap(walk)).toEqual([
			["prefecture", "東京都"],
			["municipality", "千代田区"],
			["house_number", "9"],
		])
	})

	it("refuses a charEncoder beside a runner without inferChars", () => {
		expect(
			() =>
				new NeuralAddressClassifier({
					charEncoder: { vocabulary: new Map(Object.entries(VOCAB)), contract: CONTRACT },
					runner: {
						async infer() {
							return { logits: [], numLabels: 0 }
						},
					},
					labels: LABELS,
				})
		).toThrow(/inferChars/)
	})
})

describe("script-family fallback", () => {
	it("resolves ja-JP to the cjk base from the overlay rung when no ja-jp package holds binaries", async () => {
		const root = resolvePath(fixtures.use(await temporaryDirectory("overlay-root-")).path)
		const cjk = join(root, "cjk")

		await writeLocalTextFile("not-a-real-graph", join(cjk, "model.onnx"))
		await writeLocalTextFile(JSON.stringify(VOCAB), join(cjk, "char-vocab.json"))

		await writeLocalTextFile(
			JSON.stringify({
				encoder: "char",
				char_vocab: "char-vocab.json",
				max_units: 96,
				max_unit_width: 7,
				char_ctx: 3,
				labels: LABELS,
			}),
			join(cjk, "model-card.json")
		)

		const resolved = await resolveWeights({ locale: "ja-JP", overlayRoot: root })

		expect(resolved.encoder.kind).toBe("char")
		expect(resolved.modelPath).toBe(join(cjk, "model.onnx"))
		expect(resolved.source).toContain("script-family base for ja-jp")
	})

	it("has no family base for a Latin locale", () => {
		expect(scriptFamilyBase("en-US")).toBeUndefined()
		expect(scriptFamilyBase("zh-CN")).toBe("cjk")
	})
})
