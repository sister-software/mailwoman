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
import { join, resolve } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"

import { packWorkspaceForPublish } from "./pack-workspace.ts"

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
	// mailwoman's peerDependency (optional) — packed too so `mailwoman`'s gazetteer-pipeline poi builder
	// (a static `resolver-wof-sqlite/poi-lookup` import, reached eagerly via `--help`'s command-module
	// load) resolves the LOCAL poi-lookup subpath instead of the registry's stale pre-poi.db 7.1.0 (2026-07-18
	// — found while adding @mailwoman/mcp to this closure; ERR_PACKAGE_PATH_NOT_EXPORTED on './poi-lookup',
	// reproduced with mcp absent too, so this gap predates Task 6 and was simply uncaught until now).
	"@mailwoman/resolver-wof-sqlite": "resolver-wof-sqlite",
	"@mailwoman/ban": "ban",
	"@mailwoman/codex": "codex",
	"@mailwoman/poi-taxonomy": "poi-taxonomy",
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
	// `@mailwoman/mcp`'s bin (`out/cli.js`, the `mailwoman-mcp` entry) connects an stdio transport at module
	// scope, so IMPORT_CHECK below (which imports the package ENTRYPOINT — `index.ts`, i.e. server.ts +
	// tools.ts only) never exercises cli.ts directly; the bin's dep closure is covered only transitively,
	// via the closure-wide npm install. Follow-up tracked to add a real bin-exec check (2026-07-19).
	"@mailwoman/mcp": "mcp",
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
	"@mailwoman/mcp",
]

// Leaves whose tarball must import when installed ALONE (no umbrella, no hoisting) — the undeclared-dep
// guard the closure phase can't provide. ONLY add a package whose runtime deps are all third-party (or
// also packed by this script), else its `@mailwoman/*` dep resolves from the registry and skews the test.
// `@mailwoman/core` qualifies: zero `@mailwoman/*` runtime deps.
const STANDALONE_LEAVES = ["@mailwoman/core"]

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
		// Pack via the SHARED publish path (injected publishConfig.exports) — a raw `yarn pack`
		// ships the dev map (node → .ts), which consumers can never load (node_modules type-strip
		// refusal) and which this smoke exists to catch.
		packWorkspaceForPublish(resolve(repoRoot, dir), tgz)
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

	// Standalone-leaf guard (#core-zx, 2026-07-18). The phase above installs the WHOLE `mailwoman`
	// closure into ONE project, so a hoisted-but-undeclared dep is always present in node_modules — it
	// cannot catch a leaf package whose OWN manifest is missing a runtime dep. Install each
	// dependency-clean leaf ALONE (only its tarball; npm pulls that package's declared deps from the
	// registry) and import it. `@mailwoman/core` has no `@mailwoman/*` runtime deps, so it installs
	// standalone; an undeclared import (the v7.0.0 `zx` bug, which the closure phase hid because
	// `mailwoman` declares `zx`) crashes here and nowhere else. Add a leaf only if its runtime deps are
	// all third-party or also listed here — otherwise its `@mailwoman/*` dep 404s / pulls a stale
	// registry version (the source-skew this file's header warns about).
	for (const leaf of STANDALONE_LEAVES) {
		const leafDir = WORKSPACES[leaf]!
		console.log(`[smoke] standalone-leaf import: ${leaf} alone (no umbrella, no hoisting)…`)
		const solo = join(tmp, `solo-${leafDir}`)
		execFileSync("mkdir", ["-p", solo])
		writeFileSync(
			join(solo, "package.json"),
			JSON.stringify(
				{
					name: `mw-solo-${leafDir}`,
					private: true,
					type: "module",
					dependencies: { [leaf]: `file:${join(tarDir, `${leafDir}.tgz`)}` },
				},
				null,
				2
			)
		)
		run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], solo)
		run("node", ["--input-type=module", "-e", `await import("${leaf}")`], solo)
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
