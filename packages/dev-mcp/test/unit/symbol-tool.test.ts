/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The contract half of `mwdev_symbol`: a search that answers with denominators and states what it did not read.
 */

import type { EngineRegistryLike } from "@mailwoman/dev-mcp/engine-registry"
import type { JobRegistry } from "@mailwoman/dev-mcp/jobs"
import { buildToolTable } from "@mailwoman/dev-mcp/tools"
import { describe, expect, it } from "vitest"

/**
 * The search reads the working tree and nothing else; a registry that throws on touch proves it.
 */
const noRegistry = new Proxy({} as EngineRegistryLike, {
	get() {
		throw new Error("mwdev_symbol must not build an engine")
	},
})

const tool = (await buildToolTable({ registry: noRegistry, jobs: {} as JobRegistry, startedAt: 0 })).find(
	(each) => each.name === "mwdev_symbol"
)!

interface SymbolResult {
	query: string
	n_names: number
	n_sites: number
	findings: { name: string; sites: { file: string; exported: boolean }[] }[]
	not_covered: string[]
}

async function search(query: string): Promise<SymbolResult> {
	return (await tool.handler({ query })) as SymbolResult
}

describe("mwdev_symbol", () => {
	it("finds the shared home of a symbol that has one", async () => {
		const result = await search("percentile")
		const names = result.findings.map((finding) => finding.name)

		expect(names).toContain("percentile")

		const files = result.findings.flatMap((finding) => finding.sites.map((site) => site.file))

		expect(files).toContain("packages/core/utils/stats.ts")
	})

	it("counts names and sites separately, because one name can have several homes", async () => {
		const result = await search("percentile")

		expect(result.n_names).toBe(result.findings.length)
		expect(result.n_sites).toBe(result.findings.reduce((total, finding) => total + finding.sites.length, 0))
		expect(result.n_sites).toBeGreaterThan(result.n_names)
	})

	it("states what the search did not read rather than letting a zero imply coverage", async () => {
		const result = await search("thereIsNoSuchSymbolAnywhere")

		expect(result.n_names).toBe(0)
		expect(result.not_covered.join(" ")).toContain(".tsx")
	})
})
