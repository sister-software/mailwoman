import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories } from "@mailwoman/core/fs/writers"
import { parseJSONStrict, tryParsingJSON, stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { workspacePath } from "@mailwoman/core/paths"
import { type ChildProcess, runFile, spawnProcess } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { $public } from "mailwoman/env"
import { conventionCandidateDBPath } from "mailwoman/resolver-backend"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { PathBuilder } from "path-ts"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const PHOTON_CLI = workspacePath("photon", "out", "cli.js")
const NOMINATIM_CLI = workspacePath("nominatim", "out", "cli.js")
const LIBPOSTAL_CLI = workspacePath("libpostal", "out", "cli.js")
const MAILWOMAN_CLI = await mailwomanCLIPath()
const MCP_CLI = workspacePath("mcp", "out", "cli.js")
const MCP_PACKAGE_JSON = workspacePath("mcp", "package.json")

const hasPhotonCLI = await pathExists(PHOTON_CLI)
const hasNominatimCLI = await pathExists(NOMINATIM_CLI)
const hasMCPCLI = await pathExists(MCP_CLI)
const hasLibpostalCLI = await pathExists(LIBPOSTAL_CLI)
const hasMailwomanCLI = await pathExists(MAILWOMAN_CLI)

const PHOTON_TEST_PORT = 29_322
const PHOTON_FULL_TEST_PORT = 29_323
const NOMINATIM_TEST_PORT = 29_380
const NOMINATIM_FULL_TEST_PORT = 29_383
const LIBPOSTAL_TEST_PORT = 29_381

const PREFLIGHT_TIMEOUT_MS = 30_000

const HEALTHY_TIMEOUT_MS = 30_000

const TEST_TIMEOUT_MS = 150_000

const PULL_TIMEOUT_MS = 600_000

const CONDITIONAL_TEST_TIMEOUT_MS = PULL_TIMEOUT_MS + 3 * HEALTHY_TIMEOUT_MS + 30_000

interface SpawnedServer {
	child: ChildProcess
	stdout: string
	stderr: string
}

function spawnServer(
	cliPath: string,
	args: string[],
	env: NodeJS.ProcessEnv,

	stdin: "ignore" | "pipe" = "ignore"
): SpawnedServer {
	const child = spawnProcess("node", [cliPath, ...args], { env, stdio: [stdin, "pipe", "pipe"] })
	const server: SpawnedServer = { child, stdout: "", stderr: "" }

	child.stdout?.on("data", (chunk: Buffer) => {
		server.stdout += chunk.toString()
	})

	child.stderr?.on("data", (chunk: Buffer) => {
		server.stderr += chunk.toString()
	})

	return server
}

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
		} catch {}

		await new Promise((resolve) => {
			setTimeout(resolve, 200)
		})
	}

	throw new Error(
		`server on port ${port} never answered GET / with 200 within ${deadlineMs}ms\nstderr:\n${server.stderr}`
	)
}

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
			server.child.stdin?.write(`${stringifyJSON({ jsonrpc: "2.0", id, method, params })}\n`)

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

	server.child.stdin?.write(`${stringifyJSON({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

	const results: Array<Record<string, unknown>> = []

	for (const call of calls) {
		results.push(await request(call.method, call.params))
	}

	await stopServer(server)

	return { results, stderr: server.stderr }
}

async function freshDataRoot(): Promise<string> {
	return fixtures.use(await temporaryDirectory("mw-cold-start-")).path.toString()
}

const cleanupServers: SpawnedServer[] = []

afterEach(async () => {
	for (const server of cleanupServers.splice(0)) {
		await stopServer(server)
	}
})

describe.skipIf(!hasPhotonCLI)("Mailwoman-photon serve — cold start without data", () => {
	test(
		"exits non-zero within 30s and stderr names the mailwoman data pull fix",
		async () => {
			const dataRoot = await freshDataRoot()

			await expect(
				withCLISpawnLockAsync(() =>
					runFile("node", [PHOTON_CLI, "serve", "--port", String(PHOTON_TEST_PORT)], {
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

describe.skipIf(!hasNominatimCLI)("Mailwoman-nominatim serve — cold start without data", () => {
	test(
		"exits non-zero within 30s and stderr names the mailwoman data pull fix",
		async () => {
			const dataRoot = await freshDataRoot()

			await expect(
				withCLISpawnLockAsync(() =>
					runFile("node", [NOMINATIM_CLI, "serve", "--port", String(NOMINATIM_TEST_PORT)], {
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
		async (ctx) => {
			const dataRoot = await freshDataRoot()

			const { resolveWeights } = await import("@mailwoman/neural/weights")

			let seed: { modelPath: string; tokenizerPath: string; modelCardPath?: string | undefined }

			try {
				seed = await resolveWeights({ locale: "en-us" })
			} catch (error) {
				// oxlint-disable-next-line mailwoman/prefer-spliterator -- an Error message is bounded and only its first line is displayed
				ctx.skip(true, `no en-us weights resolvable in this environment — ${(error as Error).message.split("\n")[0]}`)

				return
			}

			const overlay = PathBuilder.from(dataRoot)("weights", "en-us")

			await makeDirectories(overlay)
			await createSymbolicLink(seed.modelPath, overlay("model.onnx"))
			await createSymbolicLink(seed.tokenizerPath, overlay("tokenizer.model"))

			if (seed.modelCardPath) {
				await createSymbolicLink(seed.modelCardPath, overlay("model-card.json"))
			}

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

describe("Mailwoman-mcp — cold start over stdio without data", () => {
	test("declares @mailwoman/neural-weights-en-us, so a standalone npm install can load the model", async () => {
		const manifest = await readPackageJSON(MCP_PACKAGE_JSON)

		expect(manifest.dependencies?.["@mailwoman/neural-weights-en-us"]).toBe("workspace:*")
	})

	test.skipIf(!hasMCPCLI)(
		"connects and lists its tools with no data, and mailwoman_parse answers with the data-pull fix",
		async () => {
			const dataRoot = await freshDataRoot()

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

				const [list, call] = results as [
					{ tools: Array<{ name: string }> },
					{ isError?: boolean; content: Array<{ text: string }> },
				]

				expect(list.tools.map((t) => t.name)).toContain("mailwoman_parse")
				expect(list.tools.map((t) => t.name)).toContain("mailwoman_layer_manifest")

				expect(call.isError).toBe(true)
				expect(call.content[0]!.text).toContain("mailwoman data pull candidate")
				expect(call.content[0]!.text).not.toContain("resolveExtracts")
			})
		},
		TEST_TIMEOUT_MS
	)
})

const isFull = $public.MAILWOMAN_COLD_START_FULL === "1"

describe.skipIf(!isFull || !hasMailwomanCLI || !hasPhotonCLI || !hasNominatimCLI)(
	"drop-in cold start WITH data (conditional: MAILWOMAN_COLD_START_FULL=1)",
	() => {
		test(
			"mailwoman data pull candidate + photon/nominatim serve bind and answer 200; Paris routes to France not Texas",
			async () => {
				const reuseRoot = $public.MAILWOMAN_COLD_START_DATA_ROOT

				const dataRoot = reuseRoot ?? (await freshDataRoot())

				await withCLISpawnLockAsync(() =>
					runFile("node", [MAILWOMAN_CLI, "data", "pull", "candidate"], {
						timeout: PULL_TIMEOUT_MS,
						env: childEnv({ MAILWOMAN_DATA_ROOT: dataRoot }),
					})
				)

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

				const { stdout } = await withCLISpawnLockAsync(() =>
					runFile("node", [MAILWOMAN_CLI, "geocode", "12 Rue de Rivoli, 75001 Paris"], {
						timeout: PREFLIGHT_TIMEOUT_MS,
						env: childEnv({
							MAILWOMAN_DATA_ROOT: dataRoot,

							MAILWOMAN_CANDIDATE_DB: conventionCandidateDBPath(dataRoot),
						}),
					})
				)

				const result = parseJSONStrict<{ lat: number; lon: number; countryCode: string | null }>(stdout)

				expect(result.countryCode).toBe("FR")

				expect(result.lat).toBeCloseTo(48.8566, 1)
				expect(result.lon).toBeCloseTo(2.3428, 1)
			},
			CONDITIONAL_TEST_TIMEOUT_MS
		)
	}
)
