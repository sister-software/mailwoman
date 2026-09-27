import type { AddressClassifier } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { createRuntimePipeline } from "mailwoman/runtime-pipeline"
import { describe, expect, it, vi } from "vitest"

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
	it("surfaces inferred machine locale and timezone when the query has no locale evidence", async () => {
		const pipeline = createRuntimePipeline({
			machinePreferences: { locale: "en-GB", timeZone: "Europe/London" },
		})

		const result = await pipeline("Paris")

		expect(result.locale).toMatchObject({
			locale: "en-GB",
			source: "machine",
			evidence: { intlLocale: "en-GB", timeZone: "Europe/London" },
		})
	})

	it("can disable host inference for a server runtime", async () => {
		const pipeline = createRuntimePipeline({ machinePreferences: false })
		const result = await pipeline("Paris")

		expect(result.locale).toMatchObject({ locale: "en-US", confidence: 0.3, source: "detected" })
	})

	it("runs normalize + queryShape + classifier + resolver in order", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		const pipeline = createRuntimePipeline({ classifier, resolver })

		const result = await pipeline("350  5th Ave, New York, NY 10118", { locale: "en-US" })

		expect(result.normalized.normalized).toBe("350 5th Ave, New York, NY 10118")

		expect(result.queryShape.knownFormats.some((f) => f.format === "us_zip")).toBe(true)

		expect(result.locale.locale).toBe("en-US")
		expect(result.locale.source).toBe("caller")

		expect(classifier.parse).toHaveBeenCalled()
		expect(result.tree.roots).toHaveLength(1)

		expect(resolver.resolveTree).toHaveBeenCalled()

		expect(result.path).toBe("full")
	})

	it("threads precomputed QueryShape into classifier.parse", async () => {
		const classifier = fakeClassifier()
		const pipeline = createRuntimePipeline({ classifier })

		await pipeline("10118")

		const sawUSZip = expect.arrayContaining([expect.objectContaining({ format: "us_zip" })])

		expect(classifier.parse).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				queryShape: expect.objectContaining({ knownFormats: sawUSZip }),
			})
		)
	})

	it("Runs without classifier (empty tree without throwing)", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("hello world")
		expect(result.tree.roots).toEqual([])
		expect(result.timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["query-shape"]).toBeGreaterThanOrEqual(0)
	})

	it("Preserves raw input through normalize → result.input", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("  350  5th Ave  ")
		expect(result.input).toBe("  350  5th Ave  ")

		expect(result.normalized.raw).toBe("  350  5th Ave  ")

		expect(result.normalized.normalized).toBe("350 5th Ave")
	})

	it("offsetMap on normalized input lets consumers map back to raw chars", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("350  5th Ave")

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

	it("locale check override is respected", async () => {
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

describe("createRuntimePipeline — kind classifier defaults", () => {
	it("classifies a bare US ZIP as postcode_only", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("10118")
		expect(result.kind.kind).toBe("postcode_only")
		expect(result.kind.confidence).toBeGreaterThan(0.5)
	})

	it("classifies a single-word input as locality_only", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("Paris")
		expect(result.kind.kind).toBe("locality_only")
	})

	it("classifies a multi-segment address as structured_address", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("350 5th Ave, New York, NY 10118")
		expect(result.kind.kind).toBe("structured_address")
	})

	it("classifies PO Box input as po_box", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("PO Box 1234")
		expect(result.kind.kind).toBe("po_box")
	})

	it("classifies 'Behind the gas station' as landmark", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("Behind the gas station")
		expect(result.kind.kind).toBe("landmark")
	})

	it("classifies '5th and Main' as intersection", async () => {
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("5th and Main")
		expect(result.kind.kind).toBe("intersection")
	})

	it("Fast-paths unambiguous postcode (US ZIP+4) inputs to resolver, skipping classifier", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		const pipeline = createRuntimePipeline({ classifier, resolver })
		const result = await pipeline("10118-1234")
		expect(result.path).toBe("fast-path")
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(resolver.resolveTree).toHaveBeenCalled()
	})

	it("does NOT fast-path ambiguous 5-digit input (US/FR/DE overlap)", async () => {
		const classifier = fakeClassifier()
		const resolver = passthroughResolver()
		const pipeline = createRuntimePipeline({ classifier, resolver })
		const result = await pipeline("10118")
		expect(result.kind.kind).toBe("postcode_only")
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})

	it("custom classifyKind opt overrides the default", async () => {
		const customKind = vi.fn(async () => ({
			kind: "vague" as const,
			confidence: 0.5,
			alternatives: [],
		}))

		const pipeline = createRuntimePipeline({ classifyKind: customKind })
		const result = await pipeline("Paris")
		expect(customKind).toHaveBeenCalled()
		expect(result.kind.kind).toBe("vague")
	})
})
