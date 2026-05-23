/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for `runPipeline` — every stage stubbed with a fake so the test exercises the
 *   coordinator's composition + branching logic without depending on neural / resolver concretes.
 */

import { describe, expect, it, vi } from "vitest"
import type { AddressNode, AddressTree } from "../decoder/types.js"
import type { Resolver } from "../resolver/types.js"
import { runPipeline } from "./runtime-pipeline.js"
import type {
	AddressClassifier,
	LocaleHint,
	NormalizedInputLite,
	QueryKindResult,
	QueryShapeLite,
	RuntimePipelineStages,
} from "./types.js"

function fakeTree(raw: string, roots: AddressNode[] = []): AddressTree {
	return { raw, roots }
}

function fakeClassifier(tree: AddressTree): AddressClassifier {
	return { parse: vi.fn(async (_text: string) => tree) }
}

function fakeResolver(decorator: (tree: AddressTree) => AddressTree): Resolver {
	return { resolveTree: vi.fn(async (tree: AddressTree) => decorator(tree)) }
}

describe("runPipeline — defaults", () => {
	it("runs with all stages absent — empty result, no throw", async () => {
		const result = await runPipeline("hello", {})
		expect(result.input).toBe("hello")
		expect(result.normalized.normalized).toBe("hello")
		expect(result.queryShape.knownFormats).toEqual([])
		expect(result.locale.locale).toBe("und")
		expect(result.kind.kind).toBe("structured_address")
		expect(result.tree.roots).toEqual([])
		expect(result.path).toBe("full")
	})

	it("threads the caller's locale through detectLocale stub", async () => {
		const result = await runPipeline("hello", {}, { locale: "en-US" })
		expect(result.locale.locale).toBe("en-US")
		expect(result.locale.source).toBe("caller")
		expect(result.locale.confidence).toBe(1.0)
	})

	it("records per-stage timing", async () => {
		const result = await runPipeline("hello", {})
		expect(result.timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["query-shape"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["locale-gate"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["kind-classifier"]).toBeGreaterThanOrEqual(0)
	})
})

describe("runPipeline — stage composition", () => {
	it("calls each stage in order: normalize → queryShape → detectLocale → classifyKind → classify → resolve", async () => {
		const order: string[] = []

		const stages: RuntimePipelineStages = {
			normalize: vi.fn((raw) => {
				order.push("normalize")
				return { raw, normalized: raw }
			}),
			computeQueryShape: vi.fn((_input) => {
				order.push("queryShape")
				return { knownFormats: [] }
			}),
			detectLocale: vi.fn(async (_in, _sh, opts) => {
				order.push("detectLocale")
				return { locale: opts?.hint ?? "und", confidence: 1, alternatives: [], source: "caller" as const }
			}),
			classifyKind: vi.fn(async (_in, _sh, _lo) => {
				order.push("classifyKind")
				return { kind: "structured_address" as const, confidence: 0, alternatives: [] }
			}),
			classifier: {
				parse: vi.fn(async (text) => {
					order.push("classifier")
					return fakeTree(text)
				}),
			},
			resolver: {
				resolveTree: vi.fn(async (tree) => {
					order.push("resolver")
					return tree
				}),
			},
		}

		await runPipeline("hello", stages)
		expect(order).toEqual(["normalize", "queryShape", "detectLocale", "classifyKind", "classifier", "resolver"])
	})

	it("passes QueryShape into classifier.parse", async () => {
		const shape: QueryShapeLite = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.9 }],
		}
		const classifier: AddressClassifier = { parse: vi.fn(async () => fakeTree("10118")) }
		await runPipeline("10118", {
			computeQueryShape: () => shape,
			classifier,
		})
		expect(classifier.parse).toHaveBeenCalledWith("10118", { queryShape: shape })
	})

	it("skips resolver when not wired", async () => {
		const classifier = fakeClassifier(fakeTree("hello"))
		const result = await runPipeline("hello", { classifier })
		expect(result.tree.roots).toEqual([])
		expect(result.timing["resolve"]).toBeUndefined()
	})

	it("skips classifier when not wired (empty tree result)", async () => {
		const resolver = fakeResolver((t) => t)
		const result = await runPipeline("hello", { resolver })
		expect(result.tree.roots).toEqual([])
		expect(result.timing["token-classify"]).toBeUndefined()
	})
})

describe("runPipeline — fast-path routing", () => {
	const postcodeOnlyKind: QueryKindResult = {
		kind: "postcode_only",
		confidence: 0.97,
		alternatives: [],
	}

	const postcodeShape: QueryShapeLite = {
		knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.95 }],
		totalLength: 5,
		characterClass: "numeric",
	}

	it("fast-paths postcode_only inputs with matching shape", async () => {
		const classifier = fakeClassifier(fakeTree("10118"))
		const resolver = fakeResolver((t) => t)
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
			classifier,
			resolver,
		}

		const result = await runPipeline("10118", stages)
		expect(result.path).toBe("fast-path")
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(resolver.resolveTree).toHaveBeenCalled()
		// Fast-path tree is built from the QueryShape format hit.
		expect(result.tree.roots[0]?.tag).toBe("postcode")
		expect(result.tree.roots[0]?.value).toBe("10118")
	})

	it("fast-paths locality_only inputs when shape is short + alpha", async () => {
		const localityShape: QueryShapeLite = {
			knownFormats: [],
			totalLength: 5,
			characterClass: "alpha",
		}
		const localityKind: QueryKindResult = {
			kind: "locality_only",
			confidence: 0.96,
			alternatives: [],
		}
		const classifier = fakeClassifier(fakeTree("Paris"))
		const resolver = fakeResolver((t) => t)

		const result = await runPipeline("Paris", {
			computeQueryShape: () => localityShape,
			classifyKind: async () => localityKind,
			classifier,
			resolver,
		})
		expect(result.path).toBe("fast-path")
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(result.tree.roots[0]?.tag).toBe("locality")
	})

	it("forceFullPipeline disables fast-path", async () => {
		const classifier = fakeClassifier(fakeTree("10118"))
		const resolver = fakeResolver((t) => t)
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
			classifier,
			resolver,
		}

		const result = await runPipeline("10118", stages, { forceFullPipeline: true })
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})

	it("does not fast-path when kind confidence is below threshold", async () => {
		const classifier = fakeClassifier(fakeTree("10118"))
		const resolver = fakeResolver((t) => t)
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => ({ ...postcodeOnlyKind, confidence: 0.5 }),
			classifier,
			resolver,
		}

		const result = await runPipeline("10118", stages)
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})

	it("does not fast-path when kind says postcode but shape has no postcode hit", async () => {
		const classifier = fakeClassifier(fakeTree("hello"))
		const resolver = fakeResolver((t) => t)
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => ({ knownFormats: [], totalLength: 5, characterClass: "alpha" }),
			classifyKind: async () => postcodeOnlyKind,
			classifier,
			resolver,
		}

		const result = await runPipeline("hello", stages)
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})

	it("does not fast-path when resolver is absent", async () => {
		const classifier = fakeClassifier(fakeTree("10118"))
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
			classifier,
		}

		const result = await runPipeline("10118", stages)
		expect(result.path).toBe("full")
		expect(classifier.parse).toHaveBeenCalled()
	})
})

describe("runPipeline — graceful degradation", () => {
	it("classifier throwing returns an empty tree but pipeline continues", async () => {
		const classifier: AddressClassifier = {
			parse: vi.fn(async () => {
				throw new Error("classifier boom")
			}),
		}
		const resolver = fakeResolver((t) => ({
			...t,
			roots: [...t.roots, { tag: "country" as const, value: "US", start: 0, end: 2, confidence: 1, children: [] }],
		}))

		const result = await runPipeline("hello", { classifier, resolver })
		expect(result.tree.roots).toHaveLength(1)
		expect(result.tree.roots[0]?.tag).toBe("country")
	})

	it("resolver throwing returns the classifier tree unchanged", async () => {
		const classifier = fakeClassifier(
			fakeTree("hello", [{ tag: "country", value: "US", start: 0, end: 2, confidence: 1, children: [] }])
		)
		const resolver: Resolver = {
			resolveTree: vi.fn(async () => {
				throw new Error("resolver boom")
			}),
		}

		const result = await runPipeline("hello", { classifier, resolver })
		expect(result.tree.roots[0]?.tag).toBe("country")
	})
})

describe("runPipeline — locale + opts threading", () => {
	it("passes locale hint to detectLocale", async () => {
		const detectLocale = vi.fn(
			async (_in: NormalizedInputLite, _sh: QueryShapeLite, opts?: { hint?: string }): Promise<LocaleHint> => ({
				locale: opts?.hint ?? "und",
				confidence: 1,
				alternatives: [],
				source: "caller",
			})
		)
		await runPipeline("hello", { detectLocale }, { locale: "fr-FR" })
		expect(detectLocale).toHaveBeenCalledWith(expect.anything(), expect.anything(), { hint: "fr-FR" })
	})

	it("passes resolveOpts to resolver", async () => {
		const resolver: Resolver = { resolveTree: vi.fn(async (t) => t) }
		await runPipeline("hello", { resolver }, { resolveOpts: { maxLookups: 3 } })
		expect(resolver.resolveTree).toHaveBeenCalledWith(expect.anything(), { maxLookups: 3 })
	})
})
