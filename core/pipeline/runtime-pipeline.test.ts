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
		expect(classifier.parse).toHaveBeenCalledWith("10118", { queryShape: shape, postcodeRepair: true })
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

	it("fast-paths even when resolver is absent (fast-path tree is built from QueryShape alone)", async () => {
		// Previously the coordinator required a resolver for fast-path to fire. As of the kind-
		// classifier ship, the fast-path tree from QueryShape is useful standalone — a consumer who
		// just wants the parsed structure for "10118" shouldn't be forced to pay for the classifier.
		const classifier = fakeClassifier(fakeTree("10118"))
		const stages: RuntimePipelineStages = {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
			classifier,
		}

		const result = await runPipeline("10118", stages)
		expect(result.path).toBe("fast-path")
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(result.tree.roots[0]?.tag).toBe("postcode")
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

describe("runPipeline — abort signal", () => {
	it("throws AbortError when signal is already aborted before the call", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(runPipeline("hello", {}, { signal: controller.signal })).rejects.toThrow()
	})

	it("aborts between normalize and queryShape if signaled", async () => {
		const controller = new AbortController()
		const computeQueryShape = vi.fn(() => ({ knownFormats: [] }))
		const normalize = vi.fn((raw: string) => {
			// Abort during normalize — coordinator catches it on the next checkpoint (before queryShape).
			controller.abort()
			return { raw, normalized: raw }
		})

		await expect(
			runPipeline("hello", { normalize, computeQueryShape }, { signal: controller.signal })
		).rejects.toThrow()
		expect(normalize).toHaveBeenCalled()
		expect(computeQueryShape).not.toHaveBeenCalled()
	})

	it("aborts between classifyKind and classifier if signaled", async () => {
		const controller = new AbortController()
		const classifier = fakeClassifier(fakeTree("hello"))
		const resolver = fakeResolver((t) => t)
		const classifyKind = vi.fn(async () => {
			controller.abort()
			return { kind: "structured_address" as const, confidence: 0, alternatives: [] }
		})

		await expect(
			runPipeline("hello", { classifyKind, classifier, resolver }, { signal: controller.signal })
		).rejects.toThrow()
		expect(classifier.parse).not.toHaveBeenCalled()
		expect(resolver.resolveTree).not.toHaveBeenCalled()
	})

	it("aborts between classifier and resolver if signaled", async () => {
		const controller = new AbortController()
		const classifier: AddressClassifier = {
			parse: vi.fn(async (text) => {
				controller.abort()
				return fakeTree(text)
			}),
		}
		const resolver = fakeResolver((t) => t)

		await expect(runPipeline("hello", { classifier, resolver }, { signal: controller.signal })).rejects.toThrow()
		expect(classifier.parse).toHaveBeenCalled()
		expect(resolver.resolveTree).not.toHaveBeenCalled()
	})

	it("uses signal.reason when present (custom abort reason)", async () => {
		const controller = new AbortController()
		const customReason = new Error("custom abort reason")
		controller.abort(customReason)

		await expect(runPipeline("hello", {}, { signal: controller.signal })).rejects.toThrow("custom abort reason")
	})

	it("runs to completion when signal is provided but not aborted", async () => {
		const controller = new AbortController()
		const result = await runPipeline("hello", {}, { signal: controller.signal })
		expect(result.tree).toBeDefined()
	})
})

describe("runPipeline — timing budget shape", () => {
	const postcodeShape: QueryShapeLite = {
		knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.95 }],
		totalLength: 5,
		characterClass: "numeric",
	}
	const postcodeOnlyKind: QueryKindResult = {
		kind: "postcode_only",
		confidence: 0.97,
		alternatives: [],
	}

	it("full path with all stages: normalize / query-shape / locale-gate / kind-classifier / token-classify / resolve", async () => {
		const classifier = fakeClassifier(fakeTree("hello"))
		const resolver = fakeResolver((t) => t)
		const result = await runPipeline("hello", { classifier, resolver })

		expect(Object.keys(result.timing).sort()).toEqual(
			["kind-classifier", "locale-gate", "normalize", "query-shape", "resolve", "token-classify"].sort()
		)
	})

	it("fast-path with resolver wired: omits token-classify, includes resolve", async () => {
		const classifier = fakeClassifier(fakeTree("10118"))
		const resolver = fakeResolver((t) => t)
		const result = await runPipeline("10118", {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
			classifier,
			resolver,
		})

		expect(result.path).toBe("fast-path")
		expect(result.timing["token-classify"]).toBeUndefined()
		expect(result.timing["resolve"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["normalize"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["kind-classifier"]).toBeGreaterThanOrEqual(0)
	})

	it("fast-path without resolver: omits both token-classify and resolve", async () => {
		const result = await runPipeline("10118", {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => postcodeOnlyKind,
		})

		expect(result.path).toBe("fast-path")
		expect(result.timing["token-classify"]).toBeUndefined()
		expect(result.timing["resolve"]).toBeUndefined()
	})

	it("full path without resolver: includes token-classify, omits resolve", async () => {
		const classifier = fakeClassifier(fakeTree("hello"))
		const result = await runPipeline("hello", { classifier })

		expect(result.path).toBe("full")
		expect(result.timing["token-classify"]).toBeGreaterThanOrEqual(0)
		expect(result.timing["resolve"]).toBeUndefined()
	})

	it("timing values are non-negative numbers", async () => {
		const result = await runPipeline("hello", {})
		for (const [stage, ms] of Object.entries(result.timing)) {
			expect(ms, `${stage} timing must be finite + non-negative`).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(ms), `${stage} timing must be finite`).toBe(true)
		}
	})
})

describe("runPipeline — non-graceful stage failures", () => {
	// Contract: classifier + resolver are wrapped in safe* helpers (graceful). The pre-classifier
	// stages — detectLocale, classifyKind — are NOT wrapped because their failure modes indicate a
	// genuine contract violation (locale detector returning null, kind classifier crashing on its
	// own rules), not external-data noise. These tests pin the asymmetry as a contract.

	it("detectLocale throwing propagates (not swallowed)", async () => {
		const detectLocale = vi.fn(async () => {
			throw new Error("locale detector exploded")
		})
		await expect(runPipeline("hello", { detectLocale })).rejects.toThrow("locale detector exploded")
	})

	it("classifyKind throwing propagates (not swallowed)", async () => {
		const classifyKind = vi.fn(async () => {
			throw new Error("kind classifier exploded")
		})
		await expect(runPipeline("hello", { classifyKind })).rejects.toThrow("kind classifier exploded")
	})

	it("normalize throwing propagates (synchronous failure)", async () => {
		const normalize = vi.fn(() => {
			throw new Error("normalize exploded")
		})
		await expect(runPipeline("hello", { normalize })).rejects.toThrow("normalize exploded")
	})

	it("computeQueryShape throwing propagates (synchronous failure)", async () => {
		const computeQueryShape = vi.fn(() => {
			throw new Error("queryShape exploded")
		})
		await expect(runPipeline("hello", { computeQueryShape })).rejects.toThrow("queryShape exploded")
	})

	it("resolver throwing on fast-path returns the fast-path tree unchanged (graceful)", async () => {
		// Fast-path uses safeResolve, so a resolver failure does NOT propagate. The fast-path tree
		// built from QueryShape is the fallback.
		const postcodeShape: QueryShapeLite = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.95 }],
			totalLength: 5,
			characterClass: "numeric",
		}
		const resolver: Resolver = {
			resolveTree: vi.fn(async () => {
				throw new Error("resolver exploded")
			}),
		}

		const result = await runPipeline("10118", {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => ({ kind: "postcode_only" as const, confidence: 0.97, alternatives: [] }),
			resolver,
		})

		expect(result.path).toBe("fast-path")
		expect(result.tree.roots[0]?.tag).toBe("postcode")
		expect(result.tree.roots[0]?.value).toBe("10118")
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

describe("runPipeline — coarse-placer soft prior (#244)", () => {
	function captureResolveOpts() {
		const seen: Array<unknown> = []
		const resolver: Resolver = {
			resolveTree: vi.fn(async (t, opts) => {
				seen.push(opts)
				return t
			}),
		}
		return { resolver, seen }
	}

	it("byte-stable when no placeCountry stage is wired (resolveOpts passed through verbatim)", async () => {
		const { resolver, seen } = captureResolveOpts()
		await runPipeline("hello", { resolver }, { resolveOpts: { maxLookups: 3 } })
		// No coarse-placer ⇒ effectiveOpts === opts ⇒ resolver sees exactly the caller's resolveOpts.
		expect(seen[0]).toEqual({ maxLookups: 3 })
	})

	it("a confident in-map guess becomes an anchorPosterior fed to the resolver", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "FR", confidence: 0.94 }))
		await runPipeline("12 rue de la Paix, Paris", { resolver, placeCountry })
		expect(placeCountry).toHaveBeenCalledOnce()
		expect(seen[0]).toMatchObject({
			anchorPosterior: { FR: 0.94 },
			anchorWeight: 1.0,
		})
	})

	it("uses the placer's full posterior distribution when supplied (vs the one-hot argmax)", async () => {
		const { resolver, seen } = captureResolveOpts()
		// A country-ambiguous in-map guess: argmax FR, but GB nearly as likely. The distribution lets the
		// resolver break the tie with its own evidence instead of committing to FR.
		const placeCountry = vi.fn(() => ({ country: "FR", confidence: 0.45, posterior: { FR: 0.45, GB: 0.4 } }))
		await runPipeline("Birmingham", { resolver, placeCountry })
		expect(seen[0]).toMatchObject({ anchorPosterior: { FR: 0.45, GB: 0.4 }, anchorWeight: 1.0 })
	})

	it("preserves the caller's resolveOpts fields while injecting the posterior", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "DE", confidence: 0.97 }))
		await runPipeline("Hauptstraße 5, Berlin", { resolver, placeCountry }, { resolveOpts: { maxLookups: 7 } })
		expect(seen[0]).toMatchObject({ maxLookups: 7, anchorPosterior: { DE: 0.97 } })
	})

	it("abstains (country: null) ⇒ no posterior injected", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: null, confidence: 0.3 }))
		await runPipeline("ambiguous text", { resolver, placeCountry }, { resolveOpts: { maxLookups: 2 } })
		expect(seen[0]).toEqual({ maxLookups: 2 })
	})

	it("OTHER (off-map) ⇒ no posterior injected", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "OTHER", confidence: 0.99 }))
		await runPipeline("улица Пушкина", { resolver, placeCountry })
		expect(seen[0]).toBeUndefined()
	})

	it("defers to a caller-supplied anchorPosterior (a stronger postcode anchor) — never overwrites", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "FR", confidence: 0.94 }))
		await runPipeline(
			"75002",
			{ resolver, placeCountry },
			{ resolveOpts: { anchorPosterior: { GB: 1.0 }, anchorWeight: 2.0 } }
		)
		// Caller's posterior wins; the coarse-placer is a no-op here.
		expect(seen[0]).toEqual({ anchorPosterior: { GB: 1.0 }, anchorWeight: 2.0 })
	})

	it("respects a caller-supplied anchorWeight while injecting the placer's posterior", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "ES", confidence: 0.9 }))
		await runPipeline("Calle Mayor 1, Madrid", { resolver, placeCountry }, { resolveOpts: { anchorWeight: 3.5 } })
		expect(seen[0]).toMatchObject({ anchorPosterior: { ES: 0.9 }, anchorWeight: 3.5 })
	})

	it("records place-country timing only when the stage is wired", async () => {
		const placeCountry = vi.fn(() => ({ country: "US", confidence: 0.95 }))
		const withStage = await runPipeline("350 5th Ave, New York", { placeCountry })
		expect(withStage.timing["place-country"]).toBeGreaterThanOrEqual(0)
		const without = await runPipeline("350 5th Ave, New York", {})
		expect(without.timing["place-country"]).toBeUndefined()
	})

	it("flows the posterior on the fast-path too (postcode_only)", async () => {
		const { resolver, seen } = captureResolveOpts()
		const placeCountry = vi.fn(() => ({ country: "US", confidence: 0.96 }))
		const postcodeShape: QueryShapeLite = {
			knownFormats: [{ format: "us_zip", span: { start: 0, end: 5 }, confidence: 0.95 }],
			totalLength: 5,
			characterClass: "numeric",
		}
		const result = await runPipeline("10118", {
			computeQueryShape: () => postcodeShape,
			classifyKind: async () => ({ kind: "postcode_only" as const, confidence: 0.97, alternatives: [] }),
			resolver,
			placeCountry,
		})
		expect(result.path).toBe("fast-path")
		expect(seen[0]).toMatchObject({ anchorPosterior: { US: 0.96 }, anchorWeight: 1.0 })
	})
})
