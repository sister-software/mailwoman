/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Equivalence tests for `wrapLegacyClassifier`. Goal: a wrapped legacy classifier emits one
 *   `ClassificationProposal` per visible classification the underlying rule classifier would have
 *   attached to a span (modulo the new `source` / `source_id` / `metadata` fields).
 */

// Side-effect import: forces `@mailwoman/core` to fully initialise (including its libpostal
// top-level await) BEFORE the deep subpath imports below pull in slices of the same module
// graph. Without this, Vite's TLA-aware loader sees the deep-path imports as a cycle and leaves
// the bare-import re-exports unbound when HouseNumberClassifier evaluates `class extends ...`.
import "@mailwoman/core"
import { TokenContext } from "@mailwoman/core/tokenization"
import { describe, expect, test } from "vitest"
import { wrapLegacyClassifier } from "./adapter.js"
import { HouseNumberClassifier } from "./HouseNumberClassifier.js"

const SECTION = "6220 SE Salmon St"

describe("wrapLegacyClassifier — HouseNumberClassifier", () => {
	const wrapped = wrapLegacyClassifier({
		id: "house_number",
		classifier: HouseNumberClassifier,
		emits: ["house_number"],
		legacyTags: ["house_number"],
	})

	test("declares expected metadata", () => {
		expect(wrapped.id).toBe("house_number")
		expect(wrapped.emits).toEqual(["house_number"])
		expect(wrapped.locales).toEqual(["*"])
	})

	test("emits a proposal whose body matches the legacy classifier's span", async () => {
		// Pre-refactor reference: run the legacy classifier directly on a
		// local TokenContext, collect every span tagged `house_number`.
		const referenceContext = new TokenContext(SECTION)
		const legacy = new HouseNumberClassifier()
		legacy.classifyTokens(referenceContext)

		const referenceSpans: string[] = []
		for (const section of referenceContext.sections) {
			for (const child of section.children) {
				if (child.classifications.has("house_number")) {
					referenceSpans.push(child.body)
				}
			}
		}

		// Wrapper run, on the same input as a single section.
		const section = new TokenContext(SECTION).sections[0]!
		const proposals = await wrapped.classify(section, {})

		const wrappedBodies = proposals.map((p) => p.span.body)
		expect(wrappedBodies.sort()).toEqual(referenceSpans.sort())
	})

	test("every emitted proposal carries source=rule and the configured source_id", async () => {
		const section = new TokenContext(SECTION).sections[0]!
		const proposals = await wrapped.classify(section, {})

		expect(proposals.length).toBeGreaterThan(0)
		for (const p of proposals) {
			expect(p.source).toBe("rule")
			expect(p.source_id).toBe("house_number")
			expect(p.component).toBe("house_number")
			expect(p.confidence).toBeGreaterThan(0)
			expect(p.metadata?.legacyClassification).toBe("house_number")
		}
	})

	test("drops proposals for tags the wrapper does not declare in `emits`", async () => {
		// Wrap with an empty emits list — the wrapper should drop every
		// candidate because nothing it produces is permitted.
		const restrictive = wrapLegacyClassifier({
			id: "house_number",
			classifier: HouseNumberClassifier,
			emits: [],
			legacyTags: ["house_number"],
		})

		const section = new TokenContext(SECTION).sections[0]!
		const proposals = await restrictive.classify(section, {})
		expect(proposals).toEqual([])
	})
})
