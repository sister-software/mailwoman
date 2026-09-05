# License Site and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a customer the two ends of the worker that merged in #2160: the docs site's Buy section and `/license/issued` claim page, and the CLI's `license adopt` and `license refresh` over a config-root key file, with the per-license status beside the key-id publication in `verify --online` and the doctor.

**Architecture:** Core gains two small modules beside the ones the worker already made: `license/key-file.ts` (the config-root key and refresh-credential files, read by `verifyConfiguredLicenseKey` after the environment variable) and `license/status.ts` (the HTTP client for the worker's refresh and status routes, on `APIClient`, outside the barrel like `publication.ts`). The CLI's `license` command grows two actions over them; the doctor's runtime license check reports the lid status as a fifth word beside the publication. The docs site gets a constants module for the shop's URLs, a Buy section on `/license`, and a `/license/issued` page whose polling is a pure reducer with a unit test, rendered through `BrowserOnly`.

**Tech Stack:** `@mailwoman/core` (`APIClient`, `fs/readers`, `fs/writers`, `data-root`), the native CLI spec in `packages/mailwoman/lib/cli-native/`, the doctor registry in `packages/mailwoman/lib/doctor/`, Docusaurus 3 pages in `docs/src/pages/`, `useClipboard` from `@mailwoman/react`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`, sections "The docs site", "The CLI", "Refunds, disputes, lapses", "Acceptance". The worker's routes are in `packages/license-worker/lib/routes/` and its README.

## Global Constraints

- The key-file read joins the CLI launcher's path: `packages/mailwoman/test/unit/module-count.test.ts` pins `mailwoman --version` at or under 200 modules (132 today). `fs/readers` and `data-root` are already on that path through the manifest read; nothing new may join it.
- The HTTP client lives OUTSIDE the `@mailwoman/core/license` barrel, as `publication.ts` does, so the launcher never loads it.
- HTTP goes through `APIClient` (`@mailwoman/core/api`), never raw `fetch`, with a bounded timeout and `silentLogger()` so stdout stays a document.
- A secret file is created `0600` through `writePrivateTextFile`; the key file is not a secret and uses `writeLocalTextFile`.
- The CLI never writes a token this build does not trust: `refresh` and `adopt` verify offline against `trustedLicenseSigningKeys()` first and refuse `unknown_key` with the remedy (upgrade mailwoman).
- Public status words are the worker's: `active`, `lapsed`, `revoked`, `unknown`; the client adds `unreachable`. No reason, name or date travels with them.
- Site: exact-origin CORS on the worker admits `https://mailwoman.ai`, so the claim call is a plain `fetch` from the page; the page never stores the token or the secret anywhere but the DOM.
- The Payment Link, portal and terms URLs are operator-owned (spec issue A). They live in ONE constants module and start `undefined`; the Buy section renders only when both Payment Links are set, so the live page never shows a dead button.
- `docs/src/pages/license/terms/<version>.mdx` is issue A's deliverable (legal text). This plan creates no terms page.
- Prose follows `docs/.vale-vocab.ini` (README, plan) and the site's `.vale.ini` (pages); acronyms cap as whole components; snake_case wire keys stay.
- Tests sit under `test/unit/` or `test/integration/` and import helpers by the package contract, never relatively (`test-contract` health check); every exported name is imported somewhere (`exports` check); no `as never`, no `as unknown as` (`debt` counters).
- Every commit ends with `Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg`.

---

### Task 0: The config-root key file and refresh credentials

**Files:**

- Create: `packages/core/lib/license/key-file.ts`
- Modify: `packages/core/lib/license/configured.ts`, `packages/core/lib/license/index.ts` (export the new module), `packages/core/lib/env/schema.ts` (add `MAILWOMAN_LICENSE_URL`)
- Test: `packages/core/test/unit/license/key-file.test.ts`

**Interfaces produced:**

```ts
// @mailwoman/core/license (barrel) and #license/key-file
export const LICENSE_KEY_FILE = "key"
export const LICENSE_REFRESH_FILE = "refresh.json"
export function licenseKeyFilePath(): string // $MAILWOMAN_CONFIG_ROOT/license/key
export function licenseRefreshFilePath(): string // $MAILWOMAN_CONFIG_ROOT/license/refresh.json
export interface ConfiguredLicenseToken {
	token: string
	source: "environment" | "file"
}
export function readConfiguredLicenseToken(): Promise<ConfiguredLicenseToken | undefined>
export function writeLicenseKeyFile(token: string): Promise<string> // answers the path
export interface RefreshCredentials {
	lid: string
	secret: string
}
export function readRefreshCredentials(): Promise<RefreshCredentials | undefined>
export function writeRefreshCredentials(credentials: RefreshCredentials): Promise<string> // 0600, answers the path
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/license/key-file.test.ts
import { configRootPath } from "@mailwoman/core/data-root"
import { statPath } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	readConfiguredLicenseToken,
	readRefreshCredentials,
	writeLicenseKeyFile,
	writeRefreshCredentials,
} from "@mailwoman/core/license"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The config root and the environment variable are read through `$public`; the test points both at a scratch directory.
describe("the config-root license files", () => {
	let scratch: Awaited<ReturnType<typeof temporaryDirectory>>

	beforeEach(async () => {
		scratch = await temporaryDirectory("license-key-file-")
		vi.stubEnv("MAILWOMAN_CONFIG_ROOT", String(scratch.path))
		vi.stubEnv("MAILWOMAN_LICENSE_KEY", "")
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await scratch[Symbol.asyncDispose]()
	})

	it("answers nothing when neither the variable nor the file is set", async () => {
		expect(await readConfiguredLicenseToken()).toBeUndefined()
	})

	it("reads the file when the variable is unset, and the variable first when both are set", async () => {
		const path = await writeLicenseKeyFile("mwl1.file.token\n")

		expect(path).toBe(String(configRootPath("license", "key")))
		expect(await readConfiguredLicenseToken()).toEqual({ token: "mwl1.file.token", source: "file" })

		vi.stubEnv("MAILWOMAN_LICENSE_KEY", "mwl1.env.token")

		expect(await readConfiguredLicenseToken()).toEqual({ token: "mwl1.env.token", source: "environment" })
	})

	it("writes the refresh credentials mode 0600 and reads them back; a missing file answers nothing", async () => {
		expect(await readRefreshCredentials()).toBeUndefined()

		const path = await writeRefreshCredentials({ lid: "lic_x", secret: "s".repeat(43) })
		const stats = await statPath(path)

		expect(stats.mode & 0o777).toBe(0o600)
		expect(await readRefreshCredentials()).toEqual({ lid: "lic_x", secret: "s".repeat(43) })
	})
})
```

Check how `$public` reads the environment before relying on `vi.stubEnv`: `packages/core/lib/env/index.ts`. If `$public` is parsed once at import, read the variable through a getter the test can control (`readPublicEnv()`), or accept an `env` parameter with a default; the existing `verifyConfiguredLicenseKey` reads `$public.MAILWOMAN_LICENSE_KEY` and its test in `packages/core/test/unit/license/` shows the pattern the suite already uses. Follow that pattern.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run packages/core/test/unit/license/key-file.test.ts`. Expected: FAIL, `readConfiguredLicenseToken` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/core/lib/license/key-file.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two files under `$MAILWOMAN_CONFIG_ROOT/license/` a self-service license leaves on a machine: the key, which
 *   `verifyConfiguredLicenseKey` reads after `MAILWOMAN_LICENSE_KEY`, so a refreshed token applies without an
 *   environment change; and the refresh credentials, the lid and per-license secret `mailwoman license refresh`
 *   presents, created 0600 because the secret is what fetches the current token. The key is a signed assertion, not a
 *   secret, and is written with the ordinary writer.
 */

import { configRootPath } from "#data-root"
import { $public } from "#env"
import { pathExists, readLocalJSONFile, readLocalTextFile } from "#fs/readers"
import { writeLocalTextFile, writePrivateTextFile } from "#fs/writers"

export const LICENSE_KEY_FILE = "key"
export const LICENSE_REFRESH_FILE = "refresh.json"

export function licenseKeyFilePath(): string {
	return String(configRootPath("license", LICENSE_KEY_FILE))
}

export function licenseRefreshFilePath(): string {
	return String(configRootPath("license", LICENSE_REFRESH_FILE))
}

export interface ConfiguredLicenseToken {
	token: string
	source: "environment" | "file"
}

/**
 * The token this installation has configured: the environment variable first, the key file second. `undefined` when
 * neither is set. A blank file reads as absent.
 */
export async function readConfiguredLicenseToken(): Promise<ConfiguredLicenseToken | undefined> {
	const fromEnvironment = $public.MAILWOMAN_LICENSE_KEY

	if (fromEnvironment) return { token: fromEnvironment, source: "environment" }

	const path = licenseKeyFilePath()

	if (!(await pathExists(path))) return undefined

	const token = (await readLocalTextFile(path)).trim()

	return token ? { token, source: "file" } : undefined
}

export async function writeLicenseKeyFile(token: string): Promise<string> {
	const path = licenseKeyFilePath()

	await writeLocalTextFile(`${token.trim()}\n`, path)

	return path
}

export interface RefreshCredentials {
	lid: string
	secret: string
}

export async function readRefreshCredentials(): Promise<RefreshCredentials | undefined> {
	const path = licenseRefreshFilePath()

	if (!(await pathExists(path))) return undefined

	const parsed = await readLocalJSONFile<Partial<RefreshCredentials>>(path)

	if (typeof parsed.lid !== "string" || typeof parsed.secret !== "string") {
		throw new Error(`${path} does not carry a lid and a secret; run \`mailwoman license adopt\` again`)
	}

	return { lid: parsed.lid, secret: parsed.secret }
}

export async function writeRefreshCredentials(credentials: RefreshCredentials): Promise<string> {
	const path = licenseRefreshFilePath()

	await writePrivateTextFile(`${JSON.stringify(credentials, null, "\t")}\n`, path)

	return path
}
```

`configured.ts` becomes:

```ts
import { verifyLicenseKey, type LicenseKeyVerification } from "#license/key"
import { readConfiguredLicenseToken } from "#license/key-file"
import { trustedLicenseSigningKeys } from "#license/register"

/**
 * Verify the configured key offline — `MAILWOMAN_LICENSE_KEY` first, the config-root key file second — or `undefined`
 * when neither is set.
 */
export async function verifyConfiguredLicenseKey(now?: Date): Promise<LicenseKeyVerification | undefined> {
	const configured = await readConfiguredLicenseToken()

	if (!configured) return undefined

	return await verifyLicenseKey(configured.token, { trustedKeys: trustedLicenseSigningKeys(), ...(now ? { now } : {}) })
}
```

Update its header comment: the file is why a refreshed key applies without an environment change. Add `export * from "#license/key-file"` to `packages/core/lib/license/index.ts`. Add to `packages/core/lib/env/schema.ts` beside `MAILWOMAN_DOCS_URL`:

```ts
	/**
	 * The license worker's origin (`https://license.mailwoman.ai`), for `mailwoman license refresh` and the online lid
	 * status. Overridden in tests and against a sandbox deploy.
	 */
	MAILWOMAN_LICENSE_URL: z.string().optional(),
```

- [ ] **Step 4: Run the tests, the module-count pin, and the launcher path**

Run: `yarn vitest run packages/core/test/unit/license`. Expected: PASS.
Run: `yarn compile && yarn vitest run packages/mailwoman/test/unit/module-count.test.ts`. Expected: PASS; note the count it prints in the commit message. If it rose, the new import pulled something onto the launcher path: `fs/readers` and `data-root` were already there through `readMailwomanManifest`, so a rise means a different module joined; find it with `node --trace-... ` as that test's header describes.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): the config-root license key file and refresh credentials, read after the environment variable

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 1: The worker client — refresh and status

**Files:**

- Create: `packages/core/lib/license/status.ts`
- Modify: `packages/core/package.json` (export `./license/status`, `node`/`default`/`types` conditions like `./license/publication`)
- Test: `packages/core/test/unit/license/status.test.ts`

**Interfaces produced:**

```ts
// @mailwoman/core/license/status
export const DEFAULT_LICENSE_URL = "https://license.mailwoman.ai"
export function licenseWorkerURL(override?: string): string // no trailing slash
export type LicenseStatusAnswer = "active" | "lapsed" | "revoked" | "unknown" | "unreachable"
export function checkLicenseStatus(
	lid: string,
	options?: { timeoutMs?: number; url?: string }
): Promise<LicenseStatusAnswer>
export type RefreshAnswer =
	| { status: "active"; token: string; issued: string; expires: string }
	| { status: "pending" | "lapsed" | "revoked" }
	| { status: "not_found" }
	| { status: "unreachable"; reason: string }
export function refreshLicenseKey(
	credentials: { lid: string; secret: string },
	options?: { timeoutMs?: number; url?: string }
): Promise<RefreshAnswer>
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/license/status.test.ts
import { checkLicenseStatus, licenseWorkerURL, refreshLicenseKey } from "@mailwoman/core/license/status"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// core's own tests may reach node:http; the client under test must not, and this file is the one place a stub worker
// is cheaper than a Hono app. Routes mirror packages/license-worker/lib/routes/{refresh,status}.ts.
let server: Server
let url: string

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = ""

		request.on("data", (chunk: Buffer) => {
			body += chunk.toString()
		})

		request.on("end", () => {
			const json = (status: number, payload: unknown) => {
				response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
				response.end(JSON.stringify(payload))
			}
			const parsed = body ? (JSON.parse(body) as { lid?: string; secret?: string }) : {}

			if (request.url === "/v1/license-status") {
				return json(200, { status: parsed.lid === "lic_active0000000000000000" ? "active" : "unknown" })
			}

			if (request.url === "/v1/licenses/refresh") {
				if (parsed.lid === "lic_active0000000000000000" && parsed.secret === "s".repeat(43)) {
					return json(200, { status: "active", token: "mwl1.a.b", issued: "2026-10-01", expires: "2026-11-15" })
				}

				if (parsed.lid === "lic_lapsed0000000000000000") return json(200, { status: "lapsed" })

				return json(404, { error: "not found" })
			}

			return json(500, { error: "internal error" })
		})
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

	const address = server.address()

	if (!address || typeof address === "string") throw new Error("no port")

	url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

describe("the license worker client", () => {
	it("derives the worker origin with no trailing slash", () => {
		expect(licenseWorkerURL("https://license.example/")).toBe("https://license.example")
		expect(licenseWorkerURL(undefined)).toBe("https://license.mailwoman.ai")
	})

	it("status answers the worker's word, and unreachable for a host that does not answer", async () => {
		expect(await checkLicenseStatus("lic_active0000000000000000", { url })).toBe("active")
		expect(await checkLicenseStatus("lic_nobody0000000000000000", { url })).toBe("unknown")
		expect(await checkLicenseStatus("lic_active0000000000000000", { url: "http://127.0.0.1:9", timeoutMs: 500 })).toBe(
			"unreachable"
		)
	})

	it("refresh answers the token for the right secret, the state that withholds one, not_found for a wrong secret", async () => {
		expect(await refreshLicenseKey({ lid: "lic_active0000000000000000", secret: "s".repeat(43) }, { url })).toEqual({
			status: "active",
			token: "mwl1.a.b",
			issued: "2026-10-01",
			expires: "2026-11-15",
		})
		expect(await refreshLicenseKey({ lid: "lic_lapsed0000000000000000", secret: "s".repeat(43) }, { url })).toEqual({
			status: "lapsed",
		})
		expect(await refreshLicenseKey({ lid: "lic_active0000000000000000", secret: "x".repeat(43) }, { url })).toEqual({
			status: "not_found",
		})
	})
})
```

`JSON.parse` is refused by lint outside core; this file is inside core, and the stub is a test double — if the rule still fires, use `tryParsingJSON` from `@mailwoman/core/json`.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run packages/core/test/unit/license/status.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/core/lib/license/status.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client for the license worker's two customer routes: the per-license status a lid answers, and the refresh that
 *   trades a lid and its secret for the current token. Kept outside the `license` barrel like `publication.ts`, because
 *   it carries the HTTP client and the barrel sits on the CLI launcher's path. `unreachable` is a network answer, not a
 *   verdict: offline verification stands, and every caller says so.
 */

import { APIClient } from "#api/APIClient"
import { $public } from "#env"
import { silentLogger } from "#logging/index"

export const DEFAULT_LICENSE_URL = "https://license.mailwoman.ai"

export function licenseWorkerURL(override: string | undefined = $public.MAILWOMAN_LICENSE_URL): string {
	return (override ?? DEFAULT_LICENSE_URL).replace(/\/+$/u, "")
}

export type LicenseStatusAnswer = "active" | "lapsed" | "revoked" | "unknown" | "unreachable"

export type RefreshAnswer =
	| { status: "active"; token: string; issued: string; expires: string }
	| { status: "pending" | "lapsed" | "revoked" }
	| { status: "not_found" }
	| { status: "unreachable"; reason: string }

interface ClientOptions {
	timeoutMs?: number
	url?: string
}

const DEFAULT_TIMEOUT_MS = 5000

function client(options: ClientOptions): APIClient {
	return new APIClient({
		displayName: "license-worker",
		logger: silentLogger(),
		axios: {
			baseURL: licenseWorkerURL(options.url),
			headers: { accept: "application/json", "content-type": "application/json" },
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		},
	})
}

const STATUS_WORDS: ReadonlySet<string> = new Set(["active", "lapsed", "revoked", "unknown"])

export async function checkLicenseStatus(lid: string, options: ClientOptions = {}): Promise<LicenseStatusAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<{ status: string }>({
			url: "/v1/license-status",
			method: "POST",
			data: { lid },
			cache: false,
		})

		return STATUS_WORDS.has(response.data.status) ? (response.data.status as LicenseStatusAnswer) : "unknown"
	} catch {
		return "unreachable"
	}
}

export async function refreshLicenseKey(
	credentials: { lid: string; secret: string },
	options: ClientOptions = {}
): Promise<RefreshAnswer> {
	await using api = client(options)

	try {
		const response = await api.fetch<RefreshAnswer>({
			url: "/v1/licenses/refresh",
			method: "POST",
			data: credentials,
			cache: false,
		})

		return response.data
	} catch (error) {
		if (isResourceError(error) && error.status === 404) return { status: "not_found" }

		return { status: "unreachable", reason: error instanceof Error ? error.message : String(error) }
	}
}
```

Read `packages/core/lib/api/APIClient.ts` for the exact request-options shape (`fetch<T>(options)`; `method`, `data`, `cache: false` are what `bdc/lib/sdk/client.ts` uses), the error class (`ResourceError`, `isResourceError` or the `status` field name), and whether `POST` needs `data` or `body`. Match what exists; the cast on `status` is a narrowing of a validated set member, not an `as unknown as`. Register the subpath in `packages/core/package.json` next to `./license/publication` with the same three conditions.

- [ ] **Step 4: Run and commit**

Run: `yarn vitest run packages/core/test/unit/license/status.test.ts`. Expected: PASS.
Run: `yarn mwops health manifest-targets`. Expected: PASS.

```bash
git add packages/core
git commit -m "feat(core): the license worker client — per-license status and the refresh that trades a lid and secret for the current token

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 2: `mailwoman license adopt` and `mailwoman license refresh`; `verify --online` reports the lid

**Files:**

- Modify: `packages/mailwoman/lib/cli-native/commands/license.ts`
- Test: `packages/mailwoman/test/integration/license-cli.test.ts` (extend)

**Interfaces consumed:** Task 0's key-file functions from `@mailwoman/core/license`; Task 1's `refreshLicenseKey`, `checkLicenseStatus`, `licenseWorkerURL` from `@mailwoman/core/license/status`; `isSelfServicePayload` from `@mailwoman/core/license`.

Behaviour:

- `license adopt <token> [--secret <s>]`: positional `token` (second positional after the action; add a second optional positional `argument` to the spec, described as "adopt: the token"). Verify offline. `valid` → write the key file; with `--secret`, the payload must carry `lid` (refuse otherwise: "this token was not issued by the self-service worker, so it has no refresh secret") and the credentials file is written 0600. `expired` → refuse with the expiry date; `unknown_key` → refuse: "this release does not trust key id <kid>; upgrade mailwoman to a release that lists it, then adopt again"; `invalid` → refuse with the reason. Print the paths written and `mailwoman license verify --online` as the next command. `--json` prints `{ keyPath, refreshPath?, payload }`.
- `license refresh [--lid <lid> --secret <s>]`: credentials from the flags, else `readRefreshCredentials()`, else a usage error naming `adopt`. Call `refreshLicenseKey`. `active` → verify the token offline; `valid` → write the key file and print `status: active`, `expires`, the path; `unknown_key` → do NOT write, print the remedy, exit 1. `pending` → "the first payment has not been recorded yet; the email will carry the key" exit 1. `lapsed`/`revoked` → print the word, exit 1, key file untouched. `not_found` → "no license answers to this lid and secret" exit 1. `unreachable` → print it with the URL, exit 2. `--json` prints the answer plus `keyPath` when written.
- `license verify --online`: when the payload carries `lid`, also `checkLicenseStatus(lid)` and print `license.mailwoman.ai: <word>` beside the publication line; the exit code adds `revoked` and `lapsed` as failures. JSON gains `lid_status`.
- Every message that names a URL uses `licenseWorkerURL()`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/mailwoman/test/integration/license-cli.test.ts`. The stub worker is a Hono app served through `@mailwoman/api-kit`'s `serveNode` on port 0, with `MAILWOMAN_LICENSE_URL` handed to the CLI child. The signing pair is generated in the test and injected into the register the CLI reads by... it cannot be: the compiled CLI ships its register. So the trusted case uses a token the build trusts — none exists in a test — and the tests assert the REFUSALS precisely and the file writes through `adopt` of a token whose verification the CLI reports; use `--json` output for the payload echo. Concretely:

```ts
import { Hono } from "hono"
import { serveNode } from "@mailwoman/api-kit/serve"

// ... inside describe("mailwoman license")

test("adopt refuses a token this build does not trust and writes nothing", async () => {
	await using scratch = await temporaryDirectory("license-cli-adopt-")
	const pair = await generateLicenseSigningKeyPair()
	const kid = await licenseKeyID(pair.publicKeyPEM, 9)
	const token = await encodeLicenseKey(
		{
			v: 1,
			kid,
			licensee: "Example Ltd",
			issued: "2026-10-01",
			scope: "all",
			terms: "LicenseRef-Commercial",
			lid: "lic_" + "a".repeat(22),
			agreement: "commercial-2026-10",
		},
		pair.privateKeyPEM
	)
	const result = await cli(["adopt", token, "--secret", "s".repeat(43)], {
		MAILWOMAN_CONFIG_ROOT: String(scratch.path),
	})

	expect(result.exitCode).toBe(1)
	expect(result.stderr).toContain(`does not trust key id ${kid}`)
	expect(await pathExists(resolvePath(scratch.path, "license", "key"))).toBe(false)
	expect(await pathExists(resolvePath(scratch.path, "license", "refresh.json"))).toBe(false)
})

test("refresh reads the credentials file, asks the worker, and refuses to write a token this build does not trust; lapsed and not_found are reported by word", async () => {
	await using scratch = await temporaryDirectory("license-cli-refresh-")
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
			lid: "lic_" + "a".repeat(22),
			agreement: "commercial-2026-10",
		},
		pair.privateKeyPEM
	)
	const worker = new Hono()

	worker.post("/v1/licenses/refresh", async (c) => {
		const { lid, secret } = await c.req.json<{ lid: string; secret: string }>()

		if (secret !== "s".repeat(43)) return c.json({ error: "not found" }, 404)
		if (lid === "lic_" + "l".repeat(22)) return c.json({ status: "lapsed" })

		return c.json({ status: "active", token, issued: "2026-10-01", expires: "2026-11-15" })
	})

	await using server = await serveNode({ fetch: worker.fetch, port: 0, hostname: "127.0.0.1", onListen: () => {} })
	const env = { MAILWOMAN_CONFIG_ROOT: String(scratch.path), MAILWOMAN_LICENSE_URL: `http://127.0.0.1:${server.port}` }

	await writePrivateTextFile(
		JSON.stringify({ lid: "lic_" + "a".repeat(22), secret: "s".repeat(43) }),
		resolvePath(scratch.path, "license", "refresh.json")
	)

	const untrusted = await cli(["refresh"], env)

	expect(untrusted.exitCode).toBe(1)
	expect(untrusted.stderr).toContain(`does not trust key id ${kid}`)
	expect(await pathExists(resolvePath(scratch.path, "license", "key"))).toBe(false)

	const lapsed = await cli(["refresh", "--lid", "lic_" + "l".repeat(22), "--secret", "s".repeat(43), "--json"], env)

	expect(parseJSONStrict(lapsed.stdout)).toEqual({ status: "lapsed" })

	const wrong = await cli(["refresh", "--lid", "lic_" + "a".repeat(22), "--secret", "x".repeat(43)], env)

	expect(wrong.exitCode).toBe(1)
	expect(wrong.stderr).toContain("no license answers")
})

test("verify --online reports the lid status beside the publication", async () => {
	// Token as above with a lid; the stub worker answers /v1/license-status with { status: "revoked" }.
	// Expect stdout to contain "license.mailwoman.ai: revoked" is wrong — the line names the configured URL — so expect
	// `${env.MAILWOMAN_LICENSE_URL}: revoked` and exit code 1.
})
```

Write the third test in full following the second's shape (the stub gains `worker.post("/v1/license-status", (c) => c.json({ status: "revoked" }))`; the CLI is invoked with `["verify", "--key", token, "--online", "--json"]`; assert `lid_status: "revoked"` in the JSON and exit code 1). The `--online` publication check hits the real mailwoman.ai unless `MAILWOMAN_DOCS_URL` points at the stub; set `MAILWOMAN_DOCS_URL` to the stub too and serve `/.well-known/mailwoman/license-keys.json` with `{ keys: [] }` so the publication reads `unlisted` deterministically.

Add `pathExists` (`@mailwoman/core/fs/readers`), `writePrivateTextFile` (`@mailwoman/core/fs/writers`), `resolvePath` (`path-ts`) to the test's imports. `hono` is already a dependency of `mailwoman`; `@mailwoman/api-kit` too — confirm in `packages/mailwoman/package.json` before importing, and add to `devDependencies` only if absent.

- [ ] **Step 2: Run to verify they fail**

Run: `yarn compile && yarn vitest run packages/mailwoman/test/integration/license-cli.test.ts`. Expected: the new tests FAIL with "Unknown action".

- [ ] **Step 3: Implement**

In `license.ts`: extend `spec.description` and `positionals` (`action` required; `argument` optional, "adopt: the token to adopt"); add options `lid` (string, "refresh: the license id, when not reading $MAILWOMAN_CONFIG_ROOT/license/refresh.json") and `secret` (string, "adopt: the refresh secret from the purchase page or the first email; refresh: the secret, when not reading the credentials file"). Add:

```ts
import {
	isSelfServicePayload,
	readRefreshCredentials,
	writeLicenseKeyFile,
	writeRefreshCredentials,
} from "@mailwoman/core/license"
import { checkLicenseStatus, licenseWorkerURL, refreshLicenseKey } from "@mailwoman/core/license/status"

/**
 * Why a token may not be written: this build cannot verify it, so writing it would configure a key the runtime reads
 * as unknown on every invocation.
 */
function refusalFor(verification: LicenseKeyVerification): string | undefined {
	switch (verification.status) {
		case "valid":
			return undefined
		case "expired":
			return `this token expired on ${verification.payload.expires}; refresh it or buy again.`
		case "unknown_key":
			return `this release does not trust key id ${verification.kid}; upgrade mailwoman to a release that lists it, then try again.`
		default:
			return verification.reason
	}
}

async function adopt(parsed: ParsedCommand): Promise<number> {
	const token = parsed.positionals[1]

	if (!token) throw new CLIUsageError("adopt needs the token: mailwoman license adopt <token> [--secret <secret>].")

	const verification = await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })
	const refusal = refusalFor(verification)

	if (refusal || verification.status !== "valid") throw new CLIError(`Not adopted: ${refusal ?? verification.status}`)

	const secret = stringValue(parsed.values, "secret")
	const lid = isSelfServicePayload(verification.payload) ? verification.payload.lid : undefined

	if (secret && !lid) {
		throw new CLIError(
			"Not adopted: this token carries no license id, so it has no refresh secret; adopt it without --secret."
		)
	}

	const keyPath = await writeLicenseKeyFile(token)
	const refreshPath = secret && lid ? await writeRefreshCredentials({ lid, secret }) : undefined

	if (booleanValue(parsed.values, "json")) {
		process.stdout.write(
			`${JSON.stringify({ keyPath, ...(refreshPath ? { refreshPath } : {}), payload: verification.payload }, null, 2)}\n`
		)
	} else {
		process.stdout.write(
			[
				`key written:      ${keyPath}`,
				...(refreshPath ? [`refresh secret:   ${refreshPath} (mode 0600)`] : []),
				`licensee:         ${verification.payload.licensee}`,
				`expires:          ${verification.payload.expires ?? "never"}`,
				"",
				"Check it: mailwoman license verify --online",
				"",
			].join("\n")
		)
	}

	return 0
}

async function refresh(parsed: ParsedCommand): Promise<number> {
	const lid = stringValue(parsed.values, "lid")
	const secret = stringValue(parsed.values, "secret")
	const credentials = lid && secret ? { lid, secret } : await readRefreshCredentials()

	if (!credentials) {
		throw new CLIUsageError(
			"refresh needs the license id and secret: pass --lid and --secret, or run `mailwoman license adopt <token> --secret <secret>` once."
		)
	}

	const answer = await refreshLicenseKey(credentials)
	const json = booleanValue(parsed.values, "json")

	if (answer.status === "active") {
		const verification = await verifyLicenseKey(answer.token, { trustedKeys: trustedLicenseSigningKeys() })
		const refusal = refusalFor(verification)

		if (refusal) throw new CLIError(`Not written: ${refusal}`)

		const keyPath = await writeLicenseKeyFile(answer.token)

		process.stdout.write(
			json
				? `${JSON.stringify({ ...answer, keyPath }, null, 2)}\n`
				: `status: active\nexpires: ${answer.expires}\nkey written: ${keyPath}\n`
		)

		return 0
	}

	if (json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)

	switch (answer.status) {
		case "pending":
			throw new CLIError(
				"The first payment has not been recorded yet; the key arrives by email, or run refresh again shortly."
			)
		case "not_found":
			throw new CLIError("No license answers to this lid and secret.")
		case "unreachable":
			throw new CLIError(
				`${licenseWorkerURL()} did not answer: ${answer.reason}. The configured key, if any, stands.`,
				2
			)
		default:
			throw new CLIError(
				`This license is ${answer.status}; no key is issued for it. Manage billing at ${docsSiteURL()}/license.`
			)
	}
}
```

Read `#cli-native/spec` for `CLIError`'s exit-code parameter (add one if it has none: `unreachable` exits 2, every refusal 1). Route `adopt` and `refresh` in `run`'s switch; the usage error's list gains both. In `verifyCommand`, after the publication:

```ts
const lid =
	"payload" in verification && isSelfServicePayload(verification.payload) ? verification.payload.lid : undefined
const lidStatus = booleanValue(parsed.values, "online") && lid ? await checkLicenseStatus(lid) : undefined
const ok =
	verification.status === "valid" &&
	publication !== "retired" &&
	publication !== "unlisted" &&
	lidStatus !== "revoked" &&
	lidStatus !== "lapsed"
```

JSON gains `...(lidStatus ? { lid_status: lidStatus } : {})`; the text gains `${licenseWorkerURL()}: ${lidStatus}` after the publication line. `docsSiteURL` comes from `@mailwoman/core/license`.

- [ ] **Step 4: Run, regenerate the reference, commit**

Run: `yarn compile && yarn vitest run packages/mailwoman/test/integration/license-cli.test.ts`. Expected: PASS.
The pre-commit hook regenerates `docs/articles/developers/reference/cli.mdx` and `packages/mailwoman/man/mailwoman.1` from the spec; stage both when it does.

```bash
git add packages/mailwoman docs/articles/developers/reference/cli.mdx
git commit -m "feat(cli): mailwoman license adopt and refresh over the config-root key file; verify --online reports the per-license status

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 3: The doctor reports the lid status

**Files:**

- Modify: `packages/mailwoman/lib/doctor/checks.ts` (`RuntimeLicenseObservation.lidStatus`, `LicensePosture.lid`/`lidStatus`, detail text), `packages/mailwoman/lib/doctor/runner.ts` (dependency `checkLicenseStatus`, gathered when the payload carries `lid`)
- Test: `packages/mailwoman/test/unit/doctor/runner.test.ts` (extend the valid-key case), `packages/mailwoman/test/unit/doctor/checks.test.ts`

- [ ] **Step 1: Write the failing test**

In `checks.test.ts`, beside the existing `runtimeLicenseCheck` cases:

```ts
it("a self-service key reports the lid status as its own word; revoked and lapsed degrade the check, unknown and unreachable do not", () => {
	const valid = {
		status: "valid" as const,
		kid: "v9-ecec29be",
		payload: {
			v: 1 as const,
			kid: "v9-ecec29be",
			licensee: "Example Ltd",
			issued: "2026-10-01",
			expires: "2026-11-15",
			scope: "all" as const,
			terms: "LicenseRef-Commercial" as const,
			lid: `lic_${"a".repeat(22)}`,
			agreement: "commercial-2026-10",
		},
	}
	const expression = "AGPL-3.0-only OR LicenseRef-Commercial"

	const active = runtimeLicenseCheck({ expression, key: valid, publication: "listed", lidStatus: "active" })

	expect(active.status).toBe(CheckStatus.OK)
	expect(active.detail).toContain("license active")
	expect(active.license).toMatchObject({ lid: valid.payload.lid, lidStatus: "active" })

	const revoked = runtimeLicenseCheck({ expression, key: valid, publication: "listed", lidStatus: "revoked" })

	expect(revoked.status).toBe(CheckStatus.Degraded)
	expect(revoked.detail).toContain("revoked")
	expect(revoked.consequence).toContain("offline")

	const unreachable = runtimeLicenseCheck({
		expression,
		key: valid,
		publication: "unreachable",
		lidStatus: "unreachable",
	})

	expect(unreachable.status).toBe(CheckStatus.OK)
	expect(unreachable.detail).toContain("license status unreachable")
})
```

In `runner.test.ts`'s valid-key case, add `checkLicenseStatus: async () => "active"` to the injected dependencies and assert `check.license.lidStatus` is `"active"` when the payload carries a lid (give the fixture payload a `lid`), and that `checkLicenseStatus` is NOT called for a payload without one (a spy that throws).

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run packages/mailwoman/test/unit/doctor`. Expected: FAIL on `lidStatus`.

- [ ] **Step 3: Implement**

`checks.ts`: import `LicenseStatusAnswer` from `@mailwoman/core/license/status`; add `lidStatus?: LicenseStatusAnswer` to `RuntimeLicenseObservation` and `lid?: string; lidStatus?: LicenseStatusAnswer` to `LicensePosture` (spread `...(key && "payload" in key && isSelfServicePayload(key.payload) ? { lid: key.payload.lid } : {})` and `...(o.lidStatus ? { lidStatus: o.lidStatus } : {})`). In the commercial branch, build the freshness clause and append `license ${o.lidStatus}` when present (the word from the worker, or `license status unreachable`). When `o.lidStatus` is `revoked` or `lapsed`, return `Degraded` with `detail` naming the word and `consequence` as the template `` `The offline token verifies until its date, so the runtime still applies the commercial branch; online, this license is ${word}. Manage billing at ${docsSiteURL()}/license.` `` and `fix: "mailwoman license refresh"`. `appliedLicenseBranch` is untouched: the stamp and the doctor keep agreeing on the branch by construction; the lid status is the doctor's extra word.

`runner.ts`: add `checkLicenseStatus(lid: string): Promise<LicenseStatusAnswer>` to the dependencies interface, default `(lid) => checkLicenseStatus(lid)`; gather it beside the publication when `key && "payload" in key && isSelfServicePayload(key.payload)`; pass `lidStatus` into `runtimeLicenseCheck`. Update `format.ts` only if it renders `LicensePosture` fields by name (grep `keyStatus` there).

- [ ] **Step 4: Run and commit**

Run: `yarn vitest run packages/mailwoman/test/unit/doctor`. Expected: PASS.

```bash
git add packages/mailwoman
git commit -m "feat(doctor): the per-license status beside the key-id publication, as a fifth word the online check adds

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 4: The Buy section on `/license`

**Files:**

- Create: `docs/src/license/shop.ts`, `docs/src/components/License/BuyLicense.tsx`, `docs/src/components/License/styles.module.css`
- Modify: `docs/src/pages/license.mdx`

**Interfaces produced:**

```ts
// docs/src/license/shop.ts
export const LICENSE_WORKER_URL = "https://license.mailwoman.ai"
export const SUPPORT_EMAIL = "teffen@sister.software"
export const AGREEMENT_VERSION = "commercial-2026-10"
export const TERMS_PATH = `/license/terms/${AGREEMENT_VERSION}`
/** Operator-owned. `undefined` until the Payment Links exist; the Buy section renders only when both are set. */
export const PAYMENT_LINK_MONTHLY: string | undefined = undefined
export const PAYMENT_LINK_YEARLY: string | undefined = undefined
export const BILLING_PORTAL_URL: string | undefined = undefined
export function shopIsOpen(): boolean
```

- [ ] **Step 1: The constants and the component**

`shop.ts` as above with a header saying which values the operator fills (issue A in the spec's issue split) and that the worker's exact-origin CORS admits `https://mailwoman.ai`, which is why the page can call it directly.

`BuyLicense.tsx`:

```tsx
import Link from "@docusaurus/Link"
import type React from "react"

import {
	BILLING_PORTAL_URL,
	PAYMENT_LINK_MONTHLY,
	PAYMENT_LINK_YEARLY,
	shopIsOpen,
	SUPPORT_EMAIL,
	TERMS_PATH,
} from "../../license/shop.ts"
import styles from "./styles.module.css"

/**
 * The two Payment Links and the billing portal. Renders the contact route alone until the operator fills the links, so
 * the live page never shows a button that goes nowhere.
 */
export const BuyLicense: React.FC = () => {
	if (!shopIsOpen()) {
		return (
			<p>
				To obtain a license, <a href={`mailto:${SUPPORT_EMAIL}?subject=Mailwoman%20licensing`}>email us</a>.
				Self-service purchase is on its way.
			</p>
		)
	}

	return (
		<div className={styles.buy}>
			<div className={styles.plans}>
				<a className={styles.plan} href={PAYMENT_LINK_MONTHLY}>
					<strong>Monthly</strong>
					<span>Renews every month; the key follows the paid period plus 14 days.</span>
				</a>
				<a className={styles.plan} href={PAYMENT_LINK_YEARLY}>
					<strong>Yearly</strong>
					<span>Renews every year; one key for the year plus 14 days.</span>
				</a>
			</div>
			<p className={styles.fine}>
				Checkout asks for the licensee's legal name and your acceptance of the{" "}
				<Link to={TERMS_PATH}>commercial agreement</Link>. After payment you land on a page that shows your key and a
				refresh secret, and the same key arrives by email.
				{BILLING_PORTAL_URL ? (
					<>
						{" "}
						Change the card, the plan, or cancel at <a href={BILLING_PORTAL_URL}>the billing portal</a>.
					</>
				) : null}
			</p>
		</div>
	)
}
```

`styles.module.css`: `.buy`, `.plans` (two-column grid, one column under 640px), `.plan` (bordered card, `var(--ifm-color-emphasis-300)` border, no underline), `.fine` (smaller text). Follow `docs/src/components/PricingTiers/styles.module.css` for tokens.

- [ ] **Step 2: The page**

In `license.mdx`, replace the last sentence of "The commercial branch" ("To obtain one, email us…") with:

```mdx
import { BuyLicense } from "@site/src/components/License/BuyLicense"

### Buy a license

<BuyLicense />

For enterprise terms, seats, or a negotiated agreement,
[email us about a license](mailto:teffen@sister.software?subject=Mailwoman%20licensing).
```

Under "Configuring and checking a key", after the code block, add a section:

````mdx
## Keeping the key current

A self-service license renews with its subscription, and each renewal issues a new key whose date is the paid period's
end plus 14 days. The purchase page and the first email carry a refresh secret. Adopt the key once:

```bash
mailwoman license adopt "mwl1.…" --secret "<refresh secret>"
```

That writes the key to `$MAILWOMAN_CONFIG_ROOT/license/key`, which mailwoman reads when `MAILWOMAN_LICENSE_KEY` is
unset, and the secret to `refresh.json` beside it with owner-only permissions. After a renewal, fetch the current key:

```bash
mailwoman license refresh
```

`license verify --online` and `mailwoman doctor` report the license's online status as one word: `active`, `lapsed`,
`revoked`, `unknown`, or `unreachable`.

## Refunds and disputes

A full refund or a payment dispute marks the license `revoked` online at once. The key you hold keeps verifying offline
until its date: it is a signed statement about a period that was paid for when it was signed, and revoking it early
would break the installation of a customer whose dispute is later decided in their favour. A dispute decided in your
favour returns the license to its subscription's state. Online checks are how a revocation reaches an installation
before the key's date.
````

Update the frontmatter description if the page's scope grew. Run `yarn workspace @mailwoman/docs lint:prose` (or the `.vale.ini` command the docs `package.json` names) over `docs/src/pages/license.mdx`.

- [ ] **Step 3: Render it**

Start the docs dev server as `docs/.claude/skills/run-docs/SKILL.md` describes, then `node .claude/skills/run-docs/driver.mts --check /license/` and `--screenshot /license/ <scratch>/license.png`; read the screenshot. Expected: the Buy section renders the contact paragraph (links unset), the two new sections render, no console error.

- [ ] **Step 4: Commit**

```bash
git add docs/src
git commit -m "feat(docs): the Buy section, the refresh paragraph and the refunds explanation on /license

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 5: The `/license/issued` claim page

**Files:**

- Create: `docs/src/license/claim.ts` (the pure reducer and the fetch), `docs/src/components/License/IssuedLicense.tsx`, `docs/src/pages/license/issued.tsx`
- Test: `docs/test/unit/license-claim.test.ts`

**Interfaces produced:**

```ts
// docs/src/license/claim.ts
export type ClaimResponse =
	| { status: "pending" }
	| { status: "revoked" }
	| {
			status: "issued"
			token: string
			lid: string
			licensee: string
			issued: string
			expires: string
			refresh_secret?: string
	  }
export type ClaimState =
	| { phase: "polling"; attempts: number; startedAt: number }
	| { phase: "issued"; claim: Extract<ClaimResponse, { status: "issued" }> }
	| { phase: "revoked" }
	| { phase: "not_found" }
	| { phase: "waiting_too_long"; attempts: number } // pending past the deadline
	| { phase: "unreachable"; attempts: number }
export type ClaimEvent =
	| { kind: "response"; response: ClaimResponse; now: number }
	| { kind: "http"; status: number; now: number }
	| { kind: "error"; now: number }
export const CLAIM_INTERVAL_MS = 3000
export const CLAIM_DEADLINE_MS = 120_000
export function initialClaimState(now: number): ClaimState
export function nextClaimState(state: ClaimState, event: ClaimEvent): ClaimState
export function fetchClaim(sessionID: string, signal?: AbortSignal): Promise<ClaimEvent> // never throws; maps to the three event kinds
export function claimURL(sessionID: string): string // `${LICENSE_WORKER_URL}/v1/checkout-sessions/${sessionID}/license`
```

- [ ] **Step 1: Write the failing test**

```ts
// docs/test/unit/license-claim.test.ts
import { describe, expect, it } from "vitest"

import { CLAIM_DEADLINE_MS, initialClaimState, nextClaimState } from "@site/src/license/claim"

// If `@site` does not resolve under the root vitest config, import by relative path from docs/test/unit — the docs
// workspace is the one place the test-contract check admits `browser`/`build`/`e2e` beside unit; check how
// docs/test/unit/*.test.ts already import src.

describe("the claim page's state", () => {
	const t0 = 1_000_000

	it("stays polling on pending until the deadline, then says the email is coming", () => {
		let state = initialClaimState(t0)

		state = nextClaimState(state, { kind: "response", response: { status: "pending" }, now: t0 + 3000 })
		expect(state).toMatchObject({ phase: "polling", attempts: 1 })

		state = nextClaimState(state, {
			kind: "response",
			response: { status: "pending" },
			now: t0 + CLAIM_DEADLINE_MS + 1,
		})
		expect(state).toMatchObject({ phase: "waiting_too_long", attempts: 2 })
	})

	it("issued ends polling with the claim; revoked and 404 end it with their word", () => {
		const issued = {
			status: "issued" as const,
			token: "mwl1.a.b",
			lid: "lic_x",
			licensee: "Example Ltd",
			issued: "2026-10-01",
			expires: "2026-11-15",
			refresh_secret: "s".repeat(43),
		}

		expect(nextClaimState(initialClaimState(t0), { kind: "response", response: issued, now: t0 })).toEqual({
			phase: "issued",
			claim: issued,
		})
		expect(
			nextClaimState(initialClaimState(t0), { kind: "response", response: { status: "revoked" }, now: t0 })
		).toEqual({
			phase: "revoked",
		})
		expect(nextClaimState(initialClaimState(t0), { kind: "http", status: 404, now: t0 })).toEqual({
			phase: "not_found",
		})
	})

	it("a network error or a 5xx keeps polling until the deadline, then reads unreachable", () => {
		let state = initialClaimState(t0)

		state = nextClaimState(state, { kind: "error", now: t0 + 3000 })
		expect(state).toMatchObject({ phase: "polling", attempts: 1 })

		state = nextClaimState(state, { kind: "http", status: 503, now: t0 + CLAIM_DEADLINE_MS + 1 })
		expect(state).toMatchObject({ phase: "unreachable", attempts: 2 })
	})

	it("a terminal state ignores later events", () => {
		const done = { phase: "revoked" as const }

		expect(nextClaimState(done, { kind: "response", response: { status: "pending" }, now: t0 })).toEqual(done)
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run docs/test/unit/license-claim.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement the reducer and the fetch**

```ts
// docs/src/license/claim.ts
import { LICENSE_WORKER_URL } from "./shop.ts"

// (types as in the interface block)

export const CLAIM_INTERVAL_MS = 3000
export const CLAIM_DEADLINE_MS = 120_000

export function claimURL(sessionID: string): string {
	return `${LICENSE_WORKER_URL}/v1/checkout-sessions/${encodeURIComponent(sessionID)}/license`
}

export function initialClaimState(now: number): ClaimState {
	return { phase: "polling", attempts: 0, startedAt: now }
}

/**
 * One step of the claim. Only `polling` moves; every other phase is terminal. `pending` past the deadline is the page
 * saying the email will arrive on its own; an unanswered worker past the deadline is `unreachable`, a different word.
 */
export function nextClaimState(state: ClaimState, event: ClaimEvent): ClaimState {
	if (state.phase !== "polling") return state

	const attempts = state.attempts + 1
	const overdue = event.now - state.startedAt > CLAIM_DEADLINE_MS

	if (event.kind === "response") {
		if (event.response.status === "issued") return { phase: "issued", claim: event.response }
		if (event.response.status === "revoked") return { phase: "revoked" }

		return overdue ? { phase: "waiting_too_long", attempts } : { ...state, attempts }
	}

	if (event.kind === "http" && event.status === 404) return { phase: "not_found" }

	return overdue ? { phase: "unreachable", attempts } : { ...state, attempts }
}

export async function fetchClaim(sessionID: string, signal?: AbortSignal): Promise<ClaimEvent> {
	const now = Date.now()

	try {
		const response = await fetch(claimURL(sessionID), { headers: { accept: "application/json" }, signal })

		if (!response.ok) return { kind: "http", status: response.status, now }

		return { kind: "response", response: (await response.json()) as ClaimResponse, now }
	} catch {
		return { kind: "error", now }
	}
}
```

The docs site is a browser bundle; raw `fetch` is right here (the `APIClient` rule binds Node API clients). The response cast is a single assertion on a JSON body the worker's zod schema shapes.

- [ ] **Step 4: The component and the page**

`IssuedLicense.tsx`: a `useEffect` drives the loop with `setTimeout(CLAIM_INTERVAL_MS)` between `fetchClaim` calls, an `AbortController` on unmount, and `useReducer(nextClaimState, initialClaimState(Date.now()))`. Render per phase:

- `polling`: "Confirming your payment with Stripe…" and a note that this takes a few seconds.
- `issued`: licensee, scope `all`, `issued`, `expires`; the token in a `<pre>` with a copy button (`useClipboard` from `@mailwoman/react`, the pattern in `docs/src/components/PermalinkButton/PermalinkButton.tsx`); when `refresh_secret` is present, its own `<pre>` and copy button under a one-line warning "Shown once. Keep it with the key; it is what fetches renewals."; the `.env` fragment `MAILWOMAN_LICENSE_KEY="…"`; the two commands `mailwoman license adopt "<token>" --secret "<secret>"` (or without `--secret` when absent) and `mailwoman license verify --online`; the billing portal link when `BILLING_PORTAL_URL` is set; "The same key is in your email."
- `waiting_too_long`: "Your payment is recorded but the key is not ready yet. It arrives by email on its own; if it has not within an hour, write to <SUPPORT_EMAIL> with your session id <sessionID>."
- `revoked`: "This license has been revoked. Write to <SUPPORT_EMAIL>."
- `not_found`: "Stripe does not know this session. Use the link Stripe sent you, or write to <SUPPORT_EMAIL>."
- `unreachable`: "license.mailwoman.ai did not answer. The key arrives by email on its own; reload to try again."
- No `session_id` in the query: "This page is where Stripe sends you after payment. Buy at /license." with a link.

`docs/src/pages/license/issued.tsx`:

```tsx
import BrowserOnly from "@docusaurus/BrowserOnly"
import Layout from "@theme/Layout"
import type React from "react"

import { IssuedLicense } from "../../components/License/IssuedLicense.tsx"

const IssuedPage: React.FC = () => (
	<Layout
		title="Your license"
		description="The page Stripe returns you to after payment: your key, once your payment is confirmed."
	>
		<main style={{ padding: "2rem", maxWidth: 800, margin: "0 auto" }}>
			<h1>Your license</h1>
			<BrowserOnly fallback={<p>Loading…</p>}>
				{() => <IssuedLicense sessionID={new URLSearchParams(globalThis.location.search).get("session_id")} />}
			</BrowserOnly>
		</main>
	</Layout>
)

export default IssuedPage
```

Add `<meta name="robots" content="noindex">` for this page through Docusaurus `Head` (`@docusaurus/Head`) inside the Layout: a page that renders a token must not be indexed.

- [ ] **Step 5: Run the test and render the page**

Run: `yarn vitest run docs/test/unit/license-claim.test.ts`. Expected: PASS.
With the dev server up: `node .claude/skills/run-docs/driver.mts --check "/license/issued/?session_id=cs_test_probe"` and a screenshot. Expected: the page reaches `unreachable` or `not_found` (the real worker is not deployed yet), renders the matching copy, and logs no console error other than the failed fetch. Also `--check /license/issued/` without a query: the "buy at /license" copy.

- [ ] **Step 6: Commit**

```bash
git add docs/src docs/test/unit/license-claim.test.ts
git commit -m "feat(docs): /license/issued — poll the claim route, show the key and the one-time refresh secret, say what a wait means

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 6: CHANGELOG, the worker README's cross-reference, full check, PR

- [ ] **Step 1: CHANGELOG** under `## Unreleased`, above the worker entry:

```markdown
### Added — self-service license: the site and the CLI

`/license` gains a Buy section (the two Payment Links and the billing portal, rendered once the operator fills them),
a section on keeping the key current, and the reason a refunded license keeps verifying offline until its date.
`/license/issued` is the page Stripe returns a buyer to: it polls the worker's claim route and shows the key, the
one-time refresh secret, the `.env` fragment and the two commands to run. `mailwoman license adopt <token> --secret <s>`
writes the key to `$MAILWOMAN_CONFIG_ROOT/license/key` and the credentials to `refresh.json` (mode 0600);
`mailwoman license refresh` fetches the current key after a renewal and refuses a token this build does not trust.
`verifyConfiguredLicenseKey` reads the key file when `MAILWOMAN_LICENSE_KEY` is unset. `license verify --online` and
`mailwoman doctor` report the per-license status as a fifth word: `active`, `lapsed`, `revoked`, `unknown`, or
`unreachable`. New env: `MAILWOMAN_LICENSE_URL`.
```

- [ ] **Step 2: The worker README** gains one line under "First deploy" step 7: the Payment Link's success URL is `https://mailwoman.ai/license/issued?session_id={CHECKOUT_SESSION_ID}`.

- [ ] **Step 3: Full check**

```bash
yarn compile
yarn typecheck:tests
yarn lint
yarn vitest run packages/core/test/unit/license packages/mailwoman/test/unit/doctor packages/mailwoman/test/integration/license-cli.test.ts packages/mailwoman/test/unit/module-count.test.ts docs/test/unit/license-claim.test.ts
yarn test:license-worker
```

Then `yarn test`. Run `yarn lint` on the EXACT tree being pushed, after the last commit.

- [ ] **Step 4: Push and PR**

Push `feat/license-site-and-cli`; open the PR against `main` with the template; state: the key-file read joins the launcher path at N modules (from Task 0); `refresh` refuses an untrusted token and why; the doctor's fifth word and that `appliedLicenseBranch` is untouched; the Buy section's render condition; that the terms page and the Payment Link URLs are issue A's. Closes the tracking issue created at execution start.
