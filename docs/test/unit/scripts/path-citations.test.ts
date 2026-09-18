/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Unit tests for the path-citation instrument (`scripts/docs/path-citations.ts`), check 5 of
 *   `check/docs-structure.ts`.
 *
 *   What is worth pinning here is the REFUSAL boundary, not the walk. The check's finding count is only meaningful if
 *   the classes it excludes are the ones its docstring names: a refusal that widens silently makes the count fall
 *   without anything being repaired, and one that narrows reports the regex rather than the tree. Pure strings only —
 *   the filesystem walk is exercised by running the check itself.
 */

import {
	CitationRefusal,
	citationTarget,
	isPointInTimeRecord,
	refusalFor,
} from "@mailwoman/docs/scripts/docs-path-citations"
import { describe, expect, it } from "vitest"

describe("refusalFor", () => {
	it("admits a repository-rooted path", () => {
		expect(refusalFor("packages/core/lib/fs/writers.ts")).toBeNull()
	})

	it("admits a directory citation", () => {
		expect(refusalFor("docs/records/evals/")).toBeNull()
	})

	it("refuses a package subpath specifier, which shares the shape of a path", () => {
		expect(refusalFor("mailwoman/gazetteer-pipeline")).toBe(CitationRefusal.NotRepositoryRooted)
		expect(refusalFor("@mailwoman/core/fs/readers")).toBe(CitationRefusal.NotRepositoryRooted)
	})

	it("refuses a bare directory name, which names the tree rather than a file in it", () => {
		expect(refusalFor("packages")).toBe(CitationRefusal.NotRepositoryRooted)
		expect(refusalFor("docs")).toBe(CitationRefusal.NotRepositoryRooted)
	})

	it("refuses an elided path", () => {
		expect(refusalFor("corpus-python/.../configs/v1.8.0-fr-admin-split.yaml")).toBe(CitationRefusal.Elided)
		expect(refusalFor("packages/…/lib/index.ts")).toBe(CitationRefusal.Elided)
	})

	it("refuses a pattern over paths rather than one path", () => {
		expect(refusalFor("packages/*/lib/env.ts")).toBe(CitationRefusal.Pattern)
		expect(refusalFor("packages/neural-weights-<locale>/model.onnx")).toBe(CitationRefusal.Pattern)
		expect(refusalFor("$MAILWOMAN_DATA_ROOT/weights/en-us")).toBe(CitationRefusal.Pattern)
	})

	it("refuses generated output, whose absence describes the checkout rather than the tree", () => {
		expect(refusalFor("packages/mailwoman/out/cli/index.js")).toBe(CitationRefusal.Generated)
		expect(refusalFor("docs/build/index.html")).toBe(CitationRefusal.Generated)
	})

	it("refuses a command line", () => {
		expect(refusalFor("node packages/mailwoman/lib/cli.ts")).toBe(CitationRefusal.NotAPath)
	})
})

describe("citationTarget", () => {
	it("keeps a plain path", () => {
		expect(citationTarget("packages/core/lib/fs/writers.ts")).toBe("packages/core/lib/fs/writers.ts")
	})

	it("drops a line, a line:column, and a line range", () => {
		expect(citationTarget("packages/core/lib/fs/writers.ts:102")).toBe("packages/core/lib/fs/writers.ts")
		expect(citationTarget("packages/core/lib/fs/writers.ts:102:4")).toBe("packages/core/lib/fs/writers.ts")
		expect(citationTarget(".github/workflows/publish.yml:129-131")).toBe(".github/workflows/publish.yml")
	})

	it("drops an anchor, which names a heading inside the same file", () => {
		expect(citationTarget("RELEASING.md#recovering-from-a-partial-release")).toBe("RELEASING.md")
	})

	it("keeps a trailing slash, so a directory citation stays one", () => {
		expect(citationTarget("docs/records/evals/")).toBe("docs/records/evals/")
	})

	it("keeps a version number, which is not a position", () => {
		expect(citationTarget("data/gazetteer/anchor-lexicon-v1.json")).toBe("data/gazetteer/anchor-lexicon-v1.json")
	})
})

describe("isPointInTimeRecord", () => {
	it("reads a dated filename as a record wherever it sits", () => {
		expect(isPointInTimeRecord("docs/records/evals/2026-07-22-night-en-gb-postmortem.md")).toBe(true)
		expect(isPointInTimeRecord("docs/superpowers/specs/2026-08-26-geographic-model-boundaries.md")).toBe(true)
	})

	it("reads a declared record tree as a record", () => {
		expect(isPointInTimeRecord("docs/records/plan/phases/PHASE_0_foundation.mdx")).toBe(true)
		expect(isPointInTimeRecord("docs/superpowers/inventory/baseline.md")).toBe(true)
		expect(isPointInTimeRecord("config/vale/fixtures/dirty.md")).toBe(true)
	})

	it("holds the living trees in scope", () => {
		expect(isPointInTimeRecord("docs/engineering/SCOPE.mdx")).toBe(false)
		expect(isPointInTimeRecord("docs/engineering/reference/layer-contract.mdx")).toBe(false)
		expect(isPointInTimeRecord("docs/articles/developers/how-to/tune-confidence-thresholds.mdx")).toBe(false)
	})

	it("holds the published site snapshot in scope, which AGENTS.md sends a new reader to", () => {
		expect(isPointInTimeRecord("docs/records/site-2026-08/concepts/what-mailwoman-is.mdx")).toBe(false)
	})
})
