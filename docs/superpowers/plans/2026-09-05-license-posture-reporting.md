# License Posture Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every mailwoman output that leaves the process says which license branch produced it: a two-line stderr notice from the CLI and the servers, an `engine` object in JSON bodies, and `Server` + `Link: rel="license"` headers on every HTTP response.

**Architecture:** One pure function in `@mailwoman/core/license` builds an `EngineStamp` from the package version and the offline key verification. The `mailwoman` package resolves that stamp once per process and hands it to the launcher, the four JSON-emitting commands, and each HTTP app as an option. `@mailwoman/api-kit` owns the header middleware and the zod schema for the stamp; each app attaches the body field where its protocol has room for one.

**Tech Stack:** TypeScript under Node (type stripping, `.ts` imports), zod 4, Hono + `@hono/zod-openapi`, vitest, Docusaurus for the one docs page.

**Spec:** `docs/superpowers/specs/2026-09-05-license-posture-reporting-design.md`

## Global Constraints

- The runtime does not change: no code path refuses work for want of a key. The stamp and notice REPORT.
- The stamp never carries `licensee` or `kid`. Tests assert this by key enumeration.
- The stamp is offline: it reads `verifyConfiguredLicenseKey()` and never the well-known register. A network call per process for a stamp is out of scope; the doctor owns the freshness check.
- Wire keys are snake_case: `license_url`. TypeScript identifiers cap acronyms whole: `docsURL`, `licenseURL`, `EngineStamp`.
- `node:*` imports are refused outside `@mailwoman/core` by `oxlint.config.ts`. File reads go through `@mailwoman/core/fs/readers`; process spawns through `@mailwoman/core/process`.
- Relative imports carry `.ts`; sibling modules inside a package go through the `#` imports map (`#license/key`), never `../`.
- No `enum`; `const X = {…} as const`.
- Comments state invariants, not history. No dates, PR numbers, or "added for" in a comment.
- The launcher `packages/mailwoman/lib/cli.ts` keeps ONE static import. Everything new there arrives by dynamic import after dispatch.
- The `mailwoman` package may depend on `@mailwoman/api`, `@mailwoman/api-kit`, and the drop-ins. NONE of those may depend on `mailwoman`. The stamp crosses that boundary as an option value, never as an import.
- Run `yarn compile` before any test that spawns the compiled CLI (`out/cli.js`). The pre-commit hook runs the compiled CLI too.
- Every prose file (spec, CHANGELOG, docs page) passes `node_modules/@vvago/vale/bin/vale --config docs/.vale-vocab.ini <file>`.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg`.
- Work happens on branch `feat/license-posture-reporting` in the worktree `.claude/worktrees/license-posture`. Never `cd` to the main checkout.

---

## File map

| File                                                                                                     | Responsibility                                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/core/lib/license/stamp.ts` (create)                                                            | `EngineStamp`, `buildEngineStamp`, `licenseNoticeLines`, `licensePageURL` — pure |
| `packages/core/lib/license/index.ts` (modify)                                                            | re-export `#license/stamp`                                                       |
| `packages/core/test/unit/license/stamp.test.ts` (create)                                                 | the pure function's tests                                                        |
| `packages/mailwoman/lib/cli-kit/engine-stamp.ts` (create)                                                | `resolveEngineStamp()` memoized per process, `printLicenseNotice()`              |
| `packages/mailwoman/package.json` (modify)                                                               | `./cli-kit/engine-stamp` export                                                  |
| `packages/mailwoman/lib/cli.ts` (modify)                                                                 | print the notice after dispatch                                                  |
| `packages/mailwoman/test/unit/cli-launcher.test.ts` (modify)                                             | stderr carries the notice, stdout is the bare version                            |
| `packages/mailwoman/lib/cli-native/commands/{geocode,reverse,autocomplete}.ts` (modify)                  | attach `engine` to JSON output                                                   |
| `packages/api-kit/lib/engine-stamp.ts` (create)                                                          | `EngineStampSchema` (zod) and `engineHeaders(stamp)` middleware                  |
| `packages/api-kit/lib/index.ts` (modify)                                                                 | re-export                                                                        |
| `packages/api-kit/test/unit/engine-stamp.test.ts` (create)                                               | header middleware test                                                           |
| `packages/api/lib/{app,routes,schema}.ts` (modify)                                                       | option, headers, body field, OpenAPI                                             |
| `packages/api/test/unit/index.test.ts` (modify)                                                          | body + header assertions                                                         |
| `packages/nominatim/lib/{app,routes,schema}.ts` (modify)                                                 | option, headers, per-result field                                                |
| `packages/photon/lib/{app,routes,engine}.ts` (modify)                                                    | option, headers, collection foreign member                                       |
| `packages/libpostal/lib/app.ts` (modify)                                                                 | option, headers only                                                             |
| `packages/{nominatim,photon,libpostal}/lib/cli.ts`, `packages/mailwoman/lib/commands/serve.tsx` (modify) | resolve the stamp, pass it, print the notice at listen                           |
| `docs/src/pages/license.mdx` (create)                                                                    | the `/license` page                                                              |
| `CHANGELOG.md` (modify)                                                                                  | Added + Changed entries                                                          |

Three decisions recorded here that refine the spec:

1. `mailwoman parse --format json` gets NO body stamp. Its default projection (`decodeAsJSON`) is a flat `tag → value` map that consumers iterate as tags, so a foreign key would read as a tag. The stderr notice covers the command. The spec's placement table listed parse; this plan overrides that row.
2. The server-start notice is printed by each server's own `onListen` callback (the four `cli.ts` entry points and `mailwoman serve`), not by `serveNode`. `serveNode` stays a listener wrapper with no knowledge of the stamp, and the code that prints is the same `printLicenseNotice` the launcher uses.
3. The stamp is offline. The spec says a `retired` key reads as the open-source branch; a retired reading needs the well-known register, which the stamp never consults. A retired key whose signature still verifies stamps `LicenseRef-Commercial` until the release that removes its public key; the doctor's `--online` check is where retirement is reported. This is the asymmetry `packages/core/lib/license/trusted-keys.ts` already documents.

---

### Task 1: The pure stamp in `@mailwoman/core/license`

**Files:**

- Create: `packages/core/lib/license/stamp.ts`
- Modify: `packages/core/lib/license/index.ts`
- Test: `packages/core/test/unit/license/stamp.test.ts`

**Interfaces:**

- Consumes: `chooseLicenseBranch` (`#license/obligations`), `LicenseKeyVerification` (`#license/key`).
- Produces:

  ```ts
  export interface EngineStamp {
  	name: "mailwoman"
  	version: string
  	license: string
  	license_url: string
  	notice?: string
  }
  export const DEFAULT_DOCS_URL = "https://mailwoman.ai"
  export const LICENSE_PAGE_PATH = "/license"
  export function licensePageURL(docsURL?: string): string
  export function buildEngineStamp(input: {
  	version: string
  	expression: string
  	key?: LicenseKeyVerification
  	docsURL?: string
  }): EngineStamp
  export function licenseNoticeLines(stamp: EngineStamp, key?: LicenseKeyVerification): [string, string] | undefined
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/unit/license/stamp.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	buildEngineStamp,
	encodeLicenseKey,
	generateLicenseSigningKeyPair,
	licenseKeyID,
	type LicenseKeyPayload,
	licenseNoticeLines,
	licensePageURL,
	verifyLicenseKey,
} from "@mailwoman/core/license"
import { describe, expect, it } from "vitest"

const EXPRESSION = "AGPL-3.0-only OR LicenseRef-Commercial"
const pair = generateLicenseSigningKeyPair()
const kid = licenseKeyID(pair.publicKeyPEM, 9)
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

const token = encodeLicenseKey(payload, pair.privateKeyPEM)
const valid = verifyLicenseKey(token, { trustedKeys, now: new Date("2027-01-01T00:00:00Z") })
const expired = verifyLicenseKey(token, { trustedKeys, now: new Date("2027-09-04T00:00:00Z") })
const unknownKey = verifyLicenseKey(token, { trustedKeys: {}, now: new Date("2027-01-01T00:00:00Z") })
const invalid = verifyLicenseKey("mwl1.not.real", { trustedKeys })

describe("licensePageURL", () => {
	it("defaults to mailwoman.ai and strips a trailing slash", () => {
		expect(licensePageURL()).toBe("https://mailwoman.ai/license")
		expect(licensePageURL("http://localhost:3000/")).toBe("http://localhost:3000/license")
	})
})

describe("buildEngineStamp", () => {
	it("reads the open-source branch with a notice when no key is configured", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION })

		expect(stamp).toEqual({
			name: "mailwoman",
			version: "9.2.0",
			license: "AGPL-3.0-only",
			license_url: "https://mailwoman.ai/license",
			notice:
				"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source. A commercial license waives that obligation.",
		})
	})

	it("reads the commercial branch with no notice for a valid key", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: valid })

		expect(stamp.license).toBe("LicenseRef-Commercial")
		expect(stamp.notice).toBeUndefined()
	})

	it.each([
		["expired", expired],
		["unknown_key", unknownKey],
		["invalid", invalid],
	])("reads the open-source branch with a notice for a key that reads %s", (_status, key) => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

		expect(stamp.license).toBe("AGPL-3.0-only")
		expect(stamp.notice).toBeDefined()
	})

	it("never carries the licensee or the key id, whatever the key reads", () => {
		for (const key of [undefined, valid, expired, unknownKey, invalid]) {
			const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key })

			expect(Object.keys(stamp).sort()).toEqual(
				["license", "license_url", "name", "version", ...(stamp.notice ? ["notice"] : [])].sort()
			)
			expect(JSON.stringify(stamp)).not.toContain("Example Ltd")
			expect(JSON.stringify(stamp)).not.toContain(kid)
		}
	})

	it("honours a configured docs URL", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, docsURL: "http://localhost:3000/" })

		expect(stamp.license_url).toBe("http://localhost:3000/license")
	})
})

describe("licenseNoticeLines", () => {
	it("is two lines for the open-source branch, the second carrying the URL", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION })

		expect(licenseNoticeLines(stamp)).toEqual([
			"mailwoman is licensed AGPL-3.0-only: modified or network-served copies must offer their source.",
			"A commercial license waives that obligation: https://mailwoman.ai/license",
		])
	})

	it("names the expiry date when the configured key has expired", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: expired })

		expect(licenseNoticeLines(stamp, expired)?.[0]).toBe(
			"mailwoman is licensed AGPL-3.0-only (the configured license key expired on 2027-09-03): modified or network-served copies must offer their source."
		)
	})

	it("is absent for a valid key", () => {
		const stamp = buildEngineStamp({ version: "9.2.0", expression: EXPRESSION, key: valid })

		expect(licenseNoticeLines(stamp, valid)).toBeUndefined()
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/core/test/unit/license/stamp.test.ts`
Expected: FAIL — `buildEngineStamp` is not exported from `@mailwoman/core/license`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/core/lib/license/stamp.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine stamp: which mailwoman produced a response, and under which license branch. It rides in JSON bodies as
 *   `engine`, in two HTTP headers, and as a two-line stderr notice. It is built once per process from two inputs the
 *   doctor also reads — the package's license expression and the configured key's offline verification — so the doctor
 *   and every stamped output agree on the branch by construction.
 *
 *   The stamp carries no licensee and no key id. A deployment serving the public must not carry its operator's
 *   commercial relationship in every response; the doctor prints those two locally. It is offline: the well-known
 *   register is the doctor's freshness check, not a per-process network call.
 */

import type { LicenseKeyVerification } from "#license/key"
import { chooseLicenseBranch } from "#license/obligations"

export const DEFAULT_DOCS_URL = "https://mailwoman.ai"

/**
 * The page the notice and the `Link: rel="license"` header point at. Singular, matching `license_url` and the `license`
 * command.
 */
export const LICENSE_PAGE_PATH = "/license"

/**
 * The obligation the notice states, in the doctor's vocabulary: the AGPL source offer to network users, which is the
 * one a network deployment carries and the one the commercial agreement waives.
 */
const NOTICE_OBLIGATION = "modified or network-served copies must offer their source."
const NOTICE_REMEDY = "A commercial license waives that obligation"

/**
 * What every stamped output carries. Snake-case keys: this is a wire shape.
 */
export interface EngineStamp {
	name: "mailwoman"
	version: string
	/**
	 * The license branch that applies to this installation: `AGPL-3.0-only`, or `LicenseRef-Commercial` when the
	 * configured key verifies.
	 */
	license: string
	license_url: string
	/**
	 * Present only when the open-source branch applies.
	 */
	notice?: string
}

export function licensePageURL(docsURL: string = DEFAULT_DOCS_URL): string {
	return `${docsURL.replace(/\/+$/u, "")}${LICENSE_PAGE_PATH}`
}

function noticeSentence(license: string, expiredOn?: string): string {
	const qualifier = expiredOn ? ` (the configured license key expired on ${expiredOn})` : ""

	return `mailwoman is licensed ${license}${qualifier}: ${NOTICE_OBLIGATION}`
}

/**
 * Build the stamp. `key` is the offline verification of the configured key, or absent when none is configured; only a
 * `valid` reading selects the commercial branch, the same rule `runtimeLicenseCheck` applies in the doctor.
 */
export function buildEngineStamp(input: {
	version: string
	expression: string
	key?: LicenseKeyVerification
	docsURL?: string
}): EngineStamp {
	const license = chooseLicenseBranch(input.expression, { commercialAgreement: input.key?.status === "valid" })
	const commercial = license.startsWith("LicenseRef-")

	return {
		name: "mailwoman",
		version: input.version,
		license,
		license_url: licensePageURL(input.docsURL),
		...(commercial ? {} : { notice: `${noticeSentence(license)} ${NOTICE_REMEDY}.` }),
	}
}

/**
 * The stderr notice: two lines, or nothing when the commercial branch applies. An expired key is the one reading whose
 * cause the notice states, because the date tells the operator what to do; every other failed reading leaves the
 * reason to `mailwoman doctor`.
 */
export function licenseNoticeLines(stamp: EngineStamp, key?: LicenseKeyVerification): [string, string] | undefined {
	if (!stamp.notice) return undefined

	const expiredOn = key?.status === "expired" ? key.payload.expires : undefined

	return [noticeSentence(stamp.license, expiredOn), `${NOTICE_REMEDY}: ${stamp.license_url}`]
}
```

Add to `packages/core/lib/license/index.ts`, keeping the existing four lines:

```ts
export * from "#license/stamp"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run packages/core/test/unit/license/stamp.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Lint and commit**

Run: `yarn oxlint packages/core/lib/license/stamp.ts packages/core/test/unit/license/stamp.test.ts` (or `yarn lint:oxlint` if the single-file form is not wired).

```bash
git add packages/core/lib/license/stamp.ts packages/core/lib/license/index.ts packages/core/test/unit/license/stamp.test.ts
git commit -m "feat(core): the engine stamp — which license branch produced a response, built once from the doctor's inputs

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 2: `resolveEngineStamp()` in the `mailwoman` package

**Files:**

- Create: `packages/mailwoman/lib/cli-kit/engine-stamp.ts`
- Modify: `packages/mailwoman/package.json` (the `exports` map, beside `./cli-kit/metadata` at line ~205)
- Test: `packages/mailwoman/test/unit/cli-kit/engine-stamp.test.ts`

**Interfaces:**

- Consumes: `readMailwomanManifest` (`#cli-kit/metadata`), `buildEngineStamp`, `licenseNoticeLines`, `verifyConfiguredLicenseKey` (`@mailwoman/core/license`), `$public.MAILWOMAN_DOCS_URL` (`@mailwoman/core/env`).
- Produces:

  ```ts
  export interface ResolvedEngineStamp {
  	stamp: EngineStamp
  	key?: LicenseKeyVerification
  }
  export function resolveEngineStamp(): Promise<ResolvedEngineStamp> // memoized per process
  export function printLicenseNotice(resolved: ResolvedEngineStamp, write?: (line: string) => void): void
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/mailwoman/test/unit/cli-kit/engine-stamp.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { printLicenseNotice, resolveEngineStamp } from "mailwoman/cli-kit/engine-stamp"
import { readMailwomanManifest } from "mailwoman/cli-kit/metadata"
import { describe, expect, it } from "vitest"

describe("resolveEngineStamp", () => {
	it("stamps the package's own version and a branch of its own license expression", async () => {
		const manifest = await readMailwomanManifest()
		const { stamp } = await resolveEngineStamp()

		expect(stamp.name).toBe("mailwoman")
		expect(stamp.version).toBe(manifest.version)
		expect(manifest.license?.split(/\s+OR\s+/u)).toContain(stamp.license)
		expect(stamp.license_url.endsWith("/license")).toBe(true)
	})

	it("answers the same object on every call", async () => {
		const first = await resolveEngineStamp()
		const second = await resolveEngineStamp()

		expect(second).toBe(first)
	})
})

describe("printLicenseNotice", () => {
	it("writes the two notice lines for the open-source branch and nothing for the commercial one", () => {
		const open = {
			stamp: {
				name: "mailwoman" as const,
				version: "0.0.0",
				license: "AGPL-3.0-only",
				license_url: "https://mailwoman.ai/license",
				notice: "x",
			},
		}
		const commercial = {
			stamp: {
				name: "mailwoman" as const,
				version: "0.0.0",
				license: "LicenseRef-Commercial",
				license_url: "https://mailwoman.ai/license",
			},
		}
		const written: string[] = []

		printLicenseNotice(open, (line) => written.push(line))
		expect(written).toHaveLength(2)
		expect(written[1]).toContain("https://mailwoman.ai/license")

		written.length = 0
		printLicenseNotice(commercial, (line) => written.push(line))
		expect(written).toEqual([])
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/mailwoman/test/unit/cli-kit/engine-stamp.test.ts`
Expected: FAIL — cannot resolve `mailwoman/cli-kit/engine-stamp`.

- [ ] **Step 3: Write the implementation and register the export**

```ts
// packages/mailwoman/lib/cli-kit/engine-stamp.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The process's engine stamp, resolved once. The `mailwoman` package is the one place that can read its own manifest
 *   AND the configured key, and the HTTP packages may not depend on it, so this module builds the stamp and the CLI
 *   entry points hand it to each app as an option value.
 */

import { $public } from "@mailwoman/core/env"
import {
	buildEngineStamp,
	type EngineStamp,
	type LicenseKeyVerification,
	licenseNoticeLines,
	verifyConfiguredLicenseKey,
} from "@mailwoman/core/license"

import { readMailwomanManifest } from "#cli-kit/metadata"

export interface ResolvedEngineStamp {
	stamp: EngineStamp
	/**
	 * The offline verification the stamp was built from, so the notice can name an expiry date.
	 */
	key?: LicenseKeyVerification
}

let resolved: Promise<ResolvedEngineStamp> | undefined

/**
 * Resolve the stamp for this process. Memoized: the manifest and the configured key do not change while a process
 * runs, and every stamped output must agree.
 */
export function resolveEngineStamp(): Promise<ResolvedEngineStamp> {
	resolved ??= readMailwomanManifest().then((manifest) => {
		const key = verifyConfiguredLicenseKey()
		const stamp = buildEngineStamp({
			version: manifest.version,
			expression: manifest.license ?? "AGPL-3.0-only OR LicenseRef-Commercial",
			...(key ? { key } : {}),
			...($public.MAILWOMAN_DOCS_URL ? { docsURL: $public.MAILWOMAN_DOCS_URL } : {}),
		})

		return { stamp, ...(key ? { key } : {}) }
	})

	return resolved
}

/**
 * Write the two-line notice, or nothing when the commercial branch applies. `write` defaults to stderr, which keeps
 * stdout machine-readable for every `--json` consumer.
 */
export function printLicenseNotice(
	resolvedStamp: ResolvedEngineStamp,
	write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): void {
	const lines = licenseNoticeLines(resolvedStamp.stamp, resolvedStamp.key)

	if (!lines) return

	for (const line of lines) write(line)
}
```

In `packages/mailwoman/package.json`, after the `./cli-kit/metadata` entry, add:

```json
		"./cli-kit/engine-stamp": {
			"node": "./lib/cli-kit/engine-stamp.ts",
			"default": "./out/cli-kit/engine-stamp.js",
			"types": "./out/cli-kit/engine-stamp.d.ts"
		},
```

Check `packages/mailwoman/package.json` for a `files` array or a knip/exports test that enumerates subpaths (`grep -n "cli-kit/metadata" packages/mailwoman/package.json packages/mailwoman/test -r`) and add the new subpath wherever `./cli-kit/metadata` appears.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run packages/mailwoman/test/unit/cli-kit/engine-stamp.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/mailwoman/lib/cli-kit/engine-stamp.ts packages/mailwoman/package.json packages/mailwoman/test/unit/cli-kit/engine-stamp.test.ts
git commit -m "feat(mailwoman): resolve the engine stamp once per process

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 3: The stderr notice from the CLI launcher

**Files:**

- Modify: `packages/mailwoman/lib/cli.ts` (the last line, `process.exitCode = await (...)`)
- Test: `packages/mailwoman/test/unit/cli-launcher.test.ts`

**Interfaces:**

- Consumes: `resolveEngineStamp`, `printLicenseNotice` (Task 2) by dynamic import of `#cli-kit/engine-stamp`.

- [ ] **Step 1: Write the failing test**

The existing `runCLI` helper returns stdout only on success (`execFileSync` with a piped stderr discards it), so the `--version` assertion survives the notice. Add a second helper that keeps both streams, and two tests:

```ts
// add to the imports at the top of packages/mailwoman/test/unit/cli-launcher.test.ts
import { runFile } from "@mailwoman/core/process"

// add inside describe("the CLI launcher", …)
it("prints the license notice on stderr and keeps stdout to the bare version", async () => {
	const { stdout, stderr } = await runFile("node", [CLI, "--version"], {
		env: { ...process.env, MAILWOMAN_LICENSE_KEY: "" },
	})

	expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
	expect(stderr).toContain("mailwoman is licensed AGPL-3.0-only")
	expect(stderr).toContain("/license")
})

it("prints the notice for a key this build does not trust", async () => {
	const { stderr } = await runFile("node", [CLI, "--version"], {
		env: { ...process.env, MAILWOMAN_LICENSE_KEY: "mwl1.eyJ2IjoxfQ.AAAA" },
	})

	expect(stderr).toContain("mailwoman is licensed AGPL-3.0-only")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/mailwoman/test/unit/cli-launcher.test.ts`
Expected: the two new tests FAIL (stderr is empty); the three existing tests PASS.

- [ ] **Step 3: Print the notice after dispatch**

Replace the launcher's final line:

```ts
process.exitCode = await (rootVersionRequest ? printVersion() : dispatchCommand())
```

with:

```ts
const exitCode = await (rootVersionRequest ? printVersion() : dispatchCommand())

// The notice is the last thing written, for every command and every exit code, and it never changes the exit code:
// a failure to build it is reported on stderr and the command's own result stands.
try {
	const { printLicenseNotice, resolveEngineStamp } = await import("#cli-kit/engine-stamp")

	printLicenseNotice(await resolveEngineStamp())
} catch (error) {
	console.error(`[license] posture unavailable: ${error instanceof Error ? error.message : String(error)}`)
}

process.exitCode = exitCode
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run packages/mailwoman/test/unit/cli-launcher.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Compile and check the compiled CLI by hand**

Run: `yarn compile && node packages/mailwoman/out/cli.js --version 2>/dev/stdout`
Expected: three lines — the version, then the two notice lines.

- [ ] **Step 6: Commit**

```bash
git add packages/mailwoman/lib/cli.ts packages/mailwoman/test/unit/cli-launcher.test.ts
git commit -m "feat(cli): every invocation ends with the license notice on stderr

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 4: `engine` on the CLI's JSON records

**Files:**

- Modify: `packages/mailwoman/lib/cli-native/commands/geocode.ts` (`formatResult`, `runOne`, `runStdin`)
- Modify: `packages/mailwoman/lib/cli-native/commands/reverse.ts` (the `JSON.stringify` at ~line 116)
- Modify: `packages/mailwoman/lib/cli-native/commands/autocomplete.ts` (line ~48)
- Modify: `CHANGELOG.md` (Unreleased → Changed)
- Test: `packages/mailwoman/test/integration/reverse-cli.test.ts` (extend), `packages/mailwoman/test/unit/cli-native/` (new `json-stamp.test.ts` if the existing tests there do not already spawn `autocomplete`)

**Interfaces:**

- Consumes: `resolveEngineStamp` (Task 2).

- [ ] **Step 1: Read the existing integration test**

Run: `sed -n 1,60p packages/mailwoman/test/integration/reverse-cli.test.ts`
Note how it spawns the CLI and whether it skips without a gazetteer. Add the `engine` assertion inside the existing JSON test:

```ts
expect(body.engine).toMatchObject({
	name: "mailwoman",
	license: expect.stringMatching(/^(AGPL-3\.0-only|LicenseRef-Commercial)$/),
})
expect(body.engine).not.toHaveProperty("licensee")
```

If the file skips when the gazetteer is absent, keep that guard; the assertion runs wherever the test already runs.

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn vitest run packages/mailwoman/test/integration/reverse-cli.test.ts`
Expected: FAIL on `body.engine` (or SKIP if the gazetteer is absent — then proceed on the unit test below and hand-check in Step 6).

- [ ] **Step 3: Attach the stamp in `geocode.ts`**

Change `formatResult` to take the stamp and attach it on the `json` path only:

```ts
async function formatResult(
	result: GeocodeResult,
	format: Format,
	compact: boolean,
	stamp: EngineStamp
): Promise<string> {
	if (format === "text") {
		return formatText(result)
	}

	if (format === "jsonld") {
		// … unchanged: schema.org vocabulary, no foreign key …
	}

	return JSON.stringify({ ...result, engine: stamp }, null, compact ? 0 : 2)
}
```

Add `import type { EngineStamp } from "@mailwoman/core/license"` at the top. In `runOne` and `runStdin`, resolve once beside the session:

```ts
const { resolveEngineStamp } = await import("#cli-kit/engine-stamp")
const { stamp } = await resolveEngineStamp()
```

and pass `stamp` as the fourth argument to both `formatResult` calls.

- [ ] **Step 4: Attach the stamp in `reverse.ts` and wrap `autocomplete.ts`**

`reverse.ts`: before the `if (parsed.values.format === "text")` branch add

```ts
const { resolveEngineStamp } = await import("#cli-kit/engine-stamp")
const { stamp } = await resolveEngineStamp()
```

and add `engine: stamp,` as the last property of the object passed to `JSON.stringify`.

`autocomplete.ts`: replace the `output` line with

```ts
const { resolveEngineStamp } = await import("#cli-kit/engine-stamp")
const { stamp } = await resolveEngineStamp()
const output = booleanValue(parsed.values, "json")
	? JSON.stringify({ engine: stamp, entries }, null, 2)
	: formatAutocomplete(entries)
```

and change the `json` option description to `"Emit { engine, entries } as JSON instead of formatted text."`.

- [ ] **Step 5: Record the contract change**

In `CHANGELOG.md` under `## Unreleased`, add a `### Changed` section (or extend the existing one):

```markdown
### Changed — `mailwoman autocomplete --json` wraps its array

The command emitted a bare JSON array. It now emits `{ "engine": …, "entries": […] }`, so the record carries the
same `engine` stamp as `geocode --json` and `reverse --json`. Read `entries` where you read the array before.
```

- [ ] **Step 6: Compile and hand-check all three**

Run: `yarn compile`, then:

```bash
node packages/mailwoman/out/cli.js autocomplete new yo --json 2>/dev/null | head -12
node packages/mailwoman/out/cli.js reverse 51.5074 -0.1278 --format json 2>/dev/null | tail -8
node packages/mailwoman/out/cli.js geocode "10 Downing Street, London SW1A 2AA" --json 2>/dev/null | tail -8
node packages/mailwoman/out/cli.js geocode "10 Downing Street, London SW1A 2AA" --jsonld 2>/dev/null | grep -c '"engine"'
```

Expected: the first three end with an `engine` object; the last prints `0`.

- [ ] **Step 7: Run the tests and commit**

Run: `yarn vitest run packages/mailwoman/test/integration/reverse-cli.test.ts packages/mailwoman/test/unit/cli-native`
Expected: PASS.

```bash
git add packages/mailwoman/lib/cli-native/commands/geocode.ts packages/mailwoman/lib/cli-native/commands/reverse.ts packages/mailwoman/lib/cli-native/commands/autocomplete.ts packages/mailwoman/test CHANGELOG.md
git commit -m "feat(cli): geocode, reverse and autocomplete JSON records carry the engine stamp

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 5: `EngineStampSchema` and the header middleware in `@mailwoman/api-kit`

**Files:**

- Create: `packages/api-kit/lib/engine-stamp.ts`
- Modify: `packages/api-kit/lib/index.ts`
- Test: `packages/api-kit/test/unit/engine-stamp.test.ts`

**Interfaces:**

- Consumes: `EngineStamp` type (`@mailwoman/core/license`).
- Produces:

  ```ts
  export const EngineStampSchema: z.ZodType<EngineStamp> // .openapi("EngineStamp")
  export function engineHeaders(stamp: EngineStamp): MiddlewareHandler
  export function withEngineStamp<T extends object>(
  	body: T,
  	stamp: EngineStamp | undefined
  ): T | (T & { engine: EngineStamp })
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/api-kit/test/unit/engine-stamp.test.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import { engineHeaders, EngineStampSchema, withEngineStamp } from "@mailwoman/api-kit"
import type { EngineStamp } from "@mailwoman/core/license"
import { expect, test } from "vitest"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

function createPingApp(): OpenAPIHono {
	const app = new OpenAPIHono()

	app.use(engineHeaders(stamp))
	app.onError((_error, c) => c.json({ error: "internal error" }, 500))
	app.openapi(
		createRoute({
			method: "get",
			path: "/ping",
			responses: {
				200: { description: "pong", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } },
			},
		}),
		(c) => c.json({ ok: true }, 200)
	)
	app.get("/boom", () => {
		throw new Error("boom")
	})

	return app
}

test("engineHeaders: Server and Link ride on a 200", async () => {
	const res = await createPingApp().request("/ping")

	expect(res.status).toBe(200)
	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
	expect(res.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
})

test("engineHeaders: the headers ride on the error net's 500 too", async () => {
	const res = await createPingApp().request("/boom")

	expect(res.status).toBe(500)
	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
})

test("withEngineStamp: attaches the field when given a stamp and leaves the body alone otherwise", () => {
	expect(withEngineStamp({ a: 1 }, stamp)).toEqual({ a: 1, engine: stamp })
	expect(withEngineStamp({ a: 1 }, undefined)).toEqual({ a: 1 })
})

test("EngineStampSchema: accepts the stamp and refuses a licensee", () => {
	expect(EngineStampSchema.parse(stamp)).toEqual(stamp)
	expect(EngineStampSchema.safeParse({ ...stamp, licensee: "x" }).success).toBe(false)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/api-kit/test/unit/engine-stamp.test.ts`
Expected: FAIL — `engineHeaders` is not exported.

- [ ] **Step 3: Write the implementation**

```ts
// packages/api-kit/lib/engine-stamp.ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The engine stamp on the HTTP side: the zod schema every app documents it with, the two headers every response
 *   carries, and the helper that attaches the body field. The stamp itself is built by the `mailwoman` package and
 *   arrives as an option value, because the app packages may not depend on `mailwoman`.
 */

import { z } from "@hono/zod-openapi"
import type { EngineStamp } from "@mailwoman/core/license"
import type { MiddlewareHandler } from "hono"

/**
 * Strict on purpose: the stamp carries no licensee and no key id, and a strict object makes a field that leaks one a
 * schema failure rather than a documented extension.
 */
export const EngineStampSchema = z
	.strictObject({
		name: z.literal("mailwoman"),
		version: z.string(),
		license: z.string(),
		license_url: z.string(),
		notice: z.string().optional(),
	})
	.openapi("EngineStamp")

/**
 * `Server` names the engine and its license branch; `Link: rel="license"` is the registered relation (RFC 8288) that
 * lets a proxy, a browser, or `curl -I` find the terms without a body change. Set before the handler runs, so the
 * headers are on the context when any `c.json` — the route's or the error net's — builds its response.
 */
export function engineHeaders(stamp: EngineStamp): MiddlewareHandler {
	const server = `mailwoman/${stamp.version} (${stamp.license})`
	const link = `<${stamp.license_url}>; rel="license"`

	return async (c, next) => {
		c.header("Server", server)
		c.header("Link", link)

		await next()
	}
}

/**
 * Attach the `engine` field when a stamp is configured. The field goes LAST, so a body that already spells a key of
 * the same name keeps the stamp's value.
 */
export function withEngineStamp<T extends object>(
	body: T,
	stamp: EngineStamp | undefined
): T | (T & { engine: EngineStamp }) {
	return stamp ? { ...body, engine: stamp } : body
}
```

Add `export * from "#engine-stamp"` to `packages/api-kit/lib/index.ts`.

If the `/boom` test fails because Hono's `onError` builds its response on a fresh context, change the middleware to set the headers after `await next()` as well:

```ts
return async (c, next) => {
	c.header("Server", server)
	c.header("Link", link)

	await next()

	c.res.headers.set("Server", server)
	c.res.headers.set("Link", link)
}
```

and keep whichever form makes both header tests pass.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn vitest run packages/api-kit/test/unit/engine-stamp.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api-kit/lib/engine-stamp.ts packages/api-kit/lib/index.ts packages/api-kit/test/unit/engine-stamp.test.ts
git commit -m "feat(api-kit): the engine stamp's schema, response headers, and body helper

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 6: The native `/v1` API

**Files:**

- Modify: `packages/api/lib/app.ts` (`MailwomanAPIOptions`, `createMailwomanAPI`)
- Modify: `packages/api/lib/routes.ts` (`RegisterMailwomanAPIRoutesOptions`, the 200 responses of parse GET/POST, geocode, batch, resolve, format)
- Modify: `packages/api/lib/schema.ts` (`ParseOutcomeSchema`, `GeocodeOutcomeSchema`, `BatchResponseSchema`, `ResolveResponseSchema`, `FormatResponseSchema`)
- Test: `packages/api/test/unit/index.test.ts`

**Interfaces:**

- Consumes: `EngineStampSchema`, `engineHeaders`, `withEngineStamp` (Task 5).
- Produces: `MailwomanAPIOptions.engine?: EngineStamp`; `RegisterMailwomanAPIRoutesOptions.engine?: EngineStamp`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/api/test/unit/index.test.ts`, after the `fullEngine` fixture:

```ts
import type { EngineStamp } from "@mailwoman/core/license"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

// MARK: engine stamp

test("engine option: every /v1 body carries `engine` and every response carries the two headers", async () => {
	const app = createMailwomanAPI(fullEngine, { engine: stamp })
	const post = (path: string, body: unknown) =>
		app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

	for (const res of [
		await post("/v1/parse", { address: "1600 Pennsylvania Ave NW" }),
		await post("/v1/geocode", { address: "1600 Pennsylvania Ave NW" }),
		await post("/v1/resolve", { tree: { raw: "x", roots: [] } }),
		await post("/v1/format", { components: { house_number: "1600", road: "Pennsylvania Ave NW" }, country: "US" }),
	]) {
		expect(res.status).toBe(200)
		expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
		expect(res.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
		expect(((await res.json()) as { engine: EngineStamp }).engine).toEqual(stamp)
	}

	const health = await app.request("/health")
	expect(health.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
	expect((await health.json()) as object).not.toHaveProperty("engine")
})

test("engine option: /v1/batch stamps the envelope once, not the rows", async () => {
	const app = createMailwomanAPI(fullEngine, { engine: stamp })
	const res = await app.request("/v1/batch", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ addresses: ["a", "b"] }),
	})
	const body = (await res.json()) as { engine: EngineStamp; results: object[] }

	expect(body.engine).toEqual(stamp)
	expect(body.results).toHaveLength(2)
	for (const row of body.results) expect(row).not.toHaveProperty("engine")
})

test("no engine option: no `engine` field and no headers", async () => {
	const app = createMailwomanAPI(fullEngine)
	const res = await app.request("/v1/parse", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ address: "1600 Pennsylvania Ave NW" }),
	})

	expect(res.headers.get("server")).toBeNull()
	expect(res.headers.get("link")).toBeNull()
	expect((await res.json()) as object).not.toHaveProperty("engine")
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn vitest run packages/api/test/unit/index.test.ts`
Expected: the three new tests FAIL; the rest PASS.

- [ ] **Step 3: Thread the option through app and routes**

`packages/api/lib/app.ts`: add to `MailwomanAPIOptions`

```ts
	/**
	 * The engine stamp to carry on every response: `engine` in each `/v1` body and the `Server` + `Link: rel="license"`
	 * headers everywhere. Absent when an embedding application builds the app without the `mailwoman` package; the
	 * `mailwoman serve` command always passes one.
	 */
	engine?: EngineStamp
```

with `import type { EngineStamp } from "@mailwoman/core/license"` and `engineHeaders` added to the existing `@mailwoman/api-kit` import. In `createMailwomanAPI`, directly after the CORS block:

```ts
if (options.engine) {
	app.use(engineHeaders(options.engine))
}
```

and pass it on: `registerMailwomanAPIRoutes(app, engine, { batchMax: …, ...(options.engine ? { engine: options.engine } : {}) })`.

`packages/api/lib/routes.ts`: add `engine?: EngineStamp` to `RegisterMailwomanAPIRoutesOptions` (import the type), add `withEngineStamp` to the `@mailwoman/api-kit` import, and at the top of `registerMailwomanAPIRoutes`:

```ts
const stamp = options.engine
```

Then wrap the six success bodies:

| Line (approx.) | Before                                                                | After                                                                                         |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 274            | `return c.json(outcome, 200)` (parse GET)                             | `return c.json(withEngineStamp(outcome, stamp), 200)`                                         |
| 293            | `return c.json(outcome, 200)` (parse POST)                            | `return c.json(withEngineStamp(outcome, stamp), 200)`                                         |
| 320            | `return c.json(outcome as GeocodeOutcome, 200)`                       | `return c.json(withEngineStamp(outcome as GeocodeOutcome, stamp), 200)`                       |
| 342            | `return c.json({ results: [] }, 200)`                                 | `return c.json(withEngineStamp({ results: [] }, stamp), 200)`                                 |
| 364            | `return c.json(outcome as z.infer<typeof BatchResponseSchema>, 200)`  | `return c.json(withEngineStamp(outcome as z.infer<typeof BatchResponseSchema>, stamp), 200)`  |
| 393            | `return c.json(outcome, 200)` (resolve)                               | `return c.json(withEngineStamp(outcome, stamp), 200)`                                         |
| 417            | `return c.json({ formatted, canonicalKey: canonicalKey(dict) }, 200)` | `return c.json(withEngineStamp({ formatted, canonicalKey: canonicalKey(dict) }, stamp), 200)` |

`/health`, `/metrics`, `/reload` are unchanged.

- [ ] **Step 4: Document the field in the OpenAPI schemas**

In `packages/api/lib/schema.ts`, import `EngineStampSchema` from `@mailwoman/api-kit` and add `engine: EngineStampSchema.optional()` to `ParseOutcomeSchema`, `BatchResponseSchema`, `ResolveResponseSchema`, and `FormatResponseSchema`. For geocode, put it on the WIRE schema only, so `mailwoman/test/api-schema-drift.test.ts` (which compares `GeocodeOutcomeLike` to the engine's `GeocodeResult`) is untouched:

```ts
export const GeocodeOutcomeSchema = GeocodeOutcomeLikeSchema.extend({ engine: EngineStampSchema.optional() })
	.loose()
	.openapi("GeocodeOutcome")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `yarn vitest run packages/api/test/unit/index.test.ts packages/mailwoman/test/unit/api-schema-drift.test.ts` (adjust the drift test's path with `git ls-files | grep api-schema-drift`).
Expected: PASS.

If a route's `responses` schema in `routes.ts` is declared with the wire schema and the typed `c.json` now rejects the widened body, widen the route's `200` content schema to the same schema you extended in Step 4.

- [ ] **Step 6: Commit**

```bash
git add packages/api/lib packages/api/test
git commit -m "feat(api): /v1 bodies carry the engine stamp and every response carries the license headers

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 7: The Nominatim drop-in

**Files:**

- Modify: `packages/nominatim/lib/app.ts` (`NominatimAppOptions`, `createNominatimApp`)
- Modify: `packages/nominatim/lib/routes.ts` (`registerNominatimRoutes` signature; the jsonv2 and geojson responses of `/search`, `/reverse`, `/lookup`)
- Modify: `packages/nominatim/lib/schema.ts` (`NominatimResultSchema`)
- Test: `packages/nominatim/test/unit/index.test.ts`

**Interfaces:**

- Consumes: Task 5's exports.
- Produces: `NominatimAppOptions.engine?: EngineStamp`; `registerNominatimRoutes(app, engine, options?: { engine?: EngineStamp })`.

- [ ] **Step 1: Write the failing test**

Find the existing `/search` test in `packages/nominatim/test/unit/index.test.ts` that builds a `NominatimEngine` fixture (`grep -n "createNominatimApp" packages/nominatim/test/unit/index.test.ts`). Reuse its fixture engine in:

```ts
import type { EngineStamp } from "@mailwoman/core/license"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

test("engine option: each jsonv2 result carries `engine` beside an unchanged `licence`, the geojson collection carries it once", async () => {
	const app = createNominatimApp(fixtureEngine, { engine: stamp })

	const jsonv2 = await app.request("/search?q=1600+Pennsylvania&format=jsonv2")
	expect(jsonv2.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
	const results = (await jsonv2.json()) as Array<{ licence: string; engine: EngineStamp }>
	expect(results.length).toBeGreaterThan(0)
	for (const r of results) {
		expect(r.licence).toBe(MAILWOMAN_LICENCE)
		expect(r.engine).toEqual(stamp)
	}

	const geojson = (await (await app.request("/search?q=1600+Pennsylvania&format=geojson")).json()) as {
		engine: EngineStamp
		features: object[]
	}
	expect(geojson.engine).toEqual(stamp)
	for (const f of geojson.features) expect(f).not.toHaveProperty("engine")

	const jsonld = (await (await app.request("/search?q=1600+Pennsylvania&format=jsonld")).json()) as object[]
	for (const place of jsonld) expect(place).not.toHaveProperty("engine")
})

test("no engine option: results and headers are unchanged", async () => {
	const res = await createNominatimApp(fixtureEngine).request("/search?q=1600+Pennsylvania&format=jsonv2")

	expect(res.headers.get("server")).toBeNull()
	for (const r of (await res.json()) as object[]) expect(r).not.toHaveProperty("engine")
})
```

Replace `fixtureEngine` with the name the file already uses for its engine fixture.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/nominatim/test/unit/index.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Thread the option**

`app.ts`: add `engine?: EngineStamp` to `NominatimAppOptions` with the same docstring shape as Task 6; after the CORS block `if (options.engine) app.use(engineHeaders(options.engine))`; call `registerNominatimRoutes(app, engine, { ...(options.engine ? { engine: options.engine } : {}) })`.

`routes.ts`: change the signature to

```ts
export function registerNominatimRoutes(
	app: OpenAPIHono,
	engine: NominatimEngine,
	options: { engine?: EngineStamp } = {}
): void {
	const stamp = options.engine
```

and at each response site:

- jsonv2 array (`return c.json(results, 200)` at ~223, and the `/lookup` equivalent): `return c.json(stamp ? results.map((r) => ({ ...r, engine: stamp })) : results, 200)`
- geojson (`return c.json(toFeatureCollection(results), 200)` at ~217 and ~253): `return c.json(withEngineStamp(toFeatureCollection(results), stamp), 200)`
- `/reverse` single jsonv2 result (`c.json(result, 200)` or `c.json(null, 200)`): `return c.json(result ? withEngineStamp(result, stamp) : result, 200)`
- jsonld: unchanged.

`schema.ts`: add `engine: EngineStampSchema.optional(),` to `NominatimResultSchema` (import from `@mailwoman/api-kit`). If `NominatimFeatureCollection` is a typed interface in `format.ts` or `engine.ts`, add `engine?: EngineStamp` to it.

- [ ] **Step 4: Run the tests and commit**

Run: `yarn vitest run packages/nominatim/test/unit`
Expected: PASS.

```bash
git add packages/nominatim/lib packages/nominatim/test
git commit -m "feat(nominatim): results carry the engine stamp beside the data attribution

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 8: The Photon drop-in

**Files:**

- Modify: `packages/photon/lib/app.ts` (`PhotonAppOptions`, `createPhotonApp`)
- Modify: `packages/photon/lib/routes.ts` (`registerPhotonRoutes`, the two `c.json(collection, 200)` sites at ~161 and ~193)
- Modify: `packages/photon/lib/engine.ts` (`PhotonFeatureCollection`)
- Test: `packages/photon/test/unit/index.test.ts`

**Interfaces:**

- Consumes: Task 5's exports.
- Produces: `PhotonAppOptions.engine?: EngineStamp`; `PhotonFeatureCollection.engine?: EngineStamp`.

- [ ] **Step 1: Write the failing test**

Reuse the file's existing engine fixture (find it with `grep -n "createPhotonApp" packages/photon/test/unit/index.test.ts`):

```ts
import type { EngineStamp } from "@mailwoman/core/license"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

test("engine option: the FeatureCollection carries `engine` as a foreign member; features and jsonld are unchanged", async () => {
	const app = createPhotonApp(fixtureEngine, { engine: stamp })
	const res = await app.request("/api?q=berlin")

	expect(res.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
	const body = (await res.json()) as { type: string; engine: EngineStamp; features: object[] }
	expect(body.type).toBe("FeatureCollection")
	expect(body.engine).toEqual(stamp)
	for (const f of body.features) expect(f).not.toHaveProperty("engine")

	const jsonld = (await (await app.request("/api?q=berlin&format=jsonld")).json()) as object[]
	for (const place of jsonld) expect(place).not.toHaveProperty("engine")
})

test("no engine option: the collection has no `engine` member", async () => {
	const body = (await (await createPhotonApp(fixtureEngine).request("/api?q=berlin")).json()) as object

	expect(body).not.toHaveProperty("engine")
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/photon/test/unit/index.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Thread the option**

`engine.ts`: add to `PhotonFeatureCollection`

```ts
	/**
	 * The engine stamp as a GeoJSON foreign member (RFC 7946 section 6.1). Present when the app was given one.
	 */
	engine?: EngineStamp
```

`app.ts`: `engine?: EngineStamp` on `PhotonAppOptions`; `if (options.engine) app.use(engineHeaders(options.engine))` after CORS; `registerPhotonRoutes(app, engine, { ...(options.engine ? { engine: options.engine } : {}) })`.

`routes.ts`: signature `registerPhotonRoutes(app, engine, options: { engine?: EngineStamp } = {})`, `const stamp = options.engine`, and both `return c.json(collection, 200)` become `return c.json(withEngineStamp(collection, stamp), 200)`. The jsonld branches are unchanged. If the route's `200` response schema is a strict zod object, add `engine: EngineStampSchema.optional()` to it in `schema.ts`.

- [ ] **Step 4: Run the tests and commit**

Run: `yarn vitest run packages/photon/test/unit`
Expected: PASS.

```bash
git add packages/photon/lib packages/photon/test
git commit -m "feat(photon): the FeatureCollection carries the engine stamp as a foreign member

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 9: The libpostal drop-in (headers only)

**Files:**

- Modify: `packages/libpostal/lib/app.ts` (`LibpostalAppOptions`, `createLibpostalApp`)
- Test: `packages/libpostal/test/unit/index.test.ts`

- [ ] **Step 1: Write the failing test**

Reuse the file's engine fixture:

```ts
import type { EngineStamp } from "@mailwoman/core/license"

const stamp: EngineStamp = {
	name: "mailwoman",
	version: "9.2.0",
	license: "AGPL-3.0-only",
	license_url: "https://mailwoman.ai/license",
	notice: "n",
}

test("engine option: headers only — the /parse body is byte-identical with and without it", async () => {
	const request = (app: ReturnType<typeof createLibpostalApp>) =>
		app.request("/parse", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "1600 Pennsylvania Ave NW" }),
		})

	const stamped = await request(createLibpostalApp(fixtureEngine, { engine: stamp }))
	const plain = await request(createLibpostalApp(fixtureEngine))

	expect(stamped.headers.get("server")).toBe("mailwoman/9.2.0 (AGPL-3.0-only)")
	expect(stamped.headers.get("link")).toBe('<https://mailwoman.ai/license>; rel="license"')
	expect(plain.headers.get("server")).toBeNull()
	expect(await stamped.text()).toBe(await plain.text())
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn vitest run packages/libpostal/test/unit/index.test.ts`
Expected: the new test FAILS on the `server` header.

- [ ] **Step 3: Add the option**

`app.ts`: `engine?: EngineStamp` on `LibpostalAppOptions` (docstring: headers only, because `/parse` answers a bare array by protocol); after the CORS block `if (options.engine) app.use(engineHeaders(options.engine))`.

- [ ] **Step 4: Run the tests and commit**

Run: `yarn vitest run packages/libpostal/test/unit`
Expected: PASS.

```bash
git add packages/libpostal/lib packages/libpostal/test
git commit -m "feat(libpostal): every response carries the license headers

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 10: Wire the four servers — pass the stamp, print the notice at listen

**Files:**

- Modify: `packages/nominatim/lib/cli.ts` (~line 312, `createNominatimApp(engine, { cors: values.cors })` and the `onListen`)
- Modify: `packages/photon/lib/cli.ts` (~line 222)
- Modify: `packages/libpostal/lib/cli.ts` (~line 66)
- Modify: `packages/mailwoman/lib/commands/serve.tsx` (~line 225, `createMailwomanAPI(engine, { batchMax })` and its `serveNode` call)
- Test: hand-run each server once; the `openapi` subcommand tests already cover app construction without a stamp.

**Interfaces:**

- Consumes: `resolveEngineStamp`, `printLicenseNotice` from `mailwoman/cli-kit/engine-stamp` (Task 2).

- [ ] **Step 1: Wire each drop-in `cli.ts`**

In each of the three drop-in `cli.ts` files, add to the `mailwoman/cli-kit/…` imports:

```ts
import { printLicenseNotice, resolveEngineStamp } from "mailwoman/cli-kit/engine-stamp"
```

Before the `createXApp(engine, { cors: values.cors })` line:

```ts
const engineStamp = await resolveEngineStamp()
const app = createXApp(engine, { cors: values.cors, engine: engineStamp.stamp })
```

and as the LAST statement of the `onListen` callback:

```ts
printLicenseNotice(engineStamp)
```

Check that each drop-in's `package.json` `dependencies` already lists `mailwoman` (they import `mailwoman/cli-kit/dropin`, so it should) and that `mailwoman/cli-kit/engine-stamp` resolves under the package's `exports` (Task 2 added it).

- [ ] **Step 2: Wire `mailwoman serve`**

In `packages/mailwoman/lib/commands/serve.tsx`, beside the dynamic imports at ~line 198:

```ts
const { printLicenseNotice, resolveEngineStamp } = await import("#cli-kit/engine-stamp")
const engineStamp = await resolveEngineStamp()
```

change the app construction to

```ts
const app = createMailwomanAPI(engine, {
	batchMax: Math.max(1, $public.MAILWOMAN_BATCH_MAX),
	engine: engineStamp.stamp,
})
```

and in the `serveNode` call's `onListen` (add one if it relies on the default), print the notice after the listening line:

```ts
				onListen: ({ address, port }) => {
					console.error(`[mailwoman] native /v1 API listening on http://${address}:${port}`)
					printLicenseNotice(engineStamp)
				},
```

Note the launcher (Task 3) also prints the notice when the process exits; a server prints it at listen because it does not exit.

- [ ] **Step 3: Compile, typecheck, and hand-run**

Run: `yarn compile && yarn typecheck:tests`
Expected: clean.

Then, each on its own line with a free port, and stop each after the check:

```bash
node packages/mailwoman/out/cli.js serve --port 8091 & sleep 8; curl -si http://127.0.0.1:8091/health | grep -i -E '^(server|link):'; kill %1
```

Expected: both headers, and the two notice lines on the server's stderr after its listening line. Repeat with the nominatim, photon, and libpostal bins (`yarn workspace @mailwoman/nominatim exec node out/cli.js --port 8092`, or the bin name each package declares under `"bin"`), skipping any whose gazetteer or weights are absent on this machine and saying so in the commit message.

- [ ] **Step 4: Commit**

```bash
git add packages/nominatim/lib/cli.ts packages/photon/lib/cli.ts packages/libpostal/lib/cli.ts packages/mailwoman/lib/commands/serve.tsx
git commit -m "feat(serve): the four servers carry the engine stamp and print the license notice at listen

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
```

---

### Task 11: The `/license` page

**Files:**

- Create: `docs/src/pages/license.mdx`
- Test: the docs build and Vale.

- [ ] **Step 1: Write the page**

````mdx
---
title: License
description: Mailwoman is AGPL-3.0-only, or commercial under a paid license. This page says what each branch asks of you and how a key is configured and checked.
---

# License

Mailwoman is dual-licensed: **AGPL-3.0-only**, or **LicenseRef-Commercial** under a paid agreement. Every
release ships under both, and the branch that applies to an installation is the one it can show a
key for.

## The open-source branch

Under the AGPL, three obligations attach. You keep the copyright notices (attribution). A modified
copy carries the same license (share-alike). And if people use your modified copy over a network,
they are entitled to its corresponding source (the source offer, section 13). `mailwoman doctor`
reports these three by name for the installation it runs on.

Without a license key, every `mailwoman` command ends with a two-line notice on stderr that says so,
and every HTTP response from the native API and the drop-in servers carries a `Server` header naming
the branch and a `Link: rel="license"` header pointing here. JSON responses carry the same in an
`engine` object. None of it changes what runs.

## The commercial branch

A commercial license releases you from the source offer and the share-alike condition, so you can
build closed products and services on Mailwoman. The terms are in
[`COMMERCIAL-LICENSE.md`](https://github.com/sister-software/mailwoman/blob/main/COMMERCIAL-LICENSE.md);
the price and what it covers are on the [pricing page](/docs/pricing). To obtain one, write to
[teffen@sister.software](mailto:teffen@sister.software).

## Configuring and checking a key

A key is a signed token verified offline against the public keys each release ships.

```bash
export MAILWOMAN_LICENSE_KEY="mwl1.…"
mailwoman license verify --online
mailwoman doctor
```
````

`license verify` reports `valid`, `expired`, `unknown_key` or `invalid`, and with `--online` also whether
mailwoman.ai still lists the key id as active. `doctor` reports the branch that applies and the
obligations it carries. With a valid key the notice is silent and `engine.license` reads
`LicenseRef-Commercial`.

````

Replace the contact address with whatever the operator names as the sales contact if the pricing page names a different one (`grep -n "mailto:" docs/articles/pricing.mdx`).

- [ ] **Step 2: Vale, then build**

Run: `node_modules/@vvago/vale/bin/vale --config docs/.vale.ini docs/src/pages/license.mdx`
Expected: 0 errors. Fix any finding by naming the concrete thing.

Run: `yarn workspace @mailwoman/docs build 2>&1 | tail -5` (this takes minutes; see the `run-docs` skill for the faster dev-server check) and confirm `docs/build/license/index.html` exists.

- [ ] **Step 3: Commit**

```bash
git add docs/src/pages/license.mdx
git commit -m "docs: the /license page the notice, the engine stamp, and the Link header point at

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
````

---

### Task 12: CHANGELOG, OpenAPI artifacts, and the full check

**Files:**

- Modify: `CHANGELOG.md` (Unreleased → Added)
- Possibly regenerate: any committed OpenAPI document (`git ls-files | grep -i openapi | grep -v test`)

- [ ] **Step 1: Record the addition**

Under `## Unreleased`, add:

```markdown
### Added — the engine stamp and the license notice

Every JSON record the CLI emits (`geocode --json`, `reverse --json`, `autocomplete --json`), every `/v1` body, each
Nominatim result, and the Photon FeatureCollection carry an `engine` object: `name`, `version`, the license branch that
applies (`AGPL-3.0-only` or `LicenseRef-Commercial`), `license_url`, and, under the open-source branch, a one-sentence
`notice`. Every HTTP response from the four servers carries `Server: mailwoman/<version> (<license>)` and
`Link: <https://mailwoman.ai/license>; rel="license"`. Every CLI invocation ends with the same notice on stderr, and each
server prints it once at listen. A valid `MAILWOMAN_LICENSE_KEY` silences the notice; nothing else does. The stamp never
carries the licensee or the key id. Nothing here changes what runs.
```

- [ ] **Step 2: Regenerate committed OpenAPI documents, if any**

Run: `git ls-files | grep -i openapi | grep -v -E 'test|\.ts$'`
For each committed JSON document, regenerate it with the command its header or the `openapi-cli.test.ts` names (`node packages/mailwoman/out/cli.js openapi …`) and stage the diff. If none is committed, skip.

- [ ] **Step 3: Full check**

Run, in order, and paste the tail of each into the PR description:

```bash
yarn compile
yarn typecheck:tests
yarn lint
yarn vitest run packages/core/test/unit/license packages/api-kit/test/unit packages/api/test/unit packages/nominatim/test/unit packages/photon/test/unit packages/libpostal/test/unit packages/mailwoman/test/unit/cli-launcher.test.ts packages/mailwoman/test/unit/cli-kit
```

Expected: all clean. `yarn lint` includes `health`, which counts synchronous filesystem calls and banned vocabulary; a new finding there is a defect in this branch.

- [ ] **Step 4: Commit and open the PR**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): the engine stamp and the license notice

Claude-Session: https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg"
git push -u origin feat/license-posture-reporting
```

Then open the PR against `main` with the spec linked, the `parse --format json` decision stated, the `autocomplete --json` contract change stated, and the session link `https://claude.ai/code/session_011sdRccUsbdDyqumVDfHnvg` as the last line.
