import { repoRootPath } from "@mailwoman/core/paths"
import { heuristicLeads, pythonSourceComments, sourceComments } from "@mailwoman/repo-health/comment-triage"
import { describe, expect, it } from "vitest"

describe("sourceComments", () => {
	it("keeps every TypeScript scanner comment with its source range", () => {
		const comments = sourceComments("fixture.ts", "/** API contract. */\nconst a = 1 // this\n/* TODO: revisit */")

		expect(comments.map(({ kind, startLine, text }) => ({ kind, startLine, text }))).toEqual([
			{ kind: "jsdoc", startLine: 1, text: "/** API contract. */" },
			{ kind: "line", startLine: 2, text: "// this" },
			{ kind: "block", startLine: 3, text: "/* TODO: revisit */" },
		])
	})

	it("marks heuristic output as low-confidence review leads", () => {
		const [comment] = sourceComments("fixture.ts", "// TODO: this is obviously magic")

		expect(
			heuristicLeads(comment!).map(({ category, confidence, source }) => ({ category, confidence, source }))
		).toEqual([
			{ category: "outdated", confidence: "low", source: "heuristic" },
			{ category: "sensational", confidence: "low", source: "heuristic" },
			{ category: "unclear", confidence: "low", source: "heuristic" },
		])
	})

	it("reads Python module docstrings and line comments through the tokenizer adapter", async () => {
		const comments = await pythonSourceComments(repoRootPath(), ["corpus-python/scripts/verify_toolchain.py"])

		expect(comments.some((comment) => comment.kind === "docstring")).toBe(true)
		expect(comments.some((comment) => comment.kind === "line")).toBe(true)
	})
})
