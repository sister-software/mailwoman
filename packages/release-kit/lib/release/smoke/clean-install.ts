/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { runFileSync, spawnProcess } from "@mailwoman/core/process"
import { type PathBuilder, type PathBuilderLike, resolvePath as resolve } from "path-ts"

import { installedMailwomanBin } from "#release/smoke/installed-bin"
import { packWorkspaces } from "#release/workspace-closure"

const WORKSPACES: Record<string, string> = {
	"@mailwoman/core": "packages/core",
	"@mailwoman/evidence": "packages/evidence",
	"@mailwoman/spatial": "packages/spatial",
	"@mailwoman/sqlite": "packages/sqlite",
	"@mailwoman/resolver": "packages/resolver",

	"@mailwoman/resolver-wof-sqlite": "packages/resolver-wof-sqlite",

	"@mailwoman/ancestrie": "packages/ancestrie",
	"@mailwoman/ban": "packages/ban",
	"@mailwoman/codex": "packages/codex",
	"@mailwoman/poi-taxonomy": "packages/poi-taxonomy",

	"@mailwoman/activity-lexicon": "packages/activity-lexicon",

	"@mailwoman/geographic-model": "packages/geographic-model",
	"@mailwoman/kind-classifier": "packages/kind-classifier",

	"@mailwoman/react": "packages/react",
	"@mailwoman/locale-hint": "packages/locale-hint",
	"@mailwoman/normalize": "packages/normalize",
	"@mailwoman/phrase-grouper": "packages/phrase-grouper",
	"@mailwoman/query-shape": "packages/query-shape",

	"@mailwoman/sentencepiece-wasm": "packages/sentencepiece-wasm",
	"@mailwoman/neural": "packages/neural",

	"@mailwoman/neural-weights-en-us": "packages/neural-weights-en-us",
	"@mailwoman/neural-weights-fr-fr": "packages/neural-weights-fr-fr",
	"@mailwoman/neural-weights-en-gb": "packages/neural-weights-en-gb",
	"@mailwoman/neural-weights-en-nz": "packages/neural-weights-en-nz",
	"@mailwoman/neural-weights-it-it": "packages/neural-weights-it-it",
	"@mailwoman/neural-weights-es-es": "packages/neural-weights-es-es",
	"@mailwoman/neural-weights-de-de": "packages/neural-weights-de-de",
	"@mailwoman/neural-weights-en-in": "packages/neural-weights-en-in",
	"@mailwoman/neural-weights-cjk": "packages/neural-weights-cjk",
	"@mailwoman/neural-weights-zh-cn": "packages/neural-weights-zh-cn",
	"@mailwoman/neural-weights-ja-jp": "packages/neural-weights-ja-jp",
	"@mailwoman/variant-aliases": "packages/variant-aliases",

	"@mailwoman/tiger": "packages/tiger",
	"@mailwoman/record": "packages/record",
	"@mailwoman/match": "packages/match",
	"@mailwoman/registry": "packages/registry",
	"@mailwoman/address-id": "packages/address-id",
	"@mailwoman/corpus": "packages/corpus",

	"@mailwoman/map-tui": "packages/map-tui",
	mailwoman: "packages/mailwoman",

	"@mailwoman/annotations": "packages/annotations",
	"@mailwoman/timezone-lookup": "packages/timezone-lookup",
	"@mailwoman/un-locode-lookup": "packages/un-locode-lookup",
	"@mailwoman/nuts-lookup": "packages/nuts-lookup",
	"@mailwoman/api-kit": "packages/api-kit",
	"@mailwoman/api": "packages/api",
	"@mailwoman/libpostal": "packages/libpostal",
	"@mailwoman/photon": "packages/photon",
	"@mailwoman/nominatim": "packages/nominatim",

	"@mailwoman/fastify": "packages/fastify",

	"@mailwoman/mcp": "packages/mcp",

	"@mailwoman/bdc": "packages/bdc",
	"@mailwoman/filer": "packages/filer",

	"@mailwoman/flood": "packages/flood",

	"@mailwoman/soil": "packages/soil",

	"@mailwoman/coastal": "packages/coastal",

	"@mailwoman/zoning": "packages/zoning",
}

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

const STANDALONE_LEAVES: readonly string[] = ["@mailwoman/core"]

async function firstPartyClosure(repoRoot: string, leaf: string): Promise<string[]> {
	const closure = new Set<string>()
	const pending = [leaf]

	while (pending.length) {
		const name = pending.pop()!
		const manifest = await readPackageJSON(resolve(repoRoot, WORKSPACES[name]!, "package.json"))

		for (const depType of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			for (const dep of Object.keys(manifest[depType] ?? {})) {
				const firstParty = dep.startsWith("@mailwoman/") || dep === "mailwoman"

				if (firstParty && dep in WORKSPACES && !closure.has(dep)) {
					closure.add(dep)
					pending.push(dep)
				}
			}
		}
	}

	return [...closure].toSorted()
}

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

async function checkMCPBin(projDir: PathBuilder, timeoutMs = 30_000): Promise<number> {
	const binPath = projDir("node_modules", ".bin", "mailwoman-mcp")
	const child = spawnProcess(binPath, [], { cwd: projDir, stdio: ["pipe", "pipe", "pipe"] })

	let stderr = ""

	child.stderr.on("data", (d: Buffer) => {
		stderr += d.toString()
	})

	child.stdin.on("error", () => {})

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

			const msg = tryParsingJSON<{ id?: number; result?: { tools?: unknown[] }; error?: unknown }>(line)

			if (msg && typeof msg.id === "number") {
				responses.set(msg.id, { id: msg.id, result: msg.result, error: msg.error })
				waiters.get(msg.id)?.(msg)
			}
		}
	})

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
			child.stdin.write(`${stringifyJSON(obj)}\n`)
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

		if (initResp.error) throw new Error(`initialize failed: ${stringifyJSON(initResp.error)}`)

		send({ jsonrpc: "2.0", method: "notifications/initialized" })
		send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
		const listResp = await waitFor(2)

		if (listResp.error) throw new Error(`tools/list failed: ${stringifyJSON(listResp.error)}`)
		const tools = listResp.result?.tools ?? []

		const names = tools.map((t) => (t as { name?: string }).name ?? "?").toSorted()
		const expected = MCP_EXPECTED_TOOLS.toSorted()

		if (stringifyJSON(names) !== stringifyJSON(expected)) {
			const missing = expected.filter((n) => !names.includes(n))
			const surplus = names.filter((n) => !expected.includes(n))

			throw new Error(
				`MCP tool set drift — missing: [${missing.join(", ")}] unexpected: [${surplus.join(", ")}] (update MCP_EXPECTED_TOOLS beside the mcp/tools.ts change)`
			)
		}

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

function run(cmd: string, args: PathBuilderLike[], cwd: PathBuilderLike): string {
	return runFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
}

async function assertClosureComplete(repoRoot: string): Promise<void> {
	const missing = new Map<string, string[]>()

	for (const [name, dir] of Object.entries(WORKSPACES)) {
		const manifest = await readPackageJSON(resolve(repoRoot, dir, "package.json"))

		for (const depType of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			for (const [dep, spec] of Object.entries(manifest[depType] ?? {})) {
				const firstParty = dep.startsWith("@mailwoman/") || dep === "mailwoman"

				if (firstParty && spec?.startsWith("workspace:") && !(dep in WORKSPACES)) {
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

/**
 * Configures {@link smokeCleanInstall} with the repository root to pack from and a sink for progress lines.
 */
export interface SmokeCleanInstallOptions {
	repoRoot: string
	log: (line: string) => void
}

/**
 * Summarizes a passing {@link smokeCleanInstall} run: how many workspaces were packed,
 * how many tools the MCP server listed, and which standalone packages were installed alone.
 */
export interface SmokeCleanInstallReport {
	packed: number
	mcpTools: number
	standaloneLeaves: string[]
}

/**
 * Packs the published workspaces, installs them into a throwaway project, and runs the CLI,
 * the MCP server and every import probe against the installed copy.
 *
 * @throws On the first failure, with the failing command's stdout and stderr attached to the message.
 */
export async function smokeCleanInstall({ repoRoot, log }: SmokeCleanInstallOptions): Promise<SmokeCleanInstallReport> {
	await using tmp = await temporaryDirectory("mw-smoke-")
	const tarDir = tmp.path("tarballs")
	const proj = tmp.path("proj")
	await makeDirectories(tarDir, proj)

	try {
		await assertClosureComplete(repoRoot)

		log(`[smoke] packing ${Object.keys(WORKSPACES).length} workspaces…`)

		const deps = await packWorkspaces(repoRoot, new Map(Object.entries(WORKSPACES)), tarDir)

		await writeLocalJSONFile({ name: "mw-smoke", private: true, dependencies: deps }, proj("package.json"))

		log("[smoke] npm install (tarballs only — no hoisting)…")

		run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], proj)

		const cli = await installedMailwomanBin(proj)

		log("[smoke] mailwoman --help (loads every command module)…")

		const help = run("node", [cli, "--help"], proj)

		for (const c of ["parse", "geocode", "autocomplete", "reverse", "wof", "corpus", "registry"]) {
			if (!help.includes(c)) throw new Error(`--help missing command "${c}"`)
		}

		log("[smoke] mailwoman parse (exercises bundled core/data dictionaries)…")

		const out = run("node", [cli, "parse", "350 5th Ave, New York, NY 10118"], proj)

		if (!out.includes("New York") || !out.includes("10118"))
			throw new Error(`parse output unexpected:\n${out.slice(0, 400)}`)

		log("[smoke] importing the drop-in + annotation package entrypoints…")

		for (const pkg of IMPORT_CHECK) {
			run("node", ["--input-type=module", "-e", `await import("${pkg}")`], proj)
		}

		log("[smoke] mailwoman-mcp bin: JSON-RPC initialize + tools/list over stdio…")

		const toolCount = await checkMCPBin(proj)

		log(`[smoke]   → ${toolCount} tools listed, bin shut down cleanly`)

		for (const leaf of STANDALONE_LEAVES) {
			const leafDir = WORKSPACES[leaf]!
			const firstPartyDependencies = await firstPartyClosure(repoRoot, leaf)

			log(
				`[smoke] standalone-leaf import: ${leaf} alone (no umbrella, no hoisting; closure ${firstPartyDependencies.join(", ") || "none"})…`
			)

			const solo = tmp.path(`solo-${leafDir}`)
			await makeDirectories(solo)

			await writeLocalJSONFile(
				{
					name: `mw-solo-${leafDir}`,
					private: true,
					type: "module",
					dependencies: Object.fromEntries(
						[leaf, ...firstPartyDependencies].map((name) => {
							const workspaceDir = WORKSPACES[name]!

							return [name, `file:${tarDir(`${workspaceDir}.tgz`).toString()}`]
						})
					),
				},
				solo("package.json")
			)

			run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], solo)
			run("node", ["--input-type=module", "-e", `await import("${leaf}")`], solo)
		}

		log("\n[smoke] ✅ clean install + CLI run succeeded")

		return {
			packed: Object.keys(WORKSPACES).length,
			mcpTools: toolCount,
			standaloneLeaves: [...STANDALONE_LEAVES],
		}
	} catch (error: unknown) {
		const e = error as { stdout?: string; stderr?: string; message?: string }

		throw new Error(
			"[smoke] FAILED — a published package does not clean-install/run:\n" +
				(e.stdout
					? `${e.message}\n--- stdout ---\n${e.stdout}\n--- stderr ---\n${e.stderr}`
					: (e.message ?? String(error)))
		)
	}
}
