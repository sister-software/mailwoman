/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stubTransport } from "@mailwoman/core/api/test-transport"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	type LicenseKeyPayload,
	licenseKeyID,
	readConfiguredLicenseToken,
	readInstallationID,
	readRefreshCredentials,
} from "@mailwoman/core/license"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { declareAction, evaluateAction, spec } from "#cli/native/commands/license"
import { CLIUsageError, parseCommand } from "#cli/native/spec"

const pair = await generateLicenseSigningKeyPair()
const kid = await licenseKeyID(pair.publicKeyPEM, 9)
const trustedKeys = { [kid]: pair.publicKeyPEM }
const LID = `lic_${"a".repeat(22)}`
const SECRET = "s".repeat(43)
const CLAIM = `clm_${"c".repeat(22)}`

async function declaredToken(overrides: Partial<LicenseKeyPayload> = {}): Promise<string> {
	return encodeLicenseKey(
		{
			v: 1,
			kid,
			licensee: "Example Project",
			issued: "2026-10-21",
			expires: "2027-03-11",
			scope: "all",
			terms: "AGPL-3.0-only",
			lid: LID,
			intent: "open-source",
			seq: 1,
			...overrides,
		},
		pair.privateKeyPEM
	)
}

describe("license declare and license evaluate", () => {
	let scratch: Awaited<ReturnType<typeof temporaryDirectory>>
	let stdout: string[]
	let stderr: string[]

	beforeEach(async () => {
		scratch = await temporaryDirectory("license-declare-")
		vi.stubEnv("MAILWOMAN_CONFIG_ROOT", scratch.path.toString())
		vi.stubEnv("MAILWOMAN_LICENSE_KEY", "")
		stdout = []
		stderr = []

		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdout.push(String(chunk))

			return true
		})

		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr.push(String(chunk))

			return true
		})
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await scratch[Symbol.asyncDispose]()
	})

	it("declare --intent open-source adopts the answered token and secret and mints the installation id", async () => {
		const token = await declaredToken()

		const transport = stubTransport([
			{ body: { status: "issued", token, lid: LID, secret: SECRET, issued: "2026-10-21", expires: "2027-03-11" } },
		])

		const parsed = parseCommand(spec, [
			"declare",
			"--intent",
			"open-source",
			"--name",
			"Example Project",
			"--project",
			"https://github.com/example/project",
		])

		expect(await declareAction(parsed, { client: { axios: transport.axios }, trustedKeys })).toBe(0)
		expect(transport.calls).toEqual(["/v1/declarations"])
		expect(await readConfiguredLicenseToken()).toEqual({ token, source: "file" })
		expect(await readRefreshCredentials()).toEqual({ lid: LID, secret: SECRET })
		expect(await readInstallationID()).toMatch(/^[0-9a-f-]{36}$/u)
		expect(stdout.join("")).toContain("expires:          2027-03-11")
	})

	it("declare --intent academic needs --email and --organization", async () => {
		const parsed = parseCommand(spec, ["declare", "--intent", "academic", "--name", "Dr Example"])

		await expect(declareAction(parsed, { trustedKeys })).rejects.toThrow(CLIUsageError)
		await expect(declareAction(parsed, { trustedKeys })).rejects.toThrow(/--email/u)
	})

	it("evaluate polls the claim until the token arrives and adopts it with the secret", async () => {
		const token = await declaredToken({ intent: "evaluation", licensee: "Trial Ltd", expires: "2026-11-20" })

		const transport = stubTransport([
			{ body: { status: "pending", claim: CLAIM } },
			{ body: { status: "pending" } },
			{
				body: {
					status: "issued",
					token,
					lid: LID,
					licensee: "Trial Ltd",
					issued: "2026-10-21",
					expires: "2026-11-20",
					refresh_secret: SECRET,
				},
			},
		])

		const parsed = parseCommand(spec, ["evaluate", "--email", "trial@example.com", "--name", "Trial Ltd"])

		expect(await evaluateAction(parsed, { client: { axios: transport.axios }, trustedKeys, pollIntervalMs: 0 })).toBe(0)

		expect(transport.calls).toEqual(["/v1/evaluations", `/v1/declarations/${CLAIM}`, `/v1/declarations/${CLAIM}`])
		expect(await readConfiguredLicenseToken()).toEqual({ token, source: "file" })
		expect(await readRefreshCredentials()).toEqual({ lid: LID, secret: SECRET })
		expect(stdout.join("")).toContain("trial@example.com")
	})

	it("evaluate for an address that has received its evaluation is refused with the license page", async () => {
		const transport = stubTransport([{ status: 409, body: { error: "evaluation exists" } }])
		const parsed = parseCommand(spec, ["evaluate", "--email", "trial@example.com", "--name", "Trial Ltd"])

		await expect(evaluateAction(parsed, { client: { axios: transport.axios }, trustedKeys })).rejects.toThrow(
			/already received its evaluation.*mailwoman\.ai\/license/u
		)
	})

	it("an unreachable worker exits 2 and says so on stderr", async () => {
		const transport = stubTransport([{ throws: { message: "connect ECONNREFUSED", code: "ERR_NETWORK" } }])

		const parsed = parseCommand(spec, [
			"declare",
			"--intent",
			"open-source",
			"--name",
			"Example Project",
			"--project",
			"https://github.com/example/project",
		])

		expect(await declareAction(parsed, { client: { axios: transport.axios }, trustedKeys })).toBe(2)
		expect(stderr.join("")).toContain("did not answer")
	})
})
