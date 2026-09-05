/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license` end to end on the compiled CLI: `register` printing the derivation, `keygen` into a scratch
 *   config root, `issue` refused against a register that does not carry the new key, and `verify` reading a token this
 *   build does not trust.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	publishedLicenseKeys,
} from "@mailwoman/core/license"
import { workspacePath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { describe, expect, test } from "vitest"

const cliBin = workspacePath("mailwoman", "out", "cli.js")

async function cli(args: string[], env: Record<string, string> = {}) {
	return runFile(process.execPath, [cliBin, "license", ...args], {
		env: childEnv({ NODE_NO_WARNINGS: "1", ...env }),
	}).catch((error: unknown) => {
		if (isProcessError(error)) return error

		throw error
	})
}

describe("mailwoman license", () => {
	test("register prints the well-known derivation", async () => {
		const { stdout } = await cli(["register"])

		expect(parseJSONStrict(stdout)).toEqual(publishedLicenseKeys())
	})

	test("keygen mints a pair under the config root and issue refuses a key the register does not carry", async () => {
		await using scratch = await temporaryDirectory("license-cli-")
		const env = { MAILWOMAN_CONFIG_ROOT: String(scratch.path) }

		const keygen = await cli(["keygen", "--major", "9", "--json"], env)
		const minted = parseJSONStrict<{ kid: string; publicKeyPEM: string }>(keygen.stdout)

		expect(minted.kid).toMatch(/^v9-[0-9a-f]{8}$/u)

		const issue = await cli(["issue", "--licensee", "Example Ltd"], env)

		expect(issue.stderr).toContain("not in this build's register")
	})

	test("verify reads unknown_key for a token signed by a key this build does not trust", async () => {
		const pair = await generateLicenseSigningKeyPair()
		const kid = await licenseKeyID(pair.publicKeyPEM, 9)

		const token = await encodeLicenseKey(
			{ v: 1, kid, licensee: "x", issued: "2026-01-01", scope: "all", terms: "LicenseRef-Commercial" },
			pair.privateKeyPEM
		)

		const { stdout } = await cli(["verify", "--key", token, "--json"])

		expect(parseJSONStrict<{ status: string; kid: string }>(stdout)).toMatchObject({ status: "unknown_key", kid })
	})
})
