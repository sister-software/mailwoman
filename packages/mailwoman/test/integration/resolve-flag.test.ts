import { pathExists } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { stripAnsi } from "mailwoman/cli-kit"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { parseCommand } from "mailwoman/cli-native/spec"
import { spec as parseSpec } from "mailwoman/commands/parse"
import { $public } from "mailwoman/env"
import { describe, expect, test } from "vitest"

const cliBin = await mailwomanCLIPath()

const DEFAULT_WOF_PATH = wofDatabasePath("whosonfirst-data-admin-us-latest.db")
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH.toString()
const hasWOFDB = await pathExists(wofPath)
// oxlint-disable-next-line vitest/valid-title, vitest/valid-describe-callback -- an aliased describe. the title and callback arrive where it is invoked
const describeIfWOF = describe.skipIf(!hasWOFDB)

describe("--resolve option validation", () => {
	test("--resolve defaults to false", () => {
		expect(parseCommand(parseSpec, ["address"]).values.resolve).toBe(false)
	})

	test("--resolve accepts true", () => {
		expect(parseCommand(parseSpec, ["--resolve", "--neural", "address"]).values.resolve).toBe(true)
	})

	test("--resolve-db accepts an arbitrary path string", () => {
		expect(parseCommand(parseSpec, ["--resolve-db", "/tmp/wof.db", "address"]).values["resolve-db"]).toBe("/tmp/wof.db")
	})
})

describe("npx mailwoman parse --resolve error paths", () => {
	test("--resolve with no gazetteer at all exits non-zero with a clear message", async () => {
		await expect(
			runFile("node", [cliBin, "parse", "--resolve", "123 Main St"], {
				env: childEnv({ MAILWOMAN_WOF_DB: "", MAILWOMAN_CANDIDATE_DB: "none" }),
			})
		).rejects.toMatchObject({
			stdout: expect.stringMatching(/No WOF database configured/),
		})
	})
})

describeIfWOF(`npx mailwoman parse --neural --resolve against ${wofPath}`, () => {
	test("emits resolver-decorated XML for a known US locality", async () => {
		const result = await runFile(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--format", "xml", "Springfield, Illinois"],
			{ env: childEnv({ MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
		)

		expect(result.stdout).toContain("<address raw=")

		expect(result.stdout).toMatch(/src="resolver:[a-z_]+:\d+"/)
		expect(result.stdout).toMatch(/place="wof:\d+"/)
		expect(result.stdout).toMatch(/lat="-?\d+\.\d+"/)
		expect(result.stdout).toMatch(/lon="-?\d+\.\d+"/)
	}, 60_000)

	test("respects --resolve-db explicit path override (matches env default)", async () => {
		const result = await runFile(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--resolve-db", wofPath, "--format", "xml", "Springfield, Illinois"],
			{ env: childEnv({ NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
		)

		expect(result.stdout).toContain("<address raw=")
		expect(result.stdout).toMatch(/src="resolver:/)
	}, 60_000)

	test("Works without --resolve (check — flag default is off)", async () => {
		const result = await runFile("node", [cliBin, "parse", "--neural", "--format", "xml", "Springfield, Illinois"], {
			env: childEnv({ NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		expect(result.stdout).toContain("<address raw=")

		expect(result.stdout).not.toMatch(/src="resolver:/)
		expect(result.stdout).not.toMatch(/place="wof:/)
	}, 60_000)

	test("--candidates surfaces runner-up resolutions in XML", async () => {
		const result = await runFile(
			"node",
			[cliBin, "parse", "--resolve", "--candidates", "5", "--format", "xml", "Springfield, Illinois"],
			{ env: childEnv({ MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
		)

		expect(result.stdout).toContain("<address raw=")

		expect(result.stdout).toMatch(/<alternative[^>]*place="wof:\d+"/)
		expect(result.stdout).toMatch(/<alternative[^>]*name="/)
		expect(result.stdout).toMatch(/<alternative[^>]*lat="-?\d+\.\d+"/)
	}, 60_000)

	test("--candidates surfaces runner-up resolutions in JSON (tree shape)", async () => {
		const result = await runFile(
			"node",
			[cliBin, "parse", "--resolve", "--candidates", "3", "--format", "json", "Springfield, Illinois"],
			{ env: childEnv({ MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }), maxBuffer: 4 * 1024 * 1024 }
		)

		const tree = parseJSONStrict<Record<string, unknown>>(stripAnsiSpinner(result.stdout))
		expect(tree).toHaveProperty("raw")
		expect(tree).toHaveProperty("roots")

		interface TreeNode {
			alternatives?: unknown[]
			children?: TreeNode[]
		}

		const findAlternatives = (nodes: TreeNode[]): boolean =>
			nodes.some(
				(n) =>
					(Array.isArray(n.alternatives) && n.alternatives.length) ||
					(Array.isArray(n.children) && findAlternatives(n.children))
			)

		expect(findAlternatives(tree.roots as TreeNode[])).toBe(true)
	}, 60_000)

	test("without --candidates, JSON stays libpostal-flat (no tree shape leak)", async () => {
		const result = await runFile("node", [cliBin, "parse", "--resolve", "--format", "json", "Springfield"], {
			env: childEnv({ MAILWOMAN_WOF_DB: wofPath, NODE_NO_WARNINGS: "1" }),
			maxBuffer: 4 * 1024 * 1024,
		})

		const out = parseJSONStrict(stripAnsiSpinner(result.stdout))

		expect(out).not.toHaveProperty("raw")
		expect(out).not.toHaveProperty("roots")
	}, 60_000)
})

function stripAnsiSpinner(stdout: string): string {
	const cleaned = stripAnsi(stdout).trim()

	const objStart = cleaned.search(/[{[]/)

	return objStart >= 0 ? cleaned.slice(objStart) : cleaned
}
