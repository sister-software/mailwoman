# License Key on WebCrypto Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The license key format in `@mailwoman/core` signs and verifies on WebCrypto, gains the `lid` and `agreement` fields, reads its trusted keys from one typed register that also produces the well-known JSON, and is importable by a Cloudflare Worker through `@mailwoman/core/license/key` and `@mailwoman/core/license/register` with no `node:` specifier in the bundle.

**Architecture:** A new `packages/core/lib/crypto/ed25519.ts` holds Ed25519 and SHA-256 on `globalThis.crypto.subtle` with a PEM codec; `key.ts` becomes async on top of it; `register.ts` replaces `trusted-keys.ts`; every caller awaits the new signatures in the same change, with no forwarding exports. An esbuild bundle test under the `workerd,worker,browser` conditions is the check that the two subpaths stay `node:`-free.

**Tech Stack:** TypeScript under Node 24 (type stripping), WebCrypto (`SubtleCrypto` Ed25519 + SHA-256), zod 4, vitest, esbuild 0.28.2 (already pinned in `@mailwoman/neural`).

**Spec:** `docs/superpowers/specs/2026-09-05-self-service-commercial-license-design.md`, section "The key format on WebCrypto, worker-safe by subpath" and "Key states". This plan is issue B of that spec's split.

## Global Constraints

- No compatibility re-exports. A name that moves is imported from its new home by every caller in this plan. A function that becomes async is awaited by every caller in this plan.
- `node:*` imports are refused outside `@mailwoman/core` by `oxlint.config.ts`. Inside core, the new `crypto/` modules import NO `node:*` module at all; that is what makes them portable.
- Relative imports carry `.ts`; sibling modules go through `#*` (`#crypto/ed25519`), never `../`.
- No `enum`; `const X = {…} as const`.
- Comments state invariants; no dates, PR numbers, or "now"/"added".
- Acronym casing: `PEM`, `DER`, `URL`, `ID` as whole components: `publicKeyDER`, `licenseKeyID`, `toBase64URL`.
- Wire keys snake_case; the payload fields `lid` and `agreement` are lower-case words.
- Every existing hand-issued token stays valid: the signature covers `mwl1.<payload>` bytes and the WebCrypto verifier must accept a token the `node:crypto` signer produced. Task 0 captures that fixture BEFORE the swap.
- Run `yarn compile` before any test that spawns the compiled CLI. Pre-commit runs the compiled CLI too.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg`.
- Work happens on branch `docs/license-shop-design` in the worktree `.claude/worktrees/license-posture`; rename it to `feat/license-key-webcrypto` at Task 0. Never `cd` to the main checkout.
- The worktree Bash guard refuses `cat >>` heredocs, computed arguments, and the word `eval`; use `python3 - <<'EOF'` heredocs or the Edit/Write tools for file changes.

---

## File map

| File                                                                                    | Responsibility                                                                                                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/fixtures/license/legacy-token.json` (create, Task 0)                | a key pair, kid, payload, and token produced by the `node:crypto` implementation, so the WebCrypto verifier is measured against what shipped  |
| `packages/core/lib/crypto/base64url.ts` (create)                                        | `toBase64URL`, `fromBase64URL`, `utf8Bytes`, `utf8Text` on `btoa`/`atob`/`TextEncoder`                                                        |
| `packages/core/lib/crypto/ed25519.ts` (create)                                          | `generateEd25519KeyPair`, `signEd25519`, `verifyEd25519`, `publicKeyDER`, `sha256Bytes`, PEM codec, all on `crypto.subtle`                    |
| `packages/core/lib/hash.ts` (modify)                                                    | loses the four Ed25519 helpers and their `node:crypto` imports for `createPrivateKey`/`createPublicKey`/`generateKeyPairSync`/`sign`/`verify` |
| `packages/core/lib/license/key.ts` (modify)                                             | async on `#crypto/ed25519`; `lid`, `agreement`; `isSelfServicePayload`                                                                        |
| `packages/core/lib/license/register.ts` (create)                                        | `LICENSE_SIGNING_KEYS`, `LicenseKeyStatus`, `trustedLicenseSigningKeys()`, `publishedLicenseKeys()`, `PublishedLicenseKeys`                   |
| `packages/core/lib/license/trusted-keys.ts` (delete)                                    | replaced by the register                                                                                                                      |
| `packages/core/lib/license/configured.ts` (modify)                                      | async; reads the register                                                                                                                     |
| `packages/core/lib/license/publication.ts` (modify)                                     | imports `PublishedLicenseKeys` from the register                                                                                              |
| `packages/core/lib/license/index.ts` (modify)                                           | exports the register, not trusted-keys                                                                                                        |
| `packages/core/package.json` (modify)                                                   | `./license/key`, `./license/register` exports; `esbuild` devDependency                                                                        |
| `packages/core/test/unit/crypto/ed25519.test.ts`, `base64url.test.ts` (create)          | the primitives                                                                                                                                |
| `packages/core/test/unit/license/key.test.ts`, `register.test.ts` (modify/create)       | async key tests, the legacy fixture, the register derivations                                                                                 |
| `packages/core/test/integration/worker-bundle.test.ts` (create)                         | esbuild under `workerd,worker,browser`, no `node:` specifier                                                                                  |
| `packages/mailwoman/lib/cli-kit/engine-stamp.ts` (modify)                               | awaits `verifyConfiguredLicenseKey`                                                                                                           |
| `packages/mailwoman/lib/doctor/runner.ts` (modify)                                      | `licenseKey(): Promise<…>`                                                                                                                    |
| `packages/mailwoman/lib/cli-native/commands/license.ts` (modify)                        | awaits; reads the register; new `register` action                                                                                             |
| `packages/mailwoman/test/unit/doctor/runner.test.ts` (modify)                           | async fixtures                                                                                                                                |
| `packages/repo-health/lib/checks/license-register.ts` (create) + `registry.ts` (modify) | the committed well-known JSON equals the register's derivation                                                                                |
| `docs/static/.well-known/mailwoman/license-keys.json` (regenerate)                      | from the register                                                                                                                             |
| `CHANGELOG.md` (modify)                                                                 | Changed: async key API, register, subpaths                                                                                                    |

---

### Task 0: Capture the legacy fixture and rename the branch

**Files:**

- Create: `packages/core/test/fixtures/license/legacy-token.json`

This runs against the CURRENT `node:crypto` implementation, before any code changes, so the fixture is what shipped.

- [ ] **Step 1: Rename the branch**

```bash
git branch -m docs/license-shop-design feat/license-key-webcrypto
```

- [ ] **Step 2: Write the fixture generator to the scratchpad and run it**

```ts
// /tmp/claude-1000/-home-lab-Projects-mailwoman/dc5b25ae-2f59-4cfe-a00a-391f0b430ece/scratchpad/legacy-fixture.ts
import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	type LicenseKeyPayload,
} from "@mailwoman/core/license"

const pair = generateLicenseSigningKeyPair()
const kid = licenseKeyID(pair.publicKeyPEM, 9)
const payload: LicenseKeyPayload = {
	v: 1,
	kid,
	licensee: "Legacy Fixture Ltd",
	issued: "2026-09-05",
	expires: "2027-09-05",
	scope: "all",
	terms: "LicenseRef-Commercial",
}
const token = encodeLicenseKey(payload, pair.privateKeyPEM)

process.stdout.write(`${JSON.stringify({ ...pair, kid, payload, token }, null, "\t")}\n`)
```

Run from the worktree root: `node /tmp/claude-1000/-home-lab-Projects-mailwoman/dc5b25ae-2f59-4cfe-a00a-391f0b430ece/scratchpad/legacy-fixture.ts > packages/core/test/fixtures/license/legacy-token.json` (create the directory first). The private key in this file is a TEST key that signs nothing real; it exists so the WebCrypto signer can be checked for byte-identical output too.

- [ ] **Step 3: Verify the fixture verifies today**

```bash
node packages/mailwoman/out/cli.js license verify --key "$(python3 -c 'import json;print(json.load(open("packages/core/test/fixtures/license/legacy-token.json"))["token"])')"
```

Expected: `status: unknown_key` (the fixture key is not in the shipped trust map). That is the right answer; the test in Task 2 injects the fixture's public key as trusted.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/fixtures/license/legacy-token.json
git commit -m "test(core): a license token signed by the node:crypto implementation, kept as the fixture the WebCrypto verifier must accept

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 1: The portable primitives — base64url and Ed25519 on WebCrypto

**Files:**

- Create: `packages/core/lib/crypto/base64url.ts`, `packages/core/lib/crypto/ed25519.ts`
- Test: `packages/core/test/unit/crypto/base64url.test.ts`, `packages/core/test/unit/crypto/ed25519.test.ts`

**Interfaces produced:**

```ts
// #crypto/base64url
export function toBase64URL(bytes: Uint8Array): string
export function fromBase64URL(text: string): Uint8Array
export function utf8Bytes(text: string): Uint8Array
export function utf8Text(bytes: Uint8Array): string
// #crypto/ed25519
export interface Ed25519KeyPairPEM {
	privateKeyPEM: string
	publicKeyPEM: string
}
export function generateEd25519KeyPair(): Promise<Ed25519KeyPairPEM>
export function signEd25519(data: Uint8Array, privateKeyPEM: string): Promise<Uint8Array>
export function verifyEd25519(data: Uint8Array, publicKeyPEM: string, signature: Uint8Array): Promise<boolean>
export function publicKeyDER(publicKeyPEM: string): Uint8Array
export function sha256Bytes(data: Uint8Array): Promise<Uint8Array>
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/unit/crypto/base64url.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "@mailwoman/core/crypto/base64url"
import { describe, expect, it } from "vitest"

describe("base64url", () => {
	it("agrees with Node's base64url on every byte value", () => {
		const bytes = new Uint8Array(256).map((_, i) => i)

		expect(toBase64URL(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
		expect(fromBase64URL(toBase64URL(bytes))).toEqual(bytes)
	})

	it("carries no padding and no +/ characters", () => {
		for (const length of [1, 2, 3, 4, 5]) {
			const text = toBase64URL(new Uint8Array(length).fill(0xff))

			expect(text).not.toMatch(/[=+/]/u)
		}
	})

	it("round-trips UTF-8 text through bytes", () => {
		expect(utf8Text(utf8Bytes("Zürich — 東京"))).toBe("Zürich — 東京")
	})
})
```

```ts
// packages/core/test/unit/crypto/ed25519.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	generateEd25519KeyPair,
	publicKeyDER,
	sha256Bytes,
	signEd25519,
	verifyEd25519,
} from "@mailwoman/core/crypto/ed25519"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { createHash, sign as nodeSign, createPrivateKey } from "node:crypto"
import { describe, expect, it } from "vitest"

interface LegacyFixture {
	privateKeyPEM: string
	publicKeyPEM: string
	token: string
}

const fixture = await readLocalJSONFile<LegacyFixture>(
	resolvePackagePath("@mailwoman/core", "test", "fixtures", "license", "legacy-token.json")
)

const bytes = new TextEncoder().encode("the quick brown fox")

describe("Ed25519 on WebCrypto", () => {
	it("verifies a signature the node:crypto signer produced over the same bytes", async () => {
		const nodeSignature = new Uint8Array(nodeSign(null, bytes, createPrivateKey(fixture.privateKeyPEM)))

		expect(await verifyEd25519(bytes, fixture.publicKeyPEM, nodeSignature)).toBe(true)
	})

	it("produces the signature node:crypto produces for the same key and bytes (Ed25519 is deterministic)", async () => {
		const nodeSignature = new Uint8Array(nodeSign(null, bytes, createPrivateKey(fixture.privateKeyPEM)))

		expect(await signEd25519(bytes, fixture.privateKeyPEM)).toEqual(nodeSignature)
	})

	it("generates a pair whose halves sign and verify, in PEM with 64-column lines", async () => {
		const pair = await generateEd25519KeyPair()

		expect(pair.privateKeyPEM).toMatch(
			/^-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END PRIVATE KEY-----\n$/u
		)
		expect(pair.publicKeyPEM).toMatch(
			/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END PUBLIC KEY-----\n$/u
		)

		const signature = await signEd25519(bytes, pair.privateKeyPEM)

		expect(await verifyEd25519(bytes, pair.publicKeyPEM, signature)).toBe(true)
		expect(await verifyEd25519(new Uint8Array([1]), pair.publicKeyPEM, signature)).toBe(false)
	})

	it("answers false, not a throw, for a signature of the wrong length", async () => {
		expect(await verifyEd25519(bytes, fixture.publicKeyPEM, new Uint8Array(3))).toBe(false)
	})

	it("decodes SPKI DER from PEM exactly as node does, and digests it identically", async () => {
		const der = publicKeyDER(fixture.publicKeyPEM)
		const nodeDER = new Uint8Array(createHash("sha256").update(der).digest())

		expect(der).toHaveLength(44)
		expect(await sha256Bytes(der)).toEqual(nodeDER)
	})
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn vitest run packages/core/test/unit/crypto`
Expected: FAIL, the two subpaths do not resolve.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/lib/crypto/base64url.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Base64url and UTF-8 on the web platform's own primitives, so the license key format has no `Buffer` in it and the
 *   same module runs under Node, a Cloudflare Worker and a browser.
 */

export function toBase64URL(bytes: Uint8Array): string {
	let binary = ""

	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}

	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export function fromBase64URL(text: string): Uint8Array {
	const padded = text
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.padEnd(Math.ceil(text.length / 4) * 4, "=")
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)

	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}

	return bytes
}

export function utf8Bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

export function utf8Text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}
```

```ts
// packages/core/lib/crypto/ed25519.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ed25519 and SHA-256 on `crypto.subtle`, the one implementation Node, a Cloudflare Worker and a browser share. Keys
 *   travel as PEM: PKCS8 for the private half, SPKI for the public half, which is what `node:crypto` wrote before and
 *   what an operator's signing key file already holds. The PEM codec here is a base64 transform of the DER bytes the
 *   WebCrypto API imports and exports; nothing parses ASN.1.
 *
 *   Signing is deterministic in Ed25519, so a WebCrypto signature over the same key and bytes equals the `node:crypto`
 *   one byte for byte — the test holds that against a fixture produced before this module existed.
 */

import { fromBase64URL, toBase64URL } from "#crypto/base64url"

export interface Ed25519KeyPairPEM {
	privateKeyPEM: string
	publicKeyPEM: string
}

const ALGORITHM = { name: "Ed25519" } as const

const PEM_LINE_WIDTH = 64

function pemToDER(pem: string): Uint8Array {
	const base64 = pem
		.replace(/-----BEGIN [A-Z ]+-----/u, "")
		.replace(/-----END [A-Z ]+-----/u, "")
		.replaceAll(/\s+/gu, "")

	// Standard base64 with padding; the url-safe decoder accepts it once the two alphabet characters are mapped.
	return fromBase64URL(base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""))
}

function derToPEM(der: Uint8Array, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
	const base64 = toBase64URL(der).replaceAll("-", "+").replaceAll("_", "/")
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
	const lines = padded.match(new RegExp(`.{1,${PEM_LINE_WIDTH}}`, "gu")) ?? []

	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/**
 * The SPKI DER bytes of a PEM public key: the stable encoding to derive an identifier from, since PEM line wrapping and
 * trailing whitespace vary between writers.
 */
export function publicKeyDER(publicKeyPEM: string): Uint8Array {
	return pemToDER(publicKeyPEM)
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPairPEM> {
	const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair

	return {
		privateKeyPEM: derToPEM(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), "PRIVATE KEY"),
		publicKeyPEM: derToPEM(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)), "PUBLIC KEY"),
	}
}

export async function signEd25519(data: Uint8Array, privateKeyPEM: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("pkcs8", pemToDER(privateKeyPEM), ALGORITHM, false, ["sign"])

	return new Uint8Array(await crypto.subtle.sign(ALGORITHM, key, data))
}

/**
 * Answers `false` for a bad signature and never throws on one; a malformed KEY still throws, because that is a caller
 * error rather than an untrusted input.
 */
export async function verifyEd25519(data: Uint8Array, publicKeyPEM: string, signature: Uint8Array): Promise<boolean> {
	const key = await crypto.subtle.importKey("spki", pemToDER(publicKeyPEM), ALGORITHM, false, ["verify"])

	try {
		return await crypto.subtle.verify(ALGORITHM, key, signature, data)
	} catch {
		return false
	}
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", data))
}
```

If TypeScript rejects `crypto.subtle` as an unknown global in core, the `@types/node` version in use lacks the `crypto` global; add `import { webcrypto } from "node:crypto"` is NOT the fix (it breaks portability). Check `tsconfig` `lib` first; `@types/node` 20+ declares `var crypto: webcrypto.Crypto`.

Add the two subpath exports to `packages/core/package.json`, beside `./hash`:

```json
		"./crypto/base64url": {
			"node": "./lib/crypto/base64url.ts",
			"default": "./out/crypto/base64url.js",
			"types": "./out/crypto/base64url.d.ts"
		},
		"./crypto/ed25519": {
			"node": "./lib/crypto/ed25519.ts",
			"default": "./out/crypto/ed25519.js",
			"types": "./out/crypto/ed25519.d.ts"
		},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn vitest run packages/core/test/unit/crypto`
Expected: PASS, 8 tests. If the deterministic-signature test fails while the verify test passes, the platform's Ed25519 is the RFC 8032 one (deterministic by construction), so the mismatch is in the PEM codec: compare `pemToDER(fixture.privateKeyPEM)` against `createPrivateKey(pem).export({ type: "pkcs8", format: "der" })` byte for byte.

- [ ] **Step 5: Lint and commit**

```bash
yarn oxlint packages/core/lib/crypto packages/core/test/unit/crypto
git add packages/core/lib/crypto packages/core/test/unit/crypto packages/core/package.json
git commit -m "feat(core): Ed25519 and base64url on the web platform's primitives, one implementation for Node, a Worker and a browser

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 2: The key format goes async on the new primitives, with `lid` and `agreement`

**Files:**

- Modify: `packages/core/lib/license/key.ts`, `packages/core/lib/hash.ts`
- Modify: `packages/core/test/unit/license/key.test.ts`

**Interfaces produced:**

```ts
export const LicenseKeyPayloadSchema // + lid?: string, agreement?: string
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string; agreement: string }
export function isSelfServicePayload(payload: LicenseKeyPayload): payload is SelfServiceLicenseKeyPayload
export function generateLicenseSigningKeyPair(): Promise<LicenseSigningKeyPair>
export function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string>
export function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string>
export function verifyLicenseKey(token: string, options: { trustedKeys; now? }): Promise<LicenseKeyVerification>
```

- [ ] **Step 1: Rewrite the key tests as async and add the fixture and field cases**

Replace `packages/core/test/unit/license/key.test.ts` wholesale:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	isSelfServicePayload,
	LICENSE_KEY_PREFIX,
	licenseKeyID,
	type LicenseKeyPayload,
	verifyLicenseKey,
} from "@mailwoman/core/license"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, it } from "vitest"

interface LegacyFixture {
	privateKeyPEM: string
	publicKeyPEM: string
	kid: string
	payload: LicenseKeyPayload
	token: string
}

const legacy = await readLocalJSONFile<LegacyFixture>(
	resolvePackagePath("@mailwoman/core", "test", "fixtures", "license", "legacy-token.json")
)

const pair = await generateLicenseSigningKeyPair()
const kid = await licenseKeyID(pair.publicKeyPEM, 9)
const trustedKeys = { [kid]: pair.publicKeyPEM }

const payload: LicenseKeyPayload = {
	v: 1,
	kid,
	licensee: "Example Ltd",
	issued: "2026-09-03",
	expires: "2027-09-03",
	scope: "all",
	terms: "LicenseRef-Commercial",
}

describe("license key", () => {
	it("verifies the token the node:crypto implementation signed, and re-signs it byte for byte", async () => {
		const trusted = { [legacy.kid]: legacy.publicKeyPEM }

		expect(
			await verifyLicenseKey(legacy.token, { trustedKeys: trusted, now: new Date("2027-01-01T00:00:00Z") })
		).toEqual({
			status: "valid",
			kid: legacy.kid,
			payload: legacy.payload,
		})
		expect(await licenseKeyID(legacy.publicKeyPEM, 9)).toBe(legacy.kid)
		expect(await encodeLicenseKey(legacy.payload, legacy.privateKeyPEM)).toBe(legacy.token)
	})

	it("round-trips a signed payload and reads valid before its expiry", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)

		expect(token.startsWith(`${LICENSE_KEY_PREFIX}.`)).toBe(true)
		expect(await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })).toEqual({
			status: "valid",
			kid,
			payload,
		})
	})

	it("is valid through the last day and expired the day after", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)

		expect((await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-03T23:00:00Z") })).status).toBe("valid")
		expect((await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") })).status).toBe(
			"expired"
		)
	})

	it("refuses a tampered payload — the signature covers the prefix and the payload", async () => {
		const token = await encodeLicenseKey(payload, pair.privateKeyPEM)
		const [prefix, , signature] = token.split(".") as [string, string, string]
		const forged = Buffer.from(JSON.stringify({ ...payload, licensee: "Someone Else" })).toString("base64url")

		expect(await verifyLicenseKey(`${prefix}.${forged}.${signature}`, { trustedKeys })).toMatchObject({
			status: "invalid",
			reason: expect.stringContaining("signature does not verify"),
		})
	})

	it("names an unknown key id rather than failing generically", async () => {
		const other = await generateLicenseSigningKeyPair()
		const otherKid = await licenseKeyID(other.publicKeyPEM, 9)
		const token = await encodeLicenseKey({ ...payload, kid: otherKid }, other.privateKeyPEM)

		expect(await verifyLicenseKey(token, { trustedKeys })).toMatchObject({ status: "unknown_key", kid: otherKid })
	})

	it("refuses a token under another prefix or with an unreadable payload", async () => {
		expect((await verifyLicenseKey("mwl2.abc.def", { trustedKeys })).status).toBe("invalid")

		expect(
			await verifyLicenseKey(`${LICENSE_KEY_PREFIX}.${Buffer.from("{}").toString("base64url")}.x`, { trustedKeys })
		).toMatchObject({ status: "invalid", reason: expect.stringContaining("payload unreadable") })
	})

	it("derives a key id from the major version and the public key's digest", async () => {
		expect(kid).toMatch(/^v9-[0-9a-f]{8}$/u)
		expect(await licenseKeyID(pair.publicKeyPEM, 10)).toMatch(/^v10-[0-9a-f]{8}$/u)
		expect(await licenseKeyID((await generateLicenseSigningKeyPair()).publicKeyPEM, 9)).not.toBe(kid)
	})

	it("carries lid and agreement when a self-service issuer sets them, and a hand-issued payload reads as not self-service", async () => {
		const selfService: LicenseKeyPayload = {
			...payload,
			lid: "lic_0123456789abcdefghijkl",
			agreement: "commercial-2026-10",
		}
		const token = await encodeLicenseKey(selfService, pair.privateKeyPEM)
		const verified = await verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })

		expect(verified).toMatchObject({ status: "valid", payload: selfService })
		expect(isSelfServicePayload(selfService)).toBe(true)
		expect(isSelfServicePayload(payload)).toBe(false)
	})

	it("refuses an empty lid or agreement", async () => {
		await expect(encodeLicenseKey({ ...payload, lid: "" }, pair.privateKeyPEM)).rejects.toThrow()
		await expect(encodeLicenseKey({ ...payload, agreement: "" }, pair.privateKeyPEM)).rejects.toThrow()
	})
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `yarn vitest run packages/core/test/unit/license/key.test.ts`
Expected: FAIL — `isSelfServicePayload` is not exported; `await licenseKeyID(...)` on a string still passes, the `lid` case fails on the schema stripping the key (`toMatchObject` on `payload: selfService` fails).

- [ ] **Step 3: Rewrite `key.ts`**

Replace the imports and the body of `packages/core/lib/license/key.ts` (keep the header docstring, adding one sentence: "Signing and verification run on WebCrypto, so this module has no `node:` import and runs where the worker and the browser run."):

```ts
import { z } from "zod"

import { fromBase64URL, toBase64URL, utf8Bytes, utf8Text } from "#crypto/base64url"
import { generateEd25519KeyPair, publicKeyDER, sha256Bytes, signEd25519, verifyEd25519 } from "#crypto/ed25519"
import { parseJSONStrict } from "#objects"

export const LICENSE_KEY_PREFIX = "mwl1"

const LICENSE_KEY_PARTS = 3

const CalendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD")

export const LicenseKeyPayloadSchema = z.object({
	v: z.literal(1),
	kid: z.string().min(1),
	licensee: z.string().min(1),
	issued: CalendarDate,
	expires: CalendarDate.optional(),
	scope: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
	terms: z.literal("LicenseRef-Commercial"),
	/**
	 * An opaque per-license serial a self-service issuer sets, stable for the subscription's life. It is what online
	 * status is keyed by, and it names nothing about the customer.
	 */
	lid: z.string().min(1).optional(),
	/**
	 * The version of the clickwrap terms the licensee accepted, set by a self-service issuer.
	 */
	agreement: z.string().min(1).optional(),
})

export type LicenseKeyPayload = z.infer<typeof LicenseKeyPayloadSchema>

/**
 * A payload a self-service issuer produced: both fields present. A hand-issued payload has neither.
 */
export type SelfServiceLicenseKeyPayload = LicenseKeyPayload & { lid: string; agreement: string }

export function isSelfServicePayload(payload: LicenseKeyPayload): payload is SelfServiceLicenseKeyPayload {
	return typeof payload.lid === "string" && typeof payload.agreement === "string"
}

export type LicenseKeyVerification =
	| { status: "valid"; kid: string; payload: LicenseKeyPayload }
	| { status: "expired"; kid: string; payload: LicenseKeyPayload }
	| { status: "unknown_key"; kid: string; reason: string }
	| { status: "invalid"; reason: string }

export interface LicenseSigningKeyPair {
	privateKeyPEM: string
	publicKeyPEM: string
}

export function generateLicenseSigningKeyPair(): Promise<LicenseSigningKeyPair> {
	return generateEd25519KeyPair()
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * The id a public key is registered under: the mailwoman major version it was minted for, then the first eight hex
 * digits of the SHA-256 of the key's DER encoding — `v9-3f2a9c1d`.
 */
export async function licenseKeyID(publicKeyPEM: string, majorVersion: number): Promise<string> {
	const digest = hex(await sha256Bytes(publicKeyDER(publicKeyPEM))).slice(0, 8)

	return `v${majorVersion}-${digest}`
}

export async function encodeLicenseKey(payload: LicenseKeyPayload, privateKeyPEM: string): Promise<string> {
	const checked = LicenseKeyPayloadSchema.parse(payload)
	const body = `${LICENSE_KEY_PREFIX}.${toBase64URL(utf8Bytes(JSON.stringify(checked)))}`
	const signature = await signEd25519(utf8Bytes(body), privateKeyPEM)

	return `${body}.${toBase64URL(signature)}`
}

function expiryInstant(expires: string): Date {
	return new Date(`${expires}T23:59:59.999Z`)
}

export async function verifyLicenseKey(
	token: string,
	options: { trustedKeys: Readonly<Record<string, string>>; now?: Date }
): Promise<LicenseKeyVerification> {
	const parts = token.trim().split(".")

	if (parts.length !== LICENSE_KEY_PARTS || parts[0] !== LICENSE_KEY_PREFIX) {
		return { status: "invalid", reason: `not a ${LICENSE_KEY_PREFIX} token (expected three dot-separated parts)` }
	}

	const [prefix, payloadPart, signaturePart] = parts as [string, string, string]
	let payload: LicenseKeyPayload

	try {
		payload = LicenseKeyPayloadSchema.parse(parseJSONStrict(utf8Text(fromBase64URL(payloadPart))))
	} catch (error) {
		return {
			status: "invalid",
			reason: `payload unreadable: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	const publicKeyPEM = options.trustedKeys[payload.kid]

	if (!publicKeyPEM) {
		return {
			status: "unknown_key",
			kid: payload.kid,
			reason: `signed by key id ${payload.kid}, which this build does not trust`,
		}
	}

	const signed = await verifyEd25519(utf8Bytes(`${prefix}.${payloadPart}`), publicKeyPEM, fromBase64URL(signaturePart))

	if (!signed) {
		return { status: "invalid", reason: `signature does not verify under key id ${payload.kid}` }
	}

	const now = options.now ?? new Date()

	if (payload.expires && expiryInstant(payload.expires) < now) {
		return { status: "expired", kid: payload.kid, payload }
	}

	return { status: "valid", kid: payload.kid, payload }
}
```

Keep the existing per-field docstrings on the schema (`v`, `kid`, `licensee`, `expires`, `scope`, `terms`) from the current file. Note `error instanceof Error ? …` here: use `errorMessage` from `#errors/schema` instead if that import is `node:`-free (it is: one type-only import); prefer it.

- [ ] **Step 4: Remove the Ed25519 helpers from `hash.ts`**

Delete `generateEd25519KeyPair`, `signEd25519`, `verifyEd25519`, `publicKeyDER`, the `Ed25519KeyPairPEM` interface, and the now-unused names from the `node:crypto` import (`createPrivateKey`, `createPublicKey`, `generateKeyPairSync`, `sign`, `verify`). `sha256Hex`, `sha256File`, `md5File` stay. Run `grep -rn "from \"@mailwoman/core/hash\"\|from \"#hash\"" packages --include='*.ts' -l` and confirm no remaining importer names a deleted symbol (Task 0's grep found only `key.ts`).

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run packages/core/test/unit/license/key.test.ts packages/core/test/unit/utils/hash.test.ts`
Expected: PASS. Every other license test in core still fails to compile at this point (they call the sync signatures); Task 4 fixes them. Do not run the whole core suite yet.

- [ ] **Step 6: Commit**

```bash
yarn oxlint packages/core/lib/license/key.ts packages/core/lib/hash.ts packages/core/test/unit/license/key.test.ts
git add packages/core/lib/license/key.ts packages/core/lib/hash.ts packages/core/test/unit/license/key.test.ts
git commit -m "feat(core): the license key signs and verifies on WebCrypto and carries lid and agreement

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 3: The typed key register replaces `trusted-keys.ts` and produces the well-known JSON

**Files:**

- Create: `packages/core/lib/license/register.ts`
- Delete: `packages/core/lib/license/trusted-keys.ts`
- Modify: `packages/core/lib/license/publication.ts` (import `PublishedLicenseKeys` from the register), `packages/core/lib/license/index.ts`, `packages/core/package.json` (exports)
- Test: `packages/core/test/unit/license/register.test.ts`

**Interfaces produced:**

```ts
export const LicenseKeyStatus = { Active: "active", Retired: "retired", Revoked: "revoked" } as const
export type LicenseKeyStatus = (typeof LicenseKeyStatus)[keyof typeof LicenseKeyStatus]
export interface LicenseSigningKey {
	kid: string
	publicKeyPEM: string
	majorVersions: readonly number[]
	status: LicenseKeyStatus
}
export const LICENSE_SIGNING_KEYS: readonly LicenseSigningKey[]
export function trustedLicenseSigningKeys(): Readonly<Record<string, string>> // active + retired
export interface PublishedLicenseKeys {
	format: "mailwoman-license-keys/1"
	keys: Array<{ kid; algorithm: "Ed25519"; publicKey; majorVersions: number[]; status: LicenseKeyStatus }>
}
export function publishedLicenseKeys(): PublishedLicenseKeys
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/license/register.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	LICENSE_SIGNING_KEYS,
	licenseKeyID,
	LicenseKeyStatus,
	publishedLicenseKeys,
	trustedLicenseSigningKeys,
} from "@mailwoman/core/license"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

describe("the license key register", () => {
	it("holds at least the operator's key, and every kid is the digest of its own public key", async () => {
		expect(LICENSE_SIGNING_KEYS.length).toBeGreaterThan(0)

		for (const key of LICENSE_SIGNING_KEYS) {
			expect(await licenseKeyID(key.publicKeyPEM, key.majorVersions[0]!)).toBe(key.kid)
		}
	})

	it("trusts active and retired keys offline and never a revoked one", () => {
		const trusted = trustedLicenseSigningKeys()

		for (const key of LICENSE_SIGNING_KEYS) {
			expect(key.kid in trusted).toBe(key.status !== LicenseKeyStatus.Revoked)
		}
	})

	it("derives the committed well-known JSON exactly", async () => {
		const committed = await readLocalJSONFile<unknown>(
			repoRootPath("docs", "static", ".well-known", "mailwoman", "license-keys.json")
		)

		// The committed file carries a `$comment` for human readers; the derivation carries the same one.
		expect(committed).toEqual(publishedLicenseKeys())
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run packages/core/test/unit/license/register.test.ts`
Expected: FAIL — the names are not exported.

- [ ] **Step 3: Write the register and delete the map**

```ts
// packages/core/lib/license/register.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register of license signing keys: the one source both the shipped trust map and the well-known JSON on
 *   mailwoman.ai derive from, so the two cannot disagree. A key enters when `mailwoman license keygen` mints it and
 *   moves through three states:
 *
 *   - `active`: may sign and verify.
 *   - `retired`: may no longer sign; tokens it signed still verify offline until they expire.
 *   - `revoked`: compromised; online status refuses its tokens at once and the next release stops trusting it
 *     offline — the map this module derives leaves a revoked key out.
 *
 *   `mailwoman license register --write` regenerates the well-known file from this module, and the `license-register`
 *   health check refuses a tree where the two differ.
 */

export const LicenseKeyStatus = {
	Active: "active",
	Retired: "retired",
	Revoked: "revoked",
} as const

export type LicenseKeyStatus = (typeof LicenseKeyStatus)[keyof typeof LicenseKeyStatus]

export interface LicenseSigningKey {
	/**
	 * `licenseKeyID(publicKeyPEM, majorVersions[0])`; the register test holds every entry to that.
	 */
	kid: string
	publicKeyPEM: string
	/**
	 * The mailwoman major versions this key signs for.
	 */
	majorVersions: readonly number[]
	status: LicenseKeyStatus
}

export const LICENSE_SIGNING_KEYS: readonly LicenseSigningKey[] = [
	{
		kid: "v9-ecec29be",
		publicKeyPEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAwPWLp1gjTRCSKjPqrS5q1jw5WP7SlofcVap390Z2Te4=
-----END PUBLIC KEY-----
`,
		majorVersions: [9],
		status: LicenseKeyStatus.Active,
	},
]

/**
 * Key id → PEM public key for offline verification: every key that is not revoked.
 */
export function trustedLicenseSigningKeys(): Readonly<Record<string, string>> {
	return Object.fromEntries(
		LICENSE_SIGNING_KEYS.filter((key) => key.status !== LicenseKeyStatus.Revoked).map((key) => [
			key.kid,
			key.publicKeyPEM,
		])
	)
}

/**
 * The shape of the well-known file at `/.well-known/mailwoman/license-keys.json`.
 */
export interface PublishedLicenseKeys {
	format: "mailwoman-license-keys/1"
	$comment: string
	keys: Array<{
		kid: string
		algorithm: "Ed25519"
		publicKey: string
		majorVersions: number[]
		status: LicenseKeyStatus
	}>
}

const WELL_KNOWN_COMMENT =
	"The public halves of the commercial license signing keys, by key id, with each key's status. `mailwoman doctor --online` and `mailwoman license verify --online` read this to confirm a configured key's id is still active; offline verification uses the same keys shipped in @mailwoman/core/license. This file is derived from packages/core/lib/license/register.ts by `mailwoman license register --write`; edit the register, not this file."

export function publishedLicenseKeys(): PublishedLicenseKeys {
	return {
		format: "mailwoman-license-keys/1",
		$comment: WELL_KNOWN_COMMENT,
		keys: LICENSE_SIGNING_KEYS.map((key) => ({
			kid: key.kid,
			algorithm: "Ed25519",
			publicKey: key.publicKeyPEM,
			majorVersions: [...key.majorVersions],
			status: key.status,
		})),
	}
}
```

Delete `packages/core/lib/license/trusted-keys.ts` (`git rm`). In `publication.ts`, delete the local `PublishedLicenseKeys` interface and add `import type { PublishedLicenseKeys } from "#license/register"`; `confirmLicenseKeyPublished` now reads `entry.status`, which has three values: `active` → `listed`, anything else → `retired` (the `LicenseKeyPublication` vocabulary stays). In `index.ts` replace `export * from "#license/trusted-keys"` with `export * from "#license/register"`.

Add to `packages/core/package.json` `exports`, beside `./license/publication`:

```json
		"./license/key": {
			"node": "./lib/license/key.ts",
			"default": "./out/license/key.js",
			"types": "./out/license/key.d.ts"
		},
		"./license/register": {
			"node": "./lib/license/register.ts",
			"default": "./out/license/register.js",
			"types": "./out/license/register.d.ts"
		},
```

- [ ] **Step 4: Regenerate the well-known JSON from the register**

The `register` CLI action arrives in Task 5; for now write the file with a scratchpad script that prints `JSON.stringify(publishedLicenseKeys(), null, "\t")` to `docs/static/.well-known/mailwoman/license-keys.json`. Diff it against the committed file: the only changes should be the `$comment` text and key order; `kid`, `publicKey`, `majorVersions`, `status` are identical.

- [ ] **Step 5: Run the tests**

Run: `yarn vitest run packages/core/test/unit/license/register.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
yarn oxlint packages/core/lib/license
git add packages/core/lib/license packages/core/package.json packages/core/test/unit/license/register.test.ts docs/static/.well-known/mailwoman/license-keys.json
git commit -m "feat(core): one typed register of signing keys derives both the shipped trust map and the well-known JSON

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 4: Every caller awaits — `configured.ts`, the stamp resolver, the doctor, and their tests

**Files:**

- Modify: `packages/core/lib/license/configured.ts`
- Modify: `packages/mailwoman/lib/cli-kit/engine-stamp.ts`
- Modify: `packages/mailwoman/lib/doctor/runner.ts`
- Modify: `packages/mailwoman/test/unit/doctor/runner.test.ts`, `packages/core/test/unit/license/stamp.test.ts`
- Test: the existing suites

- [ ] **Step 1: Make `verifyConfiguredLicenseKey` async on the register**

```ts
// packages/core/lib/license/configured.ts — body
import { $public } from "#env"
import { verifyLicenseKey, type LicenseKeyVerification } from "#license/key"
import { trustedLicenseSigningKeys } from "#license/register"

/**
 * Verify `MAILWOMAN_LICENSE_KEY` offline, or `undefined` when none is configured.
 */
export async function verifyConfiguredLicenseKey(now?: Date): Promise<LicenseKeyVerification | undefined> {
	const token = $public.MAILWOMAN_LICENSE_KEY

	if (!token) return undefined

	return await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys(), ...(now ? { now } : {}) })
}
```

- [ ] **Step 2: Await it in the stamp resolver**

In `packages/mailwoman/lib/cli-kit/engine-stamp.ts`, `resolveEngineStamp` becomes:

```ts
export function resolveEngineStamp(): Promise<ResolvedEngineStamp> {
	resolved ??= (async () => {
		const [manifest, key] = await Promise.all([readMailwomanManifest(), verifyConfiguredLicenseKey()])
		const stamp = buildEngineStamp({ version: manifest.version, expression: manifest.license, key })

		return { stamp, key }
	})()

	return resolved
}
```

- [ ] **Step 3: Await it in the doctor**

In `packages/mailwoman/lib/doctor/runner.ts`: the deps interface line `licenseKey(): LicenseKeyVerification | undefined` becomes `licenseKey(): Promise<LicenseKeyVerification | undefined>`; the wiring `licenseKey: () => verifyConfiguredLicenseKey()` is unchanged in text; the call site `const key = deps.licenseKey()` becomes `const key = await deps.licenseKey()`.

In `packages/mailwoman/test/unit/doctor/runner.test.ts`, every `licenseKey: () => X` becomes `licenseKey: async () => X` (five sites at the lines the grep in this plan's preparation found: 54, 215, 252, 264, 278; re-grep, the numbers move).

- [ ] **Step 4: Fix the stamp test's key fixtures**

In `packages/core/test/unit/license/stamp.test.ts`, the module-level `pair`, `kid`, `token`, `valid`, `expired`, `unknownKey`, `invalid` become top-level `await`s of the async functions (vitest supports top-level await in ESM test files; `key.test.ts` in Task 2 already does this).

- [ ] **Step 5: Run the affected suites**

Run: `yarn vitest run packages/core/test/unit/license packages/mailwoman/test/unit/cli-kit packages/mailwoman/test/unit/doctor packages/mailwoman/test/unit/cli-launcher.test.ts`
Expected: PASS. The launcher test spawns the compiled CLI, so run `yarn compile` first; the CLI still reads `unknown_key` for a test token and prints the notice.

- [ ] **Step 6: Commit**

```bash
yarn oxlint packages/core/lib/license/configured.ts packages/mailwoman/lib/cli-kit/engine-stamp.ts packages/mailwoman/lib/doctor/runner.ts packages/mailwoman/test/unit/doctor/runner.test.ts packages/core/test/unit/license/stamp.test.ts
git add packages/core/lib/license/configured.ts packages/mailwoman/lib/cli-kit/engine-stamp.ts packages/mailwoman/lib/doctor/runner.ts packages/mailwoman/test/unit/doctor/runner.test.ts packages/core/test/unit/license/stamp.test.ts
git commit -m "refactor(license): every caller awaits the WebCrypto verifier — the configured key, the stamp resolver, the doctor

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 5: The `license` command — async, register-backed, and a `register` action

**Files:**

- Modify: `packages/mailwoman/lib/cli-native/commands/license.ts`
- Test: `packages/mailwoman/test/integration/license-cli.test.ts` (create)

**Interfaces produced:** `mailwoman license register [--write] [--json]` — prints the derived well-known JSON, or writes it to `docs/static/.well-known/mailwoman/license-keys.json` under the repo root.

- [ ] **Step 1: Write the failing CLI test**

```ts
// packages/mailwoman/test/integration/license-cli.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman license` end to end on the compiled CLI: keygen into a scratch config root, issue against a register
 *   that does not carry the new key (refused), verify a token, and `register` printing the derivation.
 */

import {
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	publishedLicenseKeys,
} from "@mailwoman/core/license"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { workspacePath } from "@mailwoman/core/paths"
import { isProcessError, runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { makeTemporaryDirectory } from "@mailwoman/core/fs/temporary"
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
		const { stdout } = await cli(["register", "--json"])

		expect(parseJSONStrict(stdout)).toEqual(publishedLicenseKeys())
	})

	test("keygen mints a pair under the config root and issue refuses a key the register does not carry", async () => {
		await using scratch = await makeTemporaryDirectory("license-cli")
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
```

Check that `makeTemporaryDirectory` is the name `@mailwoman/core/fs/temporary` exports (`grep -n "^export" packages/core/lib/fs/temporary.ts`); use whatever the module names, and its disposal idiom.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn compile && yarn vitest run packages/mailwoman/test/integration/license-cli.test.ts`
Expected: the `register` test FAILS (unknown action); the other two may fail on the compile of `license.ts` against the async API. Fix compile first: it is the next step.

- [ ] **Step 3: Update the command**

In `packages/mailwoman/lib/cli-native/commands/license.ts`:

- Imports: drop `TRUSTED_LICENSE_SIGNING_KEYS`; add `publishedLicenseKeys, trustedLicenseSigningKeys` from `@mailwoman/core/license`; add `repoRootPath` from `@mailwoman/core/paths` and `writeLocalTextFile` is already imported.
- `keygen`: `const pair = await generateLicenseSigningKeyPair()`; `const kid = await licenseKeyID(pair.publicKeyPEM, major)`; the printed instructions become:

```ts
				"Register the public key, then regenerate the well-known file:",
				"  1. packages/core/lib/license/register.ts — add an entry with status \"active\"",
				"  2. mailwoman license register --write",
```

- `issue`: `Object.entries(trustedLicenseSigningKeys()).find(...)`; the refusal message reads `…is not in this build's register (packages/core/lib/license/register.ts), so a key it signs would verify nowhere. Add it and rebuild first.`; `const token = await encodeLicenseKey(payload, privateKeyPEM)`.
- `verifyCommand`: `const verification = await verifyLicenseKey(token, { trustedKeys: trustedLicenseSigningKeys() })`.
- New action:

```ts
async function registerCommand(parsed: ParsedCommand): Promise<number> {
	const document = `${JSON.stringify(publishedLicenseKeys(), null, "\t")}\n`

	if (booleanValue(parsed.values, "write")) {
		const target = repoRootPath("docs", "static", ".well-known", "mailwoman", "license-keys.json")

		await writeLocalTextFile(document, target)
		process.stdout.write(`wrote ${target}\n`)

		return 0
	}

	process.stdout.write(document)

	return 0
}
```

Add `write: { type: "boolean", default: false, description: "register: write the well-known file under docs/static instead of printing it." }` to the options, `register` to the positional description and the `switch`. `--json` on `register` is accepted and prints the same document (the document IS JSON).

- [ ] **Step 4: Compile, run the CLI test, and regenerate the well-known file through the command**

Run: `yarn compile && yarn vitest run packages/mailwoman/test/integration/license-cli.test.ts`
Expected: PASS, 3 tests.

Run: `node packages/mailwoman/out/cli.js license register --write && git diff --stat docs/static`
Expected: no diff (Task 3's scratch write already matched the derivation).

- [ ] **Step 5: Commit**

```bash
yarn oxlint packages/mailwoman/lib/cli-native/commands/license.ts packages/mailwoman/test/integration/license-cli.test.ts
git add packages/mailwoman/lib/cli-native/commands/license.ts packages/mailwoman/test/integration/license-cli.test.ts packages/mailwoman/man docs/articles/developers/reference/cli.mdx
git commit -m "feat(cli): license keygen, issue and verify on the WebCrypto key; license register prints or writes the well-known file

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

(The pre-commit hook regenerates the CLI reference page and the man page for the new action; stage what it writes.)

---

### Task 6: The health check — the committed well-known JSON equals the register

**Files:**

- Create: `packages/repo-health/lib/checks/license-register.ts`
- Modify: `packages/repo-health/lib/registry.ts`
- Test: `packages/repo-health/test/unit/license-register.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/repo-health/test/unit/license-register.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { licenseRegisterCheck } from "@mailwoman/repo-health/checks/license-register"
import { expect, test } from "vitest"

test("license-register: the committed well-known file equals the register's derivation", async () => {
	const diagnostics = await licenseRegisterCheck.run({ repoRoot: String(repoRootPath()) })

	expect(diagnostics).toEqual([])
})
```

Match the `context` shape to what `versionSyncCheck.run(context)` receives (`grep -n "interface.*Context" packages/repo-health/lib/check.ts`), and the import path to how the registry imports checks (`#checks/version-sync` inside the package; from the test use the package's exported subpath, or `#checks/…` if the test tsconfig maps it — copy whichever an existing repo-health test does).

- [ ] **Step 2: Run to verify it fails**

Run: `yarn vitest run packages/repo-health/test/unit/license-register.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the check and register it**

```ts
// packages/repo-health/lib/checks/license-register.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Refuse a tree whose committed well-known key register differs from the typed register it derives from. The doctor
 *   and `license verify --online` read the committed file from mailwoman.ai; the shipped trust map reads the typed
 *   register; a difference between them is a key that one side trusts and the other does not.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { publishedLicenseKeys } from "@mailwoman/core/license"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

const WELL_KNOWN_FILE = "docs/static/.well-known/mailwoman/license-keys.json"

export const licenseRegisterCheck: RepoCheck = {
	id: "license-register",
	description: "The committed well-known license-key file equals the typed register's derivation.",
	async run(context) {
		const committed = await readLocalJSONFile<unknown>(resolvePath(context.repoRoot, WELL_KNOWN_FILE))
		const derived = publishedLicenseKeys()
		const diagnostics: Diagnostic[] = []

		if (JSON.stringify(committed) !== JSON.stringify(derived)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${WELL_KNOWN_FILE} differs from packages/core/lib/license/register.ts — run \`mailwoman license register --write\``,
				file: WELL_KNOWN_FILE,
			})
		}

		return diagnostics
	},
}
```

In `registry.ts`, import `licenseRegisterCheck` from `#checks/license-register` and add it to the checks list beside `versionSyncCheck`. If the repo-health package does not yet depend on `@mailwoman/core` for the `license` subpath (it depends on core already for `fs/readers`), nothing to add. Add the export subpath for `./checks/license-register` if the test imports it that way and sibling checks are exported so.

- [ ] **Step 4: Run the test and the health command**

Run: `yarn vitest run packages/repo-health/test/unit/license-register.test.ts && yarn mwops health all 2>&1 | tail -5`
Expected: PASS; `health all` lists `license-register` among its checks with no diagnostics.

- [ ] **Step 5: Commit**

```bash
git add packages/repo-health
git commit -m "feat(repo-health): license-register refuses a well-known file that differs from the typed register

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 7: The worker bundle test — the two subpaths carry no `node:` specifier under Worker conditions

**Files:**

- Modify: `packages/core/package.json` (`esbuild` devDependency, `0.28.2` as in `@mailwoman/neural`)
- Create: `packages/core/test/integration/worker-bundle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/integration/worker-bundle.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The license key's two subpaths must bundle for a Cloudflare Worker with no Node builtin in the graph. Wrangler
 *   resolves `exports` under the `workerd`, `worker` and `browser` conditions before `default`; this test bundles the
 *   same way and reads the import list. A `node:` specifier here is a core module that leaked onto the worker's path,
 *   and the fix is a platform-neutral implementation or a conditional export, never a shim in the worker.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { build } from "esbuild"
import { expect, test } from "vitest"

const ENTRY = [
	'export { encodeLicenseKey, verifyLicenseKey, licenseKeyID } from "@mailwoman/core/license/key"',
	'export { trustedLicenseSigningKeys, publishedLicenseKeys } from "@mailwoman/core/license/register"',
].join("\n")

test("@mailwoman/core/license/key and /register bundle for a Worker with no node: import", async () => {
	const result = await build({
		stdin: {
			contents: ENTRY,
			resolveDir: String(resolvePackagePath("@mailwoman/core")),
			sourcefile: "worker-entry.ts",
			loader: "ts",
		},
		bundle: true,
		format: "esm",
		platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		target: "es2022",
		write: false,
		metafile: true,
		logLevel: "silent",
	})

	const inputs = Object.keys(result.metafile.inputs)
	const nodeImports = Object.values(result.metafile.inputs)
		.flatMap((input) => input.imports)
		.map((entry) => entry.path)
		.filter((path) => path.startsWith("node:"))

	expect(nodeImports, `node builtins reached from the worker entry:\n${nodeImports.join("\n")}`).toEqual([])
	expect(inputs.some((path) => path.includes("lib/license/key.ts") || path.includes("out/license/key.js"))).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails or passes for the right reason**

Run: `yarn workspace @mailwoman/core add -D esbuild@0.28.2 && yarn vitest run packages/core/test/integration/worker-bundle.test.ts`

Expected: PASS if Tasks 1 to 3 left the graph clean, FAIL naming the module otherwise. If it names `packages/core/lib/objects.ts` reaching `spliterator` and that in turn reaching `node:`, the fix is a `#json/strict.ts` module holding `parseJSONStrict` alone (the function has no Node dependency; the shelf it sits on does) and `key.ts` importing that. If it names `#errors/schema`, the same move. Record the module the test named in the commit message.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json yarn.lock packages/core/test/integration/worker-bundle.test.ts
git commit -m "test(core): the license key's subpaths bundle for a Worker under the workerd/worker/browser conditions with no node: import

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 8: CHANGELOG, the full check, and the PR

- [ ] **Step 1: CHANGELOG**

Under `## Unreleased`, add:

```markdown
### Changed — the license key signs and verifies on WebCrypto

`encodeLicenseKey`, `verifyLicenseKey`, `licenseKeyID`, `generateLicenseSigningKeyPair` and `verifyConfiguredLicenseKey`
answer promises; Ed25519 and the key-id digest run on `crypto.subtle`, so the same module serves Node, a Cloudflare
Worker and a browser. Tokens are unchanged: a key signed by the previous implementation verifies, and the same key and
payload sign to the same bytes. The payload gains two optional fields a self-service issuer sets, `lid` and
`agreement`. `TRUSTED_LICENSE_SIGNING_KEYS` is replaced by the typed register in `@mailwoman/core/license/register`
(`LICENSE_SIGNING_KEYS`, `trustedLicenseSigningKeys()`, `publishedLicenseKeys()`), which also produces the well-known
file; `mailwoman license register --write` regenerates it and the `license-register` health check refuses drift. The
`./license/key` and `./license/register` subpaths are the Worker-safe imports; the four Ed25519 helpers leave
`@mailwoman/core/hash`.
```

- [ ] **Step 2: Full check**

```bash
yarn compile
yarn typecheck:tests
yarn lint
yarn vitest run packages/core/test packages/mailwoman/test/unit/cli-kit packages/mailwoman/test/unit/doctor packages/mailwoman/test/unit/cli-launcher.test.ts packages/mailwoman/test/integration/license-cli.test.ts packages/mailwoman/test/integration/openapi-cli.test.ts packages/repo-health/test
```

Then `yarn test` alone, with nothing else running, and read the failures against the log rather than the exit code: model-loading suites time out under machine load and pass alone.

- [ ] **Step 3: Measure the launcher**

```bash
node --import /tmp/claude-1000/-home-lab-Projects-mailwoman/dc5b25ae-2f59-4cfe-a00a-391f0b430ece/scratchpad/count-modules.mjs packages/mailwoman/out/cli.js --version 2>&1 >/dev/null | grep -E "^COUNT="
```

Update `MEASURED_MODULE_COUNT` in `packages/mailwoman/test/unit/module-count.test.ts` to the number; it should move by a handful (the `crypto/` modules in, `node:crypto` out of the license path).

- [ ] **Step 4: Commit, push, PR**

```bash
git add CHANGELOG.md packages/mailwoman/test/unit/module-count.test.ts
git commit -m "docs(changelog): the license key on WebCrypto, the typed register, and the Worker-safe subpaths

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
git push -u origin feat/license-key-webcrypto
```

Open the PR against `main` with the template, the spec linked, and the session link as the last line. The PR closes the issue B task list on the tracking issue created at execution start (task-intake).
