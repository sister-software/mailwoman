import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
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
import { execFileSync, spawn } from "@mailwoman/platform/child_process"
import { readFileSync, writeFileSync } from "@mailwoman/platform/fs"
import { join, resolve } from "@mailwoman/platform/path"

import { packWorkspaceForPublish } from "./pack-workspace.ts"

const repoRoot = repoRootPath()

/**
 * The `mailwoman` CLI's full first-party runtime closure. Every `@mailwoman/*` package the CLI can load at runtime MUST
 * be packed here — otherwise `npm install` pulls it from the REGISTRY (the published, possibly-stale version), and the
 * smoke tests new-source-CLI against an old-registry dependency. That exact skew shipped a red main after the v5.0.0
 * acronym rename: `mailwoman` imported the renamed `createWOFResolver`, but `@mailwoman/resolver` wasn't packed, so npm
 * resolved the pre-rename 4.16.2 and the CLI crashed on a missing export. Packing the closure makes the test
 * source-coherent (new-vs-new).
 */
const WORKSPACES: Record<string, string> = {
	// Runtime capability boundary shared by the publish graph. Pack it first so every consumer resolves
	// the source-coherent tarball instead of a stale (or not-yet-published) registry version.
	"@mailwoman/platform": "packages/platform",
	"@mailwoman/core": "packages/core",
	"@mailwoman/spatial": "packages/spatial",
	"@mailwoman/sqlite": "packages/sqlite",
	"@mailwoman/resolver": "packages/resolver",
	// mailwoman's peerDependency (optional) — packed too so `mailwoman`'s gazetteer-pipeline poi builder
	// (a static `resolver-wof-sqlite/poi-lookup` import, reached eagerly via `--help`'s command-module
	// load) resolves the LOCAL poi-lookup subpath instead of the registry's stale pre-poi.db 7.1.0
	// (2026-07-18), which exports no './poi-lookup' at all — resolving there is an
	// ERR_PACKAGE_PATH_NOT_EXPORTED the instant the CLI loads its command modules.
	"@mailwoman/resolver-wof-sqlite": "packages/resolver-wof-sqlite",
	// resolver-wof-sqlite's autocomplete delegates to ancestrie (#1728 phase 2) — a hard workspace dep,
	// so the closure guard requires it here.
	"@mailwoman/ancestrie": "packages/ancestrie",
	"@mailwoman/ban": "packages/ban",
	"@mailwoman/codex": "packages/codex",
	"@mailwoman/poi-taxonomy": "packages/poi-taxonomy",
	// `mailwoman`'s activity-phrase vocabulary — a hard dependency, so the closure guard requires it here.
	"@mailwoman/activity-lexicon": "packages/activity-lexicon",
	// The compiled world model `mailwoman/observations` reads — a hard dependency, and one whose version must
	// track `mailwoman`'s exactly, which is the skew a registry resolution here would hide.
	"@mailwoman/geographic-model": "packages/geographic-model",
	"@mailwoman/kind-classifier": "packages/kind-classifier",
	// @mailwoman/react — bare root import must be node-safe (no CSS/DOM eagerly imported); its deps
	// (kind-classifier, poi-taxonomy, query-shape) are all in this closure, and the React peer is
	// auto-installed from the registry.
	"@mailwoman/react": "packages/react",
	"@mailwoman/locale-gate": "packages/locale-gate",
	"@mailwoman/normalize": "packages/normalize",
	"@mailwoman/phrase-grouper": "packages/phrase-grouper",
	"@mailwoman/query-shape": "packages/query-shape",
	// The tokenizer WASM core (task #26) — a hard dependency of @mailwoman/neural.
	"@mailwoman/sentencepiece-wasm": "packages/sentencepiece-wasm",
	"@mailwoman/neural": "packages/neural",
	// The weights bundles — data-only, but real deps of photon/nominatim/fastify (all in this
	// closure), so on a version-bumped release branch npm would otherwise chase the not-yet-published
	// registry version (the v7.6.0 ETARGET chicken-and-egg). Packing them also makes the smoke test
	// the ACTUAL weight packaging instead of the registry's previous release — the postcode-de.bin
	// class (a soft-feed sibling silently missing from a shipped tarball) is only visible this way.
	// PREREQ: the binaries must be materialized first (test.yml's weights-cache/copy-weights step) —
	// `yarn pack` quietly packs whatever subset of the `files` globs exists.
	"@mailwoman/neural-weights-en-us": "packages/neural-weights-en-us",
	"@mailwoman/neural-weights-fr-fr": "packages/neural-weights-fr-fr",
	"@mailwoman/neural-weights-en-gb": "packages/neural-weights-en-gb",
	"@mailwoman/neural-weights-en-nz": "packages/neural-weights-en-nz",
	"@mailwoman/neural-weights-it-it": "packages/neural-weights-it-it",
	"@mailwoman/neural-weights-es-es": "packages/neural-weights-es-es",
	"@mailwoman/neural-weights-de-de": "packages/neural-weights-de-de",
	"@mailwoman/neural-weights-en-in": "packages/neural-weights-en-in",
	"@mailwoman/variant-aliases": "packages/variant-aliases",
	// mailwoman's OTHER optional peer (besides resolver-wof-sqlite above) — optional or not, npm
	// still resolves its version spec, so an unpacked workspace dep ETARGETs on a release branch.
	"@mailwoman/tiger": "packages/tiger",
	"@mailwoman/formatter": "packages/formatter",
	"@mailwoman/record": "packages/record",
	"@mailwoman/match": "packages/match",
	"@mailwoman/registry": "packages/registry",
	"@mailwoman/address-id": "packages/address-id",
	"@mailwoman/corpus": "packages/corpus",
	// The map TUI — a runtime dep of mailwoman (the CLI's terminal map view); zero @mailwoman deps of
	// its own, so the closure ends here.
	"@mailwoman/map-tui": "packages/map-tui",
	mailwoman: "packages/mailwoman",
	// The annotations layer + drop-in API packages (the "replace Nominatim" surface).
	"@mailwoman/annotations": "packages/annotations",
	"@mailwoman/timezone-lookup": "packages/timezone-lookup",
	"@mailwoman/un-locode-lookup": "packages/un-locode-lookup",
	"@mailwoman/nuts-lookup": "packages/nuts-lookup",
	"@mailwoman/api-kit": "packages/api-kit",
	"@mailwoman/api": "packages/api",
	"@mailwoman/libpostal": "packages/libpostal",
	"@mailwoman/photon": "packages/photon",
	"@mailwoman/nominatim": "packages/nominatim",
	// The Fastify plugin. Its entrypoint's only eager runtime import is `fastify-plugin` (a declared dep) —
	// `mailwoman`/`@mailwoman/core` are reached via dynamic import() on the first request, and `fastify` is a
	// type-only (peer) import — so IMPORT_CHECK below loads it without fastify installed.
	"@mailwoman/fastify": "packages/fastify",
	// `@mailwoman/mcp`'s bin (`out/cli.js`, the `mailwoman-mcp` entry) connects an stdio transport at module
	// scope, so IMPORT_CHECK below (which imports the package ENTRYPOINT — `index.ts`, i.e. server.ts +
	// tools.ts only) never exercises cli.ts directly. The bin's OWN dep closure (its static imports:
	// `mailwoman/geocode-core`, `mailwoman/poi-overpass`, the SDK's stdio transport) is now covered by the
	// bin-exec leg (`checkMCPBin`, 2026-07-20) — a real JSON-RPC initialize + tools/list handshake against
	// the installed bin — instead of only transitively via the closure-wide npm install.
	"@mailwoman/mcp": "packages/mcp",
	// BDC + filer (2026-07-31): runtime deps of mailwoman + @mailwoman/mcp — the closure guard
	// flagged both missing on the first PR after their merge (pre-existing gap, not that PR's).
	"@mailwoman/bdc": "packages/bdc",
	"@mailwoman/filer": "packages/filer",
	// The flood layer reader is a hard dependency of `mailwoman`: `geocode-session` imports the
	// authority-designation route on the presence of a `flood.db`, and `--help`'s command-module load reaches
	// `gazetteer build flood`. Unpacked, npm would resolve a name that is not yet published at all.
	"@mailwoman/flood": "packages/flood",
	// The soil layer reader is a declared dependency of `mailwoman`, so npm resolves it at INSTALL time whether or not any
	// code path reaches it — and unpacked that is a name which is not yet published at all. Its runtime reach is narrower
	// than flood's above: `gazetteer build soil` imports the SDK inside its task rather than at module scope, so only
	// `geocode-session`'s dynamic route load reaches the package, and only where a `soil.db` is on disk.
	"@mailwoman/soil": "packages/soil",
	// The coastal layer reader is a declared dependency of `mailwoman` on the same terms as soil above: npm resolves it at
	// INSTALL time whether or not any code path reaches it, and unpacked that is a name which is not yet published at all.
	// `gazetteer build coastal` imports the SDK inside its task rather than at module scope, so only `geocode-session`'s
	// dynamic route load reaches the package, and only where a `coastal-england.db` is on disk.
	"@mailwoman/coastal": "packages/coastal",
	// The zoning layer reader is a declared dependency of `mailwoman` on the same terms as soil and coastal above: npm
	// resolves it at INSTALL time whether or not any code path reaches it, and unpacked that is a name which is not yet
	// published at all. `gazetteer build zoning` imports the SDK inside its task rather than at module scope, so only
	// `geocode-session`'s dynamic route load reaches the package, and only where a `zoning-ireland.db` is on disk.
	"@mailwoman/zoning": "packages/zoning",
}

/**
 * Drop-in + annotation packages whose entrypoint we import to catch undeclared deps (the #596 trap).
 */
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
	"@mailwoman/fastify",
	"@mailwoman/react",
]

/**
 * Leaves whose tarball must import without the umbrella (no unrelated hoisting) — the undeclared-dep guard the closure
 * phase can't provide. Each entry names the first-party tarballs that form the leaf's declared runtime closure, keeping
 * the check source-coherent without making unrelated packages available.
 */
const STANDALONE_LEAVES: Record<string, string[]> = {
	// Core otherwise qualifies as a dependency-clean leaf. Its first-party runtime dependencies are supplied as local
	// tarballs rather than resolved from npm: `@mailwoman/sqlite` is a NEW name with no publish yet, so a registry
	// install answers E404 and the probe reports a packaging failure that is really an unblessed name.
	"@mailwoman/core": ["@mailwoman/platform", "@mailwoman/sqlite"],
}

/**
 * The tools `@mailwoman/mcp` registers (`mcp/tools.ts` + the bdc/filer additions, 2026-07-31). The bin-exec leg asserts
 * EXACTLY this set — a name list, not a count, so drift names the missing or unexpected tool instead of printing
 * "expected N, got M".
 */
const MCP_EXPECTED_TOOLS = [
	"mailwoman_parse",
	"mailwoman_geocode",
	"mailwoman_poi_search",
	"mailwoman_overpass_export",
	"mailwoman_layer_manifest",
	"mailwoman_bdc_filing_landscape",
	"mailwoman_plausibility_check",
	"mailwoman_filer_lookup",
	"mailwoman_filer_family",
]

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

			// Non-JSON stdout noise (shouldn't happen on a clean stdio transport) parses to null and is skipped.
			const msg = tryParsingJSON<{ id?: number; result?: { tools?: unknown[] }; error?: unknown }>(line)

			if (msg && typeof msg.id === "number") {
				responses.set(msg.id, { id: msg.id, result: msg.result, error: msg.error })
				waiters.get(msg.id)?.(msg)
			}
		}
	})

	// Failure channels the handshake races against, so a missing/crashing bin fails FAST instead of hanging:
	// `error` (spawn ENOENT — the bin path doesn't exist), `exit` (crashed before answering), the overall timeout.
	const exited = new Promise<number | null>((res) => {
		child.on("exit", (code) => res(code))
	})

	const failed = new Promise<never>((_, rej) => {
		child.on("error", (err) => rej(new Error(`mailwoman-mcp failed to spawn (${binPath}): ${(err as Error).message}`)))
	})

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

				if (existing) {
					res(existing)

					return
				}

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

		const names = tools.map((t) => (t as { name?: string }).name ?? "?").toSorted()
		const expected = MCP_EXPECTED_TOOLS.toSorted()

		if (JSON.stringify(names) !== JSON.stringify(expected)) {
			const missing = expected.filter((n) => !names.includes(n))
			const surplus = names.filter((n) => !expected.includes(n))

			throw new Error(
				`MCP tool set drift — missing: [${missing.join(", ")}] unexpected: [${surplus.join(", ")}] (update MCP_EXPECTED_TOOLS beside the mcp/tools.ts change)`
			)
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
				}, 5000)
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

await using tmp = await temporaryDirectory("mw-smoke-")
const tarDir = tmp.resolve("tarballs")
const proj = tmp.resolve("proj")
execFileSync("mkdir", ["-p", tarDir, proj])

const run = (cmd: string, args: string[], cwd: string) =>
	execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })

/**
 * Closure-completeness guard: every `workspace:*` @mailwoman dep of a packed workspace must itself be in WORKSPACES. An
 * unpacked one doesn't fail here on main — npm silently resolves the REGISTRY version (the stale-dependency skew this
 * smoke exists to catch) — and hard-fails with ETARGET on a version-bumped release branch (the v7.6.0 chicken-and-egg:
 * neural-weights, then variant-aliases). Fail loud at pack time instead, naming the edge.
 */
function assertClosureComplete() {
	const missing = new Map<string, string[]>()

	for (const [name, dir] of Object.entries(WORKSPACES)) {
		const manifest = parseJSONStrict<Record<string, Record<string, string>>>(
			readFileSync(resolve(repoRoot, dir, "package.json"), "utf8")
		)

		for (const depType of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			for (const [dep, spec] of Object.entries(manifest[depType] ?? {})) {
				const firstParty = dep.startsWith("@mailwoman/") || dep === "mailwoman"

				if (firstParty && spec.startsWith("workspace:") && !(dep in WORKSPACES)) {
					missing.set(dep, [...(missing.get(dep) ?? []), `${name} (${depType})`])
				}
			}
		}
	}

	if (missing.size) {
		const edges = [...missing].map(([dep, users]) => `  ${dep} <- ${users.join(", ")}`).join("\n")

		throw new Error(`[smoke] WORKSPACES closure incomplete — add these to the pack set:\n${edges}`)
	}
}

try {
	assertClosureComplete()

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
	// dependency-clean leaf with only its declared first-party closure and import it. An undeclared import
	// (the v7.0.0 `zx` bug, which the closure phase hid because `mailwoman` declares `zx`) crashes here and
	// nowhere else. Keep each entry's first-party closure complete so npm never pulls a stale registry
	// version (the source-skew this file's header warns about).
	for (const [leaf, firstPartyDependencies] of Object.entries(STANDALONE_LEAVES)) {
		const leafDir = WORKSPACES[leaf]!

		console.log(`[smoke] standalone-leaf import: ${leaf} alone (no umbrella, no hoisting)…`)

		const solo = tmp.resolve(`solo-${leafDir}`)
		execFileSync("mkdir", ["-p", solo])

		writeFileSync(
			join(solo, "package.json"),
			JSON.stringify(
				{
					name: `mw-solo-${leafDir}`,
					private: true,
					type: "module",
					dependencies: Object.fromEntries(
						[leaf, ...firstPartyDependencies].map((name) => {
							const workspaceDir = WORKSPACES[name]!

							return [name, `file:${join(tarDir, `${workspaceDir}.tgz`)}`]
						})
					),
				},
				null,
				2
			)
		)

		run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], solo)
		run("node", ["--input-type=module", "-e", `await import("${leaf}")`], solo)
	}

	console.log("\n[smoke] ✅ clean install + CLI run succeeded")
} catch (error: unknown) {
	const e = error as { stdout?: string; stderr?: string; message?: string }

	console.error("\n[smoke] ❌ FAILED — a published package does not clean-install/run:")
	console.error(
		e.stdout ? `${e.message}\n--- stdout ---\n${e.stdout}\n--- stderr ---\n${e.stderr}` : (e.message ?? error)
	)

	process.exitCode = 1
}
