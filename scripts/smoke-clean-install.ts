/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Clean-install smoke test — the guard that would have caught the v4.8.0 broken publish.
 *
 *   The monorepo HOISTS dependencies, so an undeclared runtime dep (or a missing shipped file, or a
 *   command module with an eager top-level side effect) resolves fine in-repo but crashes a fresh
 *   `npm install`. Nothing tested that path, so several published versions shipped a `mailwoman`
 *   CLI that crashed on startup (undeclared `path-ts`/`fast-glob`/… in core, an eager `new
 *   Piscina`
 *
 *   - Unshipped `.mjs` worker in `wof prepare`, an eager import of the unpublished
 *       `@mailwoman/resolver-wof-sqlite`). See #481 follow-up.
 *
 *   This packs every published code workspace, installs the tarballs into a throwaway project (so the
 *   ONLY packages available are what the manifests declare — no hoisting), and runs the compiled
 *   CLI. A missing dep / file / eager side effect surfaces as a non-zero exit here, in CI, before
 *   publish.
 *
 *   Run AFTER `yarn compile`. Usage: node scripts/smoke-clean-install.ts
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"

const repoRoot = repoRootPath()
// The `mailwoman` CLI's full first-party runtime closure. Every `@mailwoman/*` package the CLI can load
// at runtime MUST be packed here — otherwise `npm install` pulls it from the REGISTRY (the published,
// possibly-stale version), and the smoke tests new-source-CLI against an old-registry dependency. That
// exact skew shipped a red main after the v5.0.0 acronym rename: `mailwoman` imported the renamed
// `createWOFResolver`, but `@mailwoman/resolver` wasn't packed, so npm resolved the pre-rename 4.16.2 and
// the CLI crashed on a missing export. Packing the closure makes the test source-coherent (new-vs-new).
const WORKSPACES: Record<string, string> = {
	"@mailwoman/core": "core",
	"@mailwoman/spatial": "spatial",
	"@mailwoman/resolver": "resolver",
	"@mailwoman/ban": "ban",
	"@mailwoman/codex": "codex",
	"@mailwoman/classifiers": "classifiers",
	"@mailwoman/kind-classifier": "kind-classifier",
	"@mailwoman/locale-gate": "locale-gate",
	"@mailwoman/normalize": "normalize",
	"@mailwoman/phrase-grouper": "phrase-grouper",
	"@mailwoman/query-shape": "query-shape",
	"@mailwoman/neural": "neural",
	"@mailwoman/formatter": "formatter",
	"@mailwoman/record": "record",
	"@mailwoman/match": "match",
	"@mailwoman/registry": "registry",
	"@mailwoman/address-id": "address-id",
	"@mailwoman/corpus": "corpus",
	mailwoman: "mailwoman",
	// The annotations layer + drop-in API packages (the "replace Nominatim" surface).
	"@mailwoman/annotations": "annotations",
	"@mailwoman/timezone-lookup": "timezone-lookup",
	"@mailwoman/un-locode-lookup": "un-locode-lookup",
	"@mailwoman/nuts-lookup": "nuts-lookup",
	"@mailwoman/api-kit": "api-kit",
	"@mailwoman/api": "api",
	"@mailwoman/libpostal": "libpostal",
	"@mailwoman/photon": "photon",
	"@mailwoman/nominatim": "nominatim",
}

// Drop-in + annotation packages whose entrypoint we import to catch undeclared deps (the #596 trap).
const IMPORT_CHECK = [
	"@mailwoman/annotations",
	"@mailwoman/timezone-lookup",
	"@mailwoman/un-locode-lookup",
	"@mailwoman/nuts-lookup",
	"@mailwoman/api-kit",
	"@mailwoman/api",
	"@mailwoman/libpostal",
	"@mailwoman/photon",
	"@mailwoman/nominatim",
]

const tmp = mkdtempSync(join(tmpdir(), "mw-smoke-"))
const tarDir = join(tmp, "tarballs")
const proj = join(tmp, "proj")
execFileSync("mkdir", ["-p", tarDir, proj])
const run = (cmd: string, args: string[], cwd: string) =>
	execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })

try {
	console.log(`[smoke] packing ${Object.keys(WORKSPACES).length} workspaces…`)
	const deps: Record<string, string> = {}

	for (const [name, dir] of Object.entries(WORKSPACES)) {
		const tgz = join(tarDir, `${dir}.tgz`)
		run("yarn", ["workspace", name, "pack", "-o", tgz], repoRoot)
		deps[name] = `file:${tgz}`
	}
	writeFileSync(
		join(proj, "package.json"),
		JSON.stringify({ name: "mw-smoke", private: true, dependencies: deps }, null, 2)
	)

	console.log("[smoke] npm install (tarballs only — no hoisting)…")
	run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], proj)

	const cli = join(proj, "node_modules", "mailwoman", "out", "cli.js")
	console.log("[smoke] mailwoman --help (loads every command module)…")
	const help = run("node", [cli, "--help"], proj)

	for (const c of ["parse", "geocode", "autocomplete", "reverse", "wof", "corpus", "registry"]) {
		if (!help.includes(c)) throw new Error(`--help missing command "${c}"`)
	}

	console.log("[smoke] mailwoman parse (exercises bundled core/data dictionaries)…")
	const out = run("node", [cli, "parse", "350 5th Ave, New York, NY 10118"], proj)

	if (!out.includes("New York") || !out.includes("10118"))
		throw new Error(`parse output unexpected:\n${out.slice(0, 400)}`)

	console.log("[smoke] importing the drop-in + annotation package entrypoints…")

	for (const pkg of IMPORT_CHECK) {
		run("node", ["--input-type=module", "-e", `await import("${pkg}")`], proj)
	}

	console.log("\n[smoke] ✅ clean install + CLI run succeeded")
} catch (err: unknown) {
	const e = err as { stdout?: string; stderr?: string; message?: string }
	console.error("\n[smoke] ❌ FAILED — a published package does not clean-install/run:")
	console.error(
		e.stdout ? `${e.message}\n--- stdout ---\n${e.stdout}\n--- stderr ---\n${e.stderr}` : (e.message ?? err)
	)
	process.exitCode = 1
} finally {
	rmSync(tmp, { recursive: true, force: true })
}
