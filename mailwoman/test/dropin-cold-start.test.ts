/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cold-start integration test for the drop-in servers (`@mailwoman/photon`, `@mailwoman/nominatim`,
 *   `@mailwoman/libpostal`) and the MCP server (`@mailwoman/mcp`) — Tasks 7 and 14 of the docs reorg. Spawns each
 *   COMPILED `cli.js` and asserts the doctor-grade cold-start contract the tutorial docs print verbatim:
 *
 *   - `photon`/`nominatim` need a gazetteer to answer queries. With none present, `serve` must exit non-zero
 *     within 30 s and its stderr must name the fix (`mailwoman data pull`) — never an unhandled-rejection
 *     stack trace. This was previously a bare, WAF-blocked `curl` line (measured 2026-08-03: an unranged GET
 *     against the public bucket 403s) — see `resolver-backend.ts`'s `buildNoGazetteerMessage`.
 *   - `libpostal` needs ONLY the model weights, resolved from `node_modules` independent of the data root — a
 *     bare temp root is a legitimate, complete cold start for it. `serve` must bind and answer `GET /` with 200,
 *     no data pull required at all (the "lowest-dependency drop-in" the README claims).
 *   - `mcp` speaks JSON-RPC over stdio rather than HTTP, and loads its deps LAZILY, so its cold start fails
 *     inside a tool call rather than at boot: the server must still connect and list its tools with no data at
 *     all, and the first model-backed tool call must answer with the same `mailwoman data pull` fix as a tool
 *     error — not the internal `resolveShards: at least one shard is required`, which is what it said before
 *     Task 14. A second, network-free test asserts `@mailwoman/mcp` DECLARES `@mailwoman/neural-weights-en-us`;
 *     it did not until 2026-08-03, so a standalone `npm install @mailwoman/mcp` could never load the model
 *     (measured against the published 8.6.0 — the same defect Task 7 fixed in `@mailwoman/libpostal`). Nothing
 *     inside this monorepo can catch that one at runtime, because yarn hoists every workspace sibling into
 *     `node_modules` whether a package declares it or not.
 *
 *   These assertions run in EVERY environment and download nothing (a bare `mkdtemp` data root, never
 *   populated). The full loop — actually `data pull candidate` (~1.65 GB) and confirm photon/nominatim ALSO
 *   bind + answer 200 against it, plus the Paris/Texas routing retest (#task-7's carry-forward finding: the FTS
 *   default backend misroutes a French address to its US homonym; the candidate backend does not) — is gated
 *   behind `$MAILWOMAN_COLD_START_FULL=1` (unset in CI). Run it manually once per change to this cold-start
 *   path; `$MAILWOMAN_COLD_START_DATA_ROOT` lets a repeat local run reuse an already-pulled data root instead of
 *   re-downloading.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { $public } from "@mailwoman/core/env"
import { parseJSONStrict, tryParsingJSON } from "@mailwoman/core/objects"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { repoRootPath } from "@mailwoman/core/utils"
import { afterEach, describe, expect, test, vi } from "vitest"

import { withCLISpawnLockAsync } from "../test-kit/cli-spawn-lock.ts"

const execFileAsync = promisify(execFile)

//#region Paths + budgets

const PHOTON_CLI = repoRootPath("photon", "out", "cli.js")
const NOMINATIM_CLI = repoRootPath("nominatim", "out", "cli.js")
const LIBPOSTAL_CLI = repoRootPath("libpostal", "out", "cli.js")
const MAILWOMAN_CLI = repoRootPath("mailwoman", "out", "cli.js")
const MCP_CLI = repoRootPath("mcp", "out", "cli.js")
const MCP_PACKAGE_JSON = repoRootPath("mcp", "package.json")

const hasPhotonCLI = existsSync(PHOTON_CLI)
const hasNominatimCLI = existsSync(NOMINATIM_CLI)
const hasMCPCLI = existsSync(MCP_CLI)
const hasLibpostalCLI = existsSync(LIBPOSTAL_CLI)
const hasMailwomanCLI = existsSync(MAILWOMAN_CLI)

// Dedicated test-only ports, clear of the documented defaults (2322/8080/8081) and of the ports a manual cold-start
// check might already be using. One named constant per server so the string arg (CLI `--port`) and the numeric arg
// (`waitForHealthy`/`fetch`) can never drift apart.
const PHOTON_TEST_PORT = 29_322
const PHOTON_FULL_TEST_PORT = 29_323
const NOMINATIM_TEST_PORT = 29_380
const NOMINATIM_FULL_TEST_PORT = 29_383
const LIBPOSTAL_TEST_PORT = 29_381

/**
 * Wall-clock budget for the missing-data preflight to exit. It fails fast (before touching the neural runtime), so this
 * is a generous ceiling, not the measured cost — see `mailwoman/commands/geocode.test.ts` for the node-boot baseline
 * (~2.7 s) this margins against.
 */
const PREFLIGHT_TIMEOUT_MS = 30_000

/**
 * Wall-clock budget for a server to bind and answer its health route. Model load (ONNX + tokenizer +, for
 * photon/nominatim, opening the resolver backend) is the dominant cost; measured under 3 s warm on an idle box, so 30 s
 * leaves comfortable margin under load.
 */
const HEALTHY_TIMEOUT_MS = 30_000

/**
 * Vitest's own per-test ceiling — see the note in `corpus-cli.test.ts`: must exceed the child's own timeout PLUS
 * whatever this test queues behind the CLI-spawn lock (up to 120 s under contention). Generous costs nothing on a
 * passing test.
 */
const TEST_TIMEOUT_MS = 150_000

/**
 * The `data pull candidate` step in the gated suite streams ~1.65 GB; this budget is network-bound, not CPU-bound.
 */
const PULL_TIMEOUT_MS = 600_000

/**
 * The gated test's own vitest timeout: the pull, plus two server boots and a geocode call, each independently bounded.
 */
const GATED_TEST_TIMEOUT_MS = PULL_TIMEOUT_MS + 3 * HEALTHY_TIMEOUT_MS + 30_000

//#endregion

//#region Server lifecycle helpers

/**
 * A spawned long-running server plus its captured output — captured live (not just at exit) so a failed health check's
 * error message shows what the process actually printed.
 */
interface SpawnedServer {
	child: ChildProcess
	stdout: string
	stderr: string
}

function spawnServer(
	cliPath: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	// The HTTP drop-ins never read stdin, so it stays closed for them. `@mailwoman/mcp` IS its stdin — the
	// JSON-RPC transport runs over it — so the MCP round-trip below opens it.
	stdin: "ignore" | "pipe" = "ignore"
): SpawnedServer {
	const child = spawn("node", [cliPath, ...args], { env, stdio: [stdin, "pipe", "pipe"] })
	const server: SpawnedServer = { child, stdout: "", stderr: "" }

	child.stdout?.on("data", (chunk: Buffer) => {
		server.stdout += chunk.toString()
	})

	child.stderr?.on("data", (chunk: Buffer) => {
		server.stderr += chunk.toString()
	})

	return server
}

/**
 * Poll `GET /` until it answers 200 (every drop-in's landing route — always registered, unconditional on data-root
 * state) or `deadlineMs` elapses. Also fails fast if the child exits before ever becoming healthy — a crash loop should
 * not eat the whole timeout budget.
 */
async function waitForHealthy(server: SpawnedServer, port: number, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs

	while (Date.now() < deadline) {
		if (server.child.exitCode !== null || server.child.signalCode !== null) {
			throw new Error(
				`server exited before becoming healthy (code ${server.child.exitCode}, signal ${server.child.signalCode})\n` +
					`stderr:\n${server.stderr}`
			)
		}

		try {
			const res = await fetch(`http://127.0.0.1:${port}/`)

			if (res.ok) return
		} catch {
			// Not listening yet — keep polling.
		}

		await new Promise((resolve) => {
			setTimeout(resolve, 200)
		})
	}

	throw new Error(
		`server on port ${port} never answered GET / with 200 within ${deadlineMs}ms\nstderr:\n${server.stderr}`
	)
}

/**
 * SIGTERM + wait for exit (bounded by a SIGKILL fallback) — asserts the process actually goes away, not just that it
 * answered once.
 */
async function stopServer(server: SpawnedServer): Promise<void> {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return

	server.child.kill("SIGTERM")

	await new Promise<void>((resolve) => {
		const forceKill = setTimeout(() => {
			server.child.kill("SIGKILL")
			resolve()
		}, 5000)

		server.child.once("exit", () => {
			clearTimeout(forceKill)
			resolve()
		})
	})
}

/**
 * Drive an MCP stdio server through one round trip: `initialize`, `notifications/initialized`, then each requested
 * JSON-RPC call in order, resolving to the results in the same order. Hand-rolled rather than pulled from
 * `@modelcontextprotocol/sdk` because the point of the test is the WIRE — a client object that reconnects, retries or
 * reshapes an error would hide exactly the behaviour being asserted. The transport is newline-delimited JSON both ways
 * (`StdioServerTransport`), so a line-buffered reader is the whole protocol.
 */
async function mcpRoundTrip(
	cliPath: string,
	env: NodeJS.ProcessEnv,
	calls: ReadonlyArray<{ method: string; params: Record<string, unknown> }>
): Promise<{ results: Array<Record<string, unknown>>; stderr: string }> {
	const server = spawnServer(cliPath, [], env, "pipe")

	cleanupServers.push(server)

	let buffer = ""
	const pending = new Map<number, (value: Record<string, unknown>) => void>()

	server.child.stdout?.on("data", () => {
		buffer = server.stdout
		let start = 0
		let index: number

		while ((index = buffer.indexOf("\n", start)) >= 0) {
			const line = buffer.slice(start, index).trim()

			start = index + 1

			if (!line) continue

			// A partial line parses to null and is simply skipped — the next chunk completes it, and
			// `server.stdout` accumulates the whole stream. Degrading is the contract here, not an error.
			const message = tryParsingJSON<{ id?: number; result?: Record<string, unknown> }>(line)
			const resolve = message && typeof message.id === "number" ? pending.get(message.id) : undefined

			if (resolve && message?.result) {
				pending.delete(message.id!)
				resolve(message.result)
			}
		}
	})

	let nextID = 0

	const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const id = ++nextID

		return new Promise((resolve, reject) => {
			pending.set(id, resolve)
			server.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)

			setTimeout(() => {
				reject(new Error(`MCP ${method} timed out\nstderr:\n${server.stderr}`))
			}, HEALTHY_TIMEOUT_MS)
		})
	}

	await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "dropin-cold-start", version: "0.0.0" },
	})

	server.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

	const results: Array<Record<string, unknown>> = []

	for (const call of calls) {
		results.push(await request(call.method, call.params))
	}

	await stopServer(server)

	return { results, stderr: server.stderr }
}

//#endregion

/**
 * Fresh, empty data root — never populated, so the "missing data" + "libpostal needs none" tests download nothing.
 */
function freshDataRoot(): string {
	return mkdtempSync(join(tmpdir(), "mw-cold-start-"))
}

const cleanupRoots: string[] = []
const cleanupServers: SpawnedServer[] = []

afterEach(async () => {
	for (const server of cleanupServers.splice(0)) {
		await stopServer(server)
	}

	for (const root of cleanupRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true })
	}
})

describe.skipIf(!hasPhotonCLI)("mailwoman-photon serve — cold start, no data", () => {
	test(
		"exits non-zero within 30s and stderr names the mailwoman data pull fix",
		async () => {
			const dataRoot = freshDataRoot()

			cleanupRoots.push(dataRoot)

			await expect(
				withCLISpawnLockAsync(() =>
					execFileAsync("node", [PHOTON_CLI, "serve", "--port", String(PHOTON_TEST_PORT)], {
						timeout: PREFLIGHT_TIMEOUT_MS,
						env: childEnv({ MAILWOMAN_DATA_ROOT: dataRoot, NODE_NO_WARNINGS: "1" }),
					})
				)
			).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining("mailwoman data pull"),
			})
		},
		TEST_TIMEOUT_MS
	)
})

describe.skipIf(!hasNominatimCLI)("mailwoman-nominatim serve — cold start, no data", () => {
	test(
		"exits non-zero within 30s and stderr names the mailwoman data pull fix",
		async () => {
			const dataRoot = freshDataRoot()

			cleanupRoots.push(dataRoot)

			await expect(
				withCLISpawnLockAsync(() =>
					execFileAsync("node", [NOMINATIM_CLI, "serve", "--port", String(NOMINATIM_TEST_PORT)], {
						timeout: PREFLIGHT_TIMEOUT_MS,
						env: childEnv({ MAILWOMAN_DATA_ROOT: dataRoot, NODE_NO_WARNINGS: "1" }),
					})
				)
			).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining("mailwoman data pull"),
			})
		},
		TEST_TIMEOUT_MS
	)
})

describe.skipIf(!hasLibpostalCLI)("mailwoman-libpostal serve — cold start, zero data needed", () => {
	test(
		"binds and answers GET / with 200 from a bare data root, then shuts down clean on SIGTERM",
		async () => {
			const dataRoot = freshDataRoot()

			cleanupRoots.push(dataRoot)

			await withCLISpawnLockAsync(async () => {
				const server = spawnServer(
					LIBPOSTAL_CLI,
					["serve", "--port", String(LIBPOSTAL_TEST_PORT)],
					childEnv({ MAILWOMAN_DATA_ROOT: dataRoot })
				)

				cleanupServers.push(server)

				await waitForHealthy(server, LIBPOSTAL_TEST_PORT, HEALTHY_TIMEOUT_MS)

				const res = await fetch(
					`http://127.0.0.1:${LIBPOSTAL_TEST_PORT}/parse?query=1600%20Pennsylvania%20Ave%20NW%2C%20Washington%20DC%2020500`
				)

				expect(res.status).toBe(200)
				const body = (await res.json()) as Array<{ label: string; value: string }>

				expect(body.some((c) => c.label === "house_number" && c.value === "1600")).toBe(true)

				await stopServer(server)
				expect(server.child.exitCode ?? server.child.signalCode).not.toBeNull()
			})
		},
		TEST_TIMEOUT_MS
	)
})

describe("mailwoman-mcp — cold start over stdio, no data", () => {
	test("declares @mailwoman/neural-weights-en-us, so a standalone npm install can load the model", () => {
		const manifest = parseJSONStrict<{ dependencies: Record<string, string> }>(readFileSync(MCP_PACKAGE_JSON, "utf8"))

		// The regression this pins: `@mailwoman/mcp@8.6.0` shipped without it (checked against the registry
		// 2026-08-03), so `npm install @mailwoman/mcp` in a clean directory installed no weights package and
		// every model-backed tool answered `Could not resolve @mailwoman/neural-weights-en-us`. A runtime
		// assertion cannot see this — yarn hoists the sibling workspace regardless — so the manifest IS the test.
		expect(manifest.dependencies["@mailwoman/neural-weights-en-us"]).toBe("workspace:*")
	})

	test.skipIf(!hasMCPCLI)(
		"connects and lists its tools with no data, and mailwoman_parse answers with the data-pull fix",
		async () => {
			const dataRoot = freshDataRoot()

			cleanupRoots.push(dataRoot)

			await withCLISpawnLockAsync(async () => {
				const { results } = await mcpRoundTrip(
					MCP_CLI,
					childEnv({ MAILWOMAN_DATA_ROOT: dataRoot, MAILWOMAN_CANDIDATE_DB: "", NODE_NO_WARNINGS: "1" }),
					[
						{ method: "tools/list", params: {} },
						{
							method: "tools/call",
							params: { name: "mailwoman_parse", arguments: { text: "1600 Pennsylvania Ave NW, Washington DC" } },
						},
					]
				)

				// Listing tools needs neither the model nor a gazetteer — the whole point of the lazy deps.
				const [list, call] = results as [
					{ tools: Array<{ name: string }> },
					{ isError?: boolean; content: Array<{ text: string }> },
				]

				expect(list.tools.map((t) => t.name)).toContain("mailwoman_parse")
				expect(list.tools.map((t) => t.name)).toContain("mailwoman_layer_manifest")

				// Calling one does, and the failure has to name the fix rather than the internal shard error.
				expect(call.isError).toBe(true)
				expect(call.content[0]!.text).toContain("mailwoman data pull candidate")
				expect(call.content[0]!.text).not.toContain("resolveShards")
			})
		},
		TEST_TIMEOUT_MS
	)
})

//#region Gated: real data pull + Paris/Texas retest

const isFull = $public.MAILWOMAN_COLD_START_FULL === "1"

describe.skipIf(!isFull || !hasMailwomanCLI || !hasPhotonCLI || !hasNominatimCLI)(
	"drop-in cold start WITH data (gated: MAILWOMAN_COLD_START_FULL=1)",
	() => {
		test(
			"mailwoman data pull candidate + photon/nominatim serve bind and answer 200; Paris routes to France not Texas",
			async () => {
				const reuseRoot = $public.MAILWOMAN_COLD_START_DATA_ROOT
				const dataRoot = reuseRoot ?? freshDataRoot()

				if (!reuseRoot) {
					cleanupRoots.push(dataRoot)
				}

				await withCLISpawnLockAsync(() =>
					execFileAsync("node", [MAILWOMAN_CLI, "data", "pull", "candidate"], {
						timeout: PULL_TIMEOUT_MS,
						env: childEnv({ MAILWOMAN_DATA_ROOT: dataRoot }),
					})
				)

				// photon: auto-detects the convention-path candidate.db — NO $MAILWOMAN_CANDIDATE_DB export needed.
				// Since #1444 that fallback lives in `resolveCandidateDBPath` itself, so it is no longer a
				// photon/nominatim special case: every entry point reads the convention path.
				await withCLISpawnLockAsync(async () => {
					const server = spawnServer(
						PHOTON_CLI,
						["serve", "--port", String(PHOTON_FULL_TEST_PORT)],
						childEnv({ MAILWOMAN_DATA_ROOT: dataRoot })
					)

					cleanupServers.push(server)
					await waitForHealthy(server, PHOTON_FULL_TEST_PORT, HEALTHY_TIMEOUT_MS)
					expect(server.stderr).toContain("candidate gazetteer (worldwide)")
					await stopServer(server)
				})

				await withCLISpawnLockAsync(async () => {
					const server = spawnServer(
						NOMINATIM_CLI,
						["serve", "--port", String(NOMINATIM_FULL_TEST_PORT)],
						childEnv({ MAILWOMAN_DATA_ROOT: dataRoot })
					)

					cleanupServers.push(server)
					await waitForHealthy(server, NOMINATIM_FULL_TEST_PORT, HEALTHY_TIMEOUT_MS)
					expect(server.stderr).toContain("candidate gazetteer (worldwide)")
					await stopServer(server)
				})

				// The ledgered Paris/Texas finding: `mailwoman geocode` (unlike the drop-ins) resolves the candidate
				// gazetteer ONLY via $MAILWOMAN_CANDIDATE_DB — the export step `buildNoGazetteerMessage` prints for it.
				const { stdout } = await withCLISpawnLockAsync(() =>
					execFileAsync("node", [MAILWOMAN_CLI, "geocode", "12 Rue de Rivoli, 75001 Paris"], {
						timeout: PREFLIGHT_TIMEOUT_MS,
						env: childEnv({
							MAILWOMAN_DATA_ROOT: dataRoot,
							MAILWOMAN_CANDIDATE_DB: join(dataRoot, "wof", "candidate.db"),
						}),
					})
				)

				const result = parseJSONStrict<{ lat: number; lon: number; countryCode: string | null }>(stdout)

				expect(result.countryCode).toBe("FR")
				// Paris, France — not Paris, TX (32.96, -96.84).
				expect(result.lat).toBeCloseTo(48.8566, 1)
				expect(result.lon).toBeCloseTo(2.3428, 1)
			},
			GATED_TEST_TIMEOUT_MS
		)
	}
)

//#endregion
