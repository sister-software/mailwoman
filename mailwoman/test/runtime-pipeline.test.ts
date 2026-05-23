/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration test for `createRuntimePipeline` — wires the real `@mailwoman/normalize` +
 *   `@mailwoman/query-shape` defaults with mocked classifier + resolver. Verifies the end-to-end
 *   composition runs cleanly on inputs that exercise each stage.
 */

import type { AddressClassifier } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { describe, expect, it, vi } from "vitest"
import { createRuntimePipeline } from "../runtime-pipeline.js"

function fakeClassifier(): AddressClassifier {
	return {
		parse: vi.fn(async (text: string) => ({
			raw: text,
			roots: [
				{
					tag: "country" as const,
					value: "US",
					start: 0,
					end: text.length,
					confidence: 0.9,
					children: [],
				},
			],
		})),
	}
}

function passthroughResolver(): Resolver {
	return { resolveTree: vi.fn(async (tree) => tree) }
}

describe("createRuntimePipeline — wiring", () => {
	it("runs normalize + queryShape + classifier + resolver in order", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		const pipeline = createRuntimePipeline({ classifier, resolver })

		const result = await pipeline("350  5th Ave, New York, NY 10118", { locale: "en-US" })

		// Normalize collapsed the double space.
		expect(result.normalized.normalized).toBe("350 5th Ave, New York, NY 10118")
		// QueryShape detected the US ZIP.
		expect(result.queryShape.knownFormats.some((f) => f.format === "us_zip")).toBe(true)
		// Caller locale propagated.
		expect(result.locale.locale).toBe("en-US")
		expect(result.locale.source).toBe("caller")
		// Classifier ran and produced a tree.
		expect(classifier.parse).toHaveBeenCalled()
		expect(result.tree.roots).toHaveLength(1)
		// Resolver ran.
		expect(resolver.resolveTree).toHaveBeenCalled()
		// Full pipeline path (kind classifier is a stub returning structured_address).
		expect(result.path).toBe("full")
	})

	it("threads precomputed QueryShape into classifier.parse", async () => {
		const classifier = fakeClassifier()
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("10118")
		expect(classifier.parse).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				queryShape: expect.objectContaining({
					knownFormats: expect.arrayContaining([expect.objectContaining({ format: "us_zip" })]),
				}),
			})
		)
	})

	it("runs without classifier (empty tree, no throw)", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("hello world")
		expect(result.tree.roots).toEqual([])
		expect(result.timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["query-shape"]).toBeGreaterThanOrEqual(0)
	})

	it("preserves raw input through normalize → result.input", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("  350  5th Ave  ")
		expect(result.input).toBe("  350  5th Ave  ")
		// normalized.raw also preserves the original.
		expect(result.normalized.raw).toBe("  350  5th Ave  ")
		// normalized.normalized is the trimmed + collapsed form.
		expect(result.normalized.normalized).toBe("350 5th Ave")
	})

	it("offsetMap on normalized input lets consumers map back to raw chars", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("350  5th Ave")
		// normalized = "350 5th Ave" (length 11); raw = "350  5th Ave" (length 12)
		// offsetMap[4] should be 5 (the '5' in raw, after skipping the second space).
		const map = (result.normalized as { offsetMap?: number[] }).offsetMap
		expect(map).toBeDefined()
		expect(map?.[4]).toBe(5)
	})

	it("kind classifier override is respected", async () => {
		const classifier = fakeClassifier()
		const customKind = vi.fn(async () => ({
			kind: "structured_address" as const,
			confidence: 0,
			alternatives: [],
		}))
		const pipeline = createRuntimePipeline({ classifier, classifyKind: customKind })

		await pipeline("350 5th Ave, NYC")
		expect(customKind).toHaveBeenCalled()
	})

	it("locale gate override is respected", async () => {
		const customDetect = vi.fn(async () => ({
			locale: "fr-FR",
			confidence: 0.92,
			alternatives: [],
			source: "detected" as const,
		}))
		const pipeline = createRuntimePipeline({ detectLocale: customDetect })

		const result = await pipeline("8 rue Lafayette")
		expect(customDetect).toHaveBeenCalled()
		expect(result.locale.locale).toBe("fr-FR")
		expect(result.locale.source).toBe("detected")
	})
})
