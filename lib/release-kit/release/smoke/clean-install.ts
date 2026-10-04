/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isIdentical } from "@mailwoman/core/objects"
import { runFileSync, spawnProcess } from "@mailwoman/core/process"
import { type PathBuilder, type PathBuilderLike, resolvePath as resolve } from "path-ts"

import { installedMailwomanBin } from "#release-kit/release/smoke/installed-bin"
import { releaseWorkspaces } from "#release-kit/release/stage"
import { packWorkspaces, walkWorkspaceClosure, workspaceDirectories } from "#release-kit/release/workspace-closure"

/**
 * The publish set as a name → directory map, derived from `.release-it.json`
 * so a workspace added to the release is smoked without a second edit here.
 */
async function publishSet(repoRoot: PathBuilderLike): Promise<Map<string, string>> {
	const released = new Set(await releaseWorkspaces(repoRoot))
	const byName = await workspaceDirectories(repoRoot)
	const set = new Map<string, string>()

	for (const [name, dir] of byName) {
		if (released.has(dir)) {
			set.set(name, dir)
		}
	}

	return set
}

/**
 * Entrypoints a consumer imports directly: the drop-in parser surfaces, the annotation
 * and lookup kits, and the server adapters.
 *
 * Hand-maintained on purpose — the CLI and MCP bins are probed by execution below,
 * and the data-only weights packages carry no importable entrypoint.
 * Add a package here when its import-time behavior is something a consumer can
 * break without the CLI ever running.
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

const STANDALONE_LEAVES: readonly string[] = ["@mailwoman/core"]

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

		if (!isIdentical(names, expected)) {
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

/**
 * Refuse to smoke when a packed workspace depends on a workspace outside the pack set:
 * `yarn pack` freezes that edge to a registry version, so the throwaway project would
 * install it from npm rather than from the tarball under test.
 */
async function assertClosureComplete(repoRoot: string, packSet: ReadonlyMap<string, string>): Promise<void> {
	const missing = new Map<string, string[]>()

	for (const [name, dir] of packSet) {
		const manifest = await readPackageJSON(resolve(repoRoot, dir, "package.json"))

		for (const depType of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
			for (const [dep, spec] of Object.entries(manifest[depType] ?? {})) {
				const firstParty = dep.startsWith("@mailwoman/") || dep === "mailwoman"

				if (firstParty && spec?.startsWith("workspace:") && !packSet.has(dep)) {
					missing.set(dep, [...(missing.get(dep) ?? []), `${name} (${depType})`])
				}
			}
		}
	}

	if (missing.size) {
		const edges = [...missing].map(([dep, users]) => `  ${dep} <- ${users.join(", ")}`).join("\n")

		throw new Error(
			`[smoke] pack set closure incomplete — these workspaces are depended on but not in the release list:\n${edges}`
		)
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
 * Summarizes a passing {@link smokeCleanInstall} run with workspace and MCP tool counts.
 * It also lists standalone packages installed by themselves.
 */
export interface SmokeCleanInstallReport {
	packed: number
	mcpTools: number
	standaloneLeaves: string[]
}

/**
 * Packs published workspaces and installs them into a throwaway project.
 *
 * It runs the CLI, MCP server and every import probe against the installed copy.
 *
 * @throws On the first failure, with the failing command's stdout and stderr attached to the message.
 */
export async function smokeCleanInstall({ repoRoot, log }: SmokeCleanInstallOptions): Promise<SmokeCleanInstallReport> {
	await using tmp = await temporaryDirectory("mw-smoke-")
	const tarDir = tmp.path("tarballs")
	const proj = tmp.path("proj")
	await makeDirectories(tarDir, proj)

	try {
		const packSet = await publishSet(repoRoot)

		await assertClosureComplete(repoRoot, packSet)

		log(`[smoke] packing ${packSet.size} workspaces…`)

		const deps = await packWorkspaces(repoRoot, packSet, tarDir)

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
			const leafDir = packSet.get(leaf)

			if (!leafDir) throw new Error(`[smoke] standalone leaf ${leaf} is not in the pack set`)

			const closure = await walkWorkspaceClosure(repoRoot, [leaf])
			const firstPartyDependencies = [...closure.keys()].filter((name) => name !== leaf).toSorted()

			log(
				`[smoke] standalone-leaf import: ${leaf} alone (without the umbrella or hoisting; closure ${firstPartyDependencies.join(", ") || "none"})…`
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
							const workspaceDir = packSet.get(name)

							if (!workspaceDir) throw new Error(`[smoke] ${leaf} closure member ${name} is not in the pack set`)

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
			packed: packSet.size,
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
