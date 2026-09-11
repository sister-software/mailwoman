/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { MODULE_COHESION_THRESHOLDS, moduleCohesionCheck } from "@mailwoman/repo-health/checks/module/cohesion"
import { resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function plant(path: string, text: string): Promise<{ repoRoot: string; trackedFiles: string[] }> {
	const root = fixtures.use(await temporaryDirectory("module-cohesion-"))
	await makeDirectories(root.resolve("packages", "fixture", "lib"))
	await writeLocalTextFile(text, resolvePath(root.path, path))

	return { repoRoot: root.path.toString(), trackedFiles: [path] }
}

/**
 * Two chains that never call each other, each reading two module specifiers the other never reads.
 */
const TWO_RESPONSIBILITIES = [
	`import { alpha } from "pkg-a"`,
	`import { beta } from "pkg-b"`,
	`import { gamma } from "pkg-c"`,
	`import { delta } from "pkg-d"`,
	`export function parseHead(): number { return alpha(1) + beta(2) }`,
	`export function parseTail(): number { return parseHead() + alpha(3) }`,
	`export function writeHead(): number { return gamma(4) + delta(5) }`,
	`export function writeTail(): number { return writeHead() + gamma(6) }`,
].join("\n")

/**
 * The same two chains, each reading ONE specifier — the shape a facade of same-form wrappers takes.
 */
const ONE_SPECIFIER_EACH = [
	`import { alpha } from "pkg-a"`,
	`import { gamma } from "pkg-c"`,
	`export function parseHead(): number { return alpha(1) }`,
	`export function parseTail(): number { return parseHead() + alpha(3) }`,
	`export function writeHead(): number { return gamma(4) }`,
	`export function writeTail(): number { return writeHead() + gamma(6) }`,
].join("\n")

function padded(body: string, lines = MODULE_COHESION_THRESHOLDS.lines): string {
	return `${body}\n${"\n".repeat(lines)}`
}

describe("module-cohesion", () => {
	it("reports two communities that share no imported dependency", async () => {
		const context = await plant("packages/fixture/lib/two.ts", padded(TWO_RESPONSIBILITIES))

		const diagnostics = await moduleCohesionCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toContain("declaration communities")
		expect(diagnostics[0]?.message).toMatch(/parseHead \(\+1\)|writeHead \(\+1\)/)
		expect(diagnostics[0]?.file).toBe("packages/fixture/lib/two.ts")
	})

	it("leaves a facade alone when each community reads a single specifier", async () => {
		const context = await plant("packages/fixture/lib/facade.ts", padded(ONE_SPECIFIER_EACH))

		expect(await moduleCohesionCheck.run(context)).toEqual([])
	})

	it("does not inspect a module below the line threshold", async () => {
		const context = await plant("packages/fixture/lib/small.ts", TWO_RESPONSIBILITIES)

		expect(await moduleCohesionCheck.run(context)).toEqual([])
	})

	it("does not inspect co-located test files", async () => {
		const context = await plant("packages/fixture/lib/two.test.ts", padded(TWO_RESPONSIBILITIES))

		expect(await moduleCohesionCheck.run(context)).toEqual([])
	})
})
