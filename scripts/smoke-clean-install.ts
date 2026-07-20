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
import { execFileSync, spawn } from "node:child_process"
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
	// @mailwoman/react — bare root import must be node-safe (no CSS/DOM eagerly imported); its deps
	// (kind-classifier, poi-taxonomy, query-shape) are all in this closure, and the React peer is
	// auto-installed from the registry.
	"@mailwoman/react": "react",
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
	// tools.ts only) never exercises cli.ts directly. The bin's OWN dep closure (its static imports:
	// `mailwoman/geocode-core`, `mailwoman/poi-overpass`, the SDK's stdio transport) is now covered by the
	// bin-exec leg (`checkMCPBin`, 2026-07-20) — a real JSON-RPC initialize + tools/list handshake against
	// the installed bin — instead of only transitively via the closure-wide npm install.
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
	"@mailwoman/react",
]

// Leaves whose tarball must import when installed ALONE (no umbrella, no hoisting) — the undeclared-dep
// guard the closure phase can't provide. ONLY add a package whose runtime deps are all third-party (or
// also packed by this script), else its `@mailwoman/*` dep resolves from the registry and skews the test.
// `@mailwoman/core` qualifies: zero `@mailwoman/*` runtime deps.
const STANDALONE_LEAVES = ["@mailwoman/core"]

/** The five tools `@mailwoman/mcp` registers (`mcp/tools.ts`). The bin-exec leg asserts EXACTLY this count. */
const MCP_EXPECTED_TOOL_COUNT = 5

/**
 * Bin-exec leg for `@mailwoman/mcp` (2026-07-20). IMPORT_CHECK imports the package ENTRYPOINT (server.ts + tools.ts);
 * it never runs `cli.ts`, whose OWN static imports (`mailwoman/geocode-core`, `mailwoman/poi-overpass`, the SDK's stdio
 * transport) can pull an undeclared dep that only surfaces when the bin actually boots. This spawns the INSTALLED
 * `mailwoman-mcp` bin over stdio, hand-writes the two newline-delimited JSON-RPC frames of the MCP handshake
 * (`initialize` → `notifications/initialized` → `tools/list`; no SDK client needed), asserts exactly five tools, then
 * closes stdin and asserts the process exits cleanly — the whole exchange bounded by `timeoutMs` (~30s). A missing dep,
 * a non-zero exit, a wrong tool count, or a hung process all fail the smoke here, before publish.
 */
async function checkMCPBin(projDir: string, timeoutMs = 30_000): Promise<number> {
	const binPath = join(projDir, "node_modules", ".bin", "mailwoman-mcp")
	const child = spawn(binPath, [], { cwd: projDir, stdio: ["pipe", "pipe", "pipe"] })

	let stderr = ""
	child.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})
	// A never-started child (ENOENT — the bin wasn't shipped) or a dead one produces EPIPE on write; swallow it so
	// the real failure surfaces via the `error`/`exit` events below, not an uncaught stream error.
	child.stdin.on("error", () => {})

	// Parse newline-delimited JSON-RPC frames off stdout; resolve a waiter when its id's response lands.
	let buffer = ""
	const responses = new Map<number, { id: number; result?: { tools?: unknown[] }; error?: unknown }>()
	const waiters = new Map<number, (msg: { result?: { tools?: unknown[] }; error?: unknown }) => void>()

	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString()
		let nl: number

		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim()
			buffer = buffer.slice(nl + 1)

			if (!line) continue

			try {
				const msg = JSON.parse(line) as { id?: number; result?: { tools?: unknown[] }; error?: unknown }

				if (typeof msg.id === "number") {
					responses.set(msg.id, { id: msg.id, result: msg.result, error: msg.error })
					waiters.get(msg.id)?.(msg)
				}
			} catch {
				// Non-JSON stdout noise (shouldn't happen on a clean stdio transport) — ignore.
			}
		}
	})

	// Failure channels the handshake races against, so a missing/crashing bin fails FAST instead of hanging:
	// `error` (spawn ENOENT — the bin path doesn't exist), `exit` (crashed before answering), the overall timeout.
	const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)))
	const failed = new Promise<never>((_, rej) =>
		child.on("error", (err) => rej(new Error(`mailwoman-mcp failed to spawn (${binPath}): ${(err as Error).message}`)))
	)
	let overallTimer: NodeJS.Timeout | undefined
	const timedOut = new Promise<never>((_, rej) => {
		overallTimer = setTimeout(() => {
			child.kill("SIGKILL")
			rej(new Error(`mailwoman-mcp handshake exceeded ${timeoutMs}ms; stderr:\n${stderr}`))
		}, timeoutMs)
	})

	const waitFor = (id: number) =>
		Promise.race([
			new Promise<{ result?: { tools?: unknown[] }; error?: unknown }>((res, rej) => {
				const existing = responses.get(id)

				if (existing) return res(existing)
				waiters.set(id, res)
				exited.then((code) =>
					rej(new Error(`mailwoman-mcp exited (code ${code}) before responding to id ${id}; stderr:\n${stderr}`))
				)
			}),
			failed,
			timedOut,
		])

	const send = (obj: unknown) => {
		if (!child.stdin.destroyed) {
			child.stdin.write(`${JSON.stringify(obj)}\n`)
		}
	}

	try {
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "mw-smoke", version: "0.0.0" },
			},
		})
		const initResp = await waitFor(1)

		if (initResp.error) throw new Error(`initialize failed: ${JSON.stringify(initResp.error)}`)

		send({ jsonrpc: "2.0", method: "notifications/initialized" })
		send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
		const listResp = await waitFor(2)

		if (listResp.error) throw new Error(`tools/list failed: ${JSON.stringify(listResp.error)}`)
		const tools = listResp.result?.tools ?? []

		if (tools.length !== MCP_EXPECTED_TOOL_COUNT) {
			const names = tools.map((t) => (t as { name?: string }).name ?? "?").join(", ")

			throw new Error(`expected ${MCP_EXPECTED_TOOL_COUNT} tools, got ${tools.length}: ${names}`)
		}

		// Clean shutdown: closing stdin ends the stdio transport; the process (lazy deps, nothing loaded) must exit 0.
		child.stdin.end()
		let shutdownTimer: NodeJS.Timeout | undefined
		const exitCode = await Promise.race([
			exited,
			timedOut,
			new Promise<never>((_, rej) => {
				shutdownTimer = setTimeout(() => {
					child.kill("SIGKILL")
					rej(new Error(`mailwoman-mcp did not exit within the shutdown window; stderr:\n${stderr}`))
				}, 5_000)
			}),
		]).finally(() => clearTimeout(shutdownTimer))

		if (exitCode !== 0 && exitCode !== null) {
			throw new Error(`mailwoman-mcp exited non-zero (${exitCode}) on stdin close; stderr:\n${stderr}`)
		}

		return tools.length
	} finally {
		clearTimeout(overallTimer)

		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL")
		}
	}
}

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

	console.log("[smoke] mailwoman-mcp bin: JSON-RPC initialize + tools/list over stdio…")
	const toolCount = await checkMCPBin(proj)
	console.log(`[smoke]   → ${toolCount} tools listed, bin shut down cleanly`)

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
