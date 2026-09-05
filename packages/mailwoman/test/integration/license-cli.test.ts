/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license` end to end on the compiled CLI: `register` printing the derivation, `keygen` into a scratch
 *   config root, `issue` refused against a register that does not carry the new key, `verify` reading a token this build
 *   does not trust, and `adopt` and `refresh` refusing to write one. The compiled CLI ships its register, so no test can
 *   hand it a trusted key; what is asserted is every refusal by its word and that nothing is written on one. The worker
 *   is a fetch handler on a node listener, reached through `MAILWOMAN_LICENSE_URL`.
 */

import { serveNode } from "@mailwoman/api-kit"
import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writePrivateTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	publishedLicenseKeys,
} from "@mailwoman/core/license"
import { workspacePath } from "@mailwoman/core/paths"
import { isProcessError, type ProcessOutput, runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { resolvePath } from "path-ts"
import { describe, expect, test } from "vitest"

const cliBin = workspacePath("mailwoman", "out", "cli.js")

interface CLIRun extends ProcessOutput {
	exitCode: number
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<CLIRun> {
	try {
		const output = await runFile(process.execPath, [cliBin, "license", ...args], {
			env: childEnv({ NODE_NO_WARNINGS: "1", ...env }),
		})

		return { ...output, exitCode: 0 }
	} catch (error: unknown) {
		if (isProcessError(error)) {
			return { stdout: error.stdout, stderr: error.stderr, exitCode: typeof error.code === "number" ? error.code : 1 }
		}

		throw error
	}
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

	const LID = `lic_${"a".repeat(22)}`
	const LAPSED_LID = `lic_${"l".repeat(22)}`
	const SECRET = "s".repeat(43)

	/**
	 * A token the self-service worker would have minted, under a key this build does not trust.
	 */
	async function selfServiceToken() {
		const pair = await generateLicenseSigningKeyPair()
		const kid = await licenseKeyID(pair.publicKeyPEM, 9)

		const token = await encodeLicenseKey(
			{
				v: 1,
				kid,
				licensee: "Example Ltd",
				issued: "2026-10-01",
				expires: "2026-11-15",
				scope: "all",
				terms: "LicenseRef-Commercial",
				lid: LID,
				agreement: "commercial-2026-10",
			},
			pair.privateKeyPEM
		)

		return { kid, token }
	}

	/**
	 * The worker's two customer routes and the well-known register, as a fetch handler: the refresh route answers the
	 * self-service token for the right secret, `lapsed` for one lid, and the worker's 404 otherwise; the status route
	 * answers `revoked`; the register lists no key, so the publication reads `unlisted` without reaching mailwoman.ai.
	 */
	async function stubWorker(token: string) {
		const handler = async (request: Request): Promise<Response> => {
			const path = new URL(request.url).pathname

			if (path === "/.well-known/mailwoman/license-keys.json") return Response.json({ keys: [] })

			if (path === "/v1/license-status") return Response.json({ status: "revoked" })

			if (path === "/v1/licenses/refresh") {
				const { lid, secret } = (await request.json()) as { lid: string; secret: string }

				if (secret !== SECRET) return Response.json({ error: "not found" }, { status: 404 })

				if (lid === LAPSED_LID) return Response.json({ status: "lapsed" })

				return Response.json({ status: "active", token, issued: "2026-10-01", expires: "2026-11-15" })
			}

			return Response.json({ error: "internal error" }, { status: 500 })
		}

		const server = await serveNode({ fetch: handler, port: 0, hostname: "127.0.0.1", onListen: () => {} })

		return {
			url: `http://127.0.0.1:${server.port}`,
			[Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
		}
	}

	test("adopt refuses a token this build does not trust and writes nothing", async () => {
		await using scratch = await temporaryDirectory("license-cli-adopt-")
		const { kid, token } = await selfServiceToken()
		const result = await cli(["adopt", token, "--secret", SECRET], { MAILWOMAN_CONFIG_ROOT: String(scratch.path) })

		expect(result.exitCode).toBe(1)
		expect(result.stderr).toContain(`does not trust key id ${kid}`)
		expect(await pathExists(resolvePath(scratch.path, "license", "key"))).toBe(false)
		expect(await pathExists(resolvePath(scratch.path, "license", "refresh.json"))).toBe(false)
	})

	test("refresh reads the credentials file, asks the worker, and refuses to write a token this build does not trust; lapsed and a wrong secret are reported by word", async () => {
		await using scratch = await temporaryDirectory("license-cli-refresh-")
		const { kid, token } = await selfServiceToken()
		await using worker = await stubWorker(token)
		const env = { MAILWOMAN_CONFIG_ROOT: String(scratch.path), MAILWOMAN_LICENSE_URL: worker.url }

		await writePrivateTextFile(
			JSON.stringify({ lid: LID, secret: SECRET }),
			resolvePath(scratch.path, "license", "refresh.json")
		)

		const untrusted = await cli(["refresh"], env)

		expect(untrusted.exitCode).toBe(1)
		expect(untrusted.stderr).toContain(`does not trust key id ${kid}`)
		expect(await pathExists(resolvePath(scratch.path, "license", "key"))).toBe(false)

		const lapsed = await cli(["refresh", "--lid", LAPSED_LID, "--secret", SECRET, "--json"], env)

		expect(lapsed.exitCode).toBe(1)
		expect(parseJSONStrict(lapsed.stdout)).toEqual({ status: "lapsed" })

		const wrong = await cli(["refresh", "--lid", LID, "--secret", "x".repeat(43)], env)

		expect(wrong.exitCode).toBe(1)
		expect(wrong.stderr).toContain("No license answers")

		const down = await cli(["refresh"], { ...env, MAILWOMAN_LICENSE_URL: "http://127.0.0.1:9" })

		expect(down.exitCode).toBe(2)
		expect(down.stderr).toContain("did not answer")
	})

	test("verify --online reports the per-license status beside the publication, and a revoked license fails the check", async () => {
		const { kid, token } = await selfServiceToken()
		await using worker = await stubWorker(token)
		const env = { MAILWOMAN_LICENSE_URL: worker.url, MAILWOMAN_DOCS_URL: worker.url }
		const result = await cli(["verify", "--key", token, "--online", "--json"], env)

		expect(result.exitCode).toBe(1)

		expect(parseJSONStrict(result.stdout)).toMatchObject({
			status: "unknown_key",
			kid,
			publication: "unlisted",
			lid_status: "revoked",
		})

		const text = await cli(["verify", "--key", token, "--online"], env)

		expect(text.stdout).toContain(`license ${LID}: revoked (${worker.url})`)
	})
})
