/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `mailwoman data prune` on the compiled CLI refuses a `--retain` that is not a positive whole number
 *   before it plans, and keeps the active generation's files. Run `yarn compile` before this suite.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { ServingRole } from "@mailwoman/core/layers"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"

import { replaceActiveSelection } from "#data/catalog"
import { mailwomanCLIPath } from "#metadata"
import { withCLISpawnLockAsync } from "#test-kit/cli-spawn-lock"
import { installFixtureArtifact } from "#test-kit/fixture-registry"

const CLI_SPAWN_TIMEOUT_MS = 120_000

vi.setConfig({ testTimeout: 300_000 })

const cliBin = await mailwomanCLIPath()

let root: TemporaryDirectory
let activePath: string

beforeAll(async () => {
	root = await temporaryDirectory("mw-cli-prune-")

	const active = await installFixtureArtifact(root.path, ServingRole.Candidate, "candidate.db", "active release")

	await replaceActiveSelection(root.path, { basedOn: null, set: [active.entry] })
	activePath = active.path
})

afterAll(async () => {
	await root[Symbol.asyncDispose]()
})

/**
 * Run the compiled CLI against the temporary data root, answering its exit status and output.
 */
async function cli(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
	return withCLISpawnLockAsync(() =>
		runFile(process.execPath, [cliBin, ...args], {
			env: childEnv({ NODE_NO_WARNINGS: "1", MAILWOMAN_DATA_ROOT: root.path.toString() }),
			maxBuffer: 16 * 1024 * 1024,
			timeout: CLI_SPAWN_TIMEOUT_MS,
		}).then(
			({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
			(error: { code?: number; stdout?: string; stderr?: string }) => ({
				status: typeof error.code === "number" ? error.code : 1,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
			})
		)
	)
}

describe("mailwoman data prune --retain", () => {
	test.each(["not-a-number", "0", "-1", "0.5", "Infinity"])("refuses %s and names the option", async (value) => {
		const result = await cli("data", "prune", "--retain", value, "--data-root", root.path.toString())

		expect(result.status).not.toBe(0)
		expect(`${result.stdout}\n${result.stderr}`).toContain("--retain must be a positive whole number")
		expect(await readLocalTextFile(activePath)).toBe("active release")
	})
})
