/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `mailwoman geocode` command.
 *
 *   Structure mirrors `reverse.test.ts`: unconditional argument-validation tests that run in every
 *   environment, plus DB-conditional integration tests (`describe.skipIf`) that eval on live database files
 *   being present on disk.
 *
 *   Integration suite paths:
 *
 *   - WOF admin DB: $MAILWOMAN_WOF_DB or $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db
 *   - Address-point database: --address-points-db flag (explicit, skips state-selection)
 *   - Interpolation database: --interpolation-db flag (explicit, skips state-selection)
 *
 *   The integration test demonstrates the compiled CLI geocoding a real TX address with explicit
 *   database overrides, expecting a street-level coordinate near 30.5, -97.6.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/core/env"
import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { describe, expect, test, vi } from "vitest"

// MARK: Paths

const CLI_PATH = workspacePath("mailwoman", "out", "cli.js")

const DEFAULT_WOF_PATH = String(dataRootPath("wof", "admin-global-priority.db"))
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH

// Per-state TX databases (the demo address is Round Rock, TX).
const TX_ADDRESS_POINTS_DB = dataRootPath("address-points", "address-points-us-tx.db")
const TX_INTERPOLATION_DB = dataRootPath("interpolation", "interpolation-us-tx.db")

/**
 * Wall-clock budget for a CLI spawn.
 *
 * The old 10 s was set against an imagined fast path. Measured 2026-08-03 on an idle 16-core box, ONE `mailwoman
 * geocode` takes 5.62 s end to end — 2.73 s of it node boot plus this CLI's import graph, before any model is touched —
 * so the margin was 1.8x. Eight concurrent spawns reach 8.75 s, 87% of the old budget, and vitest runs test FILES in
 * parallel. That is why these "flaked": not randomness, a deterministic threshold sitting just under a floor nobody had
 * measured. A generous budget costs nothing on a passing test.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Per-test budget. Must exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock.
 */
const CLI_TEST_TIMEOUT_MS = 120_000

/**
 * Vitest's per-test budget for this whole file.
 *
 * Set at file scope rather than per test: every test here spawns the compiled CLI, which costs seconds before any
 * assertion runs and then queues behind {@link withCLISpawnLockAsync}. A per-test annotation has to be remembered on
 * each new test, and the one that forgets inherits the global 15s — which kills the test before the thing being
 * measured can report, surfacing as a bare timeout with no attribution.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const hasWOFDB = await pathExists(wofPath)
const hasCLICompiled = await pathExists(CLI_PATH)
const hasTxAddressPoints = await pathExists(TX_ADDRESS_POINTS_DB)
const hasTxInterpolation = await pathExists(TX_INTERPOLATION_DB)

// MARK: Argument-validation tests (unconditional — no DB required)

describe("geocode argument validation", () => {
	test("a bare `mailwoman geocode` prints the command's help and still exits 1", async () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}

		let threw = false
		let output = ""
		let status: number | undefined

		try {
			await withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode"], {
					encoding: "utf8",
					// Set a bogus WOF path so the command fails on arg validation, not on missing DB.
					env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)
		} catch (error: unknown) {
			threw = true
			const execErr = error as { stdout?: string; stderr?: string; code?: number }
			output = (execErr.stdout ?? "") + (execErr.stderr ?? "")
			// The promisified spawn carries the exit code in `.code`; the sync error exposed it as `.status`.
			status = execErr.code
		}

		// A missing required operand is a usage error, but the response still includes actionable command help.
		expect(threw).toBe(true)
		expect(status).toBe(1)
		expect(output).toMatch(/Usage:.*geocode/u)
		expect(output).toMatch(/--format/)
		expect(output).not.toMatch(/missing required argument/)
	})

	test("two output shorthands at once is a usage error, not a silent pick", async () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}

		let output = ""

		try {
			await withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode", "350 5th Ave, New York, NY", "--json", "--jsonld"], {
					encoding: "utf8",
					env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)
		} catch (error: unknown) {
			const execErr = error as { stdout?: string; stderr?: string }
			output = (execErr.stdout ?? "") + (execErr.stderr ?? "")
		}

		// Rejected BEFORE any database or weights work, so this test needs neither.
		expect(output).toMatch(/Pick one output format/)
	})

	test("empty address string exits 1", async () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}

		await expect(
			withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode", "   "], {
					encoding: "utf8",
					env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)
		).rejects.toThrow(/Command failed/)
	})

	test("missing WOF DB exits 1 with a descriptive error (empty data root — the default database set no longer exists)", async () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}

		let threw = false
		let output = ""
		await using emptyDataRootDirectory = await temporaryDirectory("mw-empty-")
		const emptyDataRoot = emptyDataRootDirectory.path.toString()

		try {
			await withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode", "123 Main St, Anytown, TX 78000"], {
					encoding: "utf8",
					// Unset the env var AND point the data root at an empty dir: since the proximity-bias
					// pass, geocode auto-attaches the wofExtractPaths default set when the env is absent —
					// on a standard data root that now SUCCEEDS (the new contract). The error contract
					// only survives when no default database exists either.
					env: childEnv({ MAILWOMAN_WOF_DB: undefined, MAILWOMAN_DATA_ROOT: emptyDataRoot }),
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)
		} catch (error: unknown) {
			threw = true
			const execErr = error as { stderr?: string; stdout?: string }
			// Accept either diagnostic stream because interactive commands may render through Ink.
			output = (execErr.stdout ?? "") + (execErr.stderr ?? "")
		}

		expect(threw).toBe(true)
		// The error message should mention how to provide a DB path.
		expect(output).toMatch(/MAILWOMAN_WOF_DB|resolve-db|wof/i)
	})
})

// MARK: DB-conditional integration tests

const hasTxDatabases = hasTxAddressPoints && hasTxInterpolation

/**
 * Integration: compiled CLI geocodes a real Round Rock, TX address with explicit database overrides. Expects a
 * street-level coordinate near 30.5, -97.6 (Round Rock area).
 */
describe.skipIf(!hasCLICompiled || !hasWOFDB || !hasTxDatabases)(
	`geocode integration — ${wofPath} + TX databases`,
	() => {
		const TX_ADDRESS = "2929 Flower Hill Drive, Round Rock, TX 78664"

		test("street-level geocode returns address_point or interpolated tier near Round Rock, TX", async () => {
			const { stdout } = await withCLISpawnLockAsync(() =>
				runFile(
					process.execPath,
					[
						CLI_PATH,
						"geocode",
						TX_ADDRESS,
						`--resolve-db=${wofPath}`,
						`--address-points-db=${TX_ADDRESS_POINTS_DB}`,
						`--interpolation-db=${TX_INTERPOLATION_DB}`,
					],
					{ encoding: "utf8", timeout: 60_000 }
				)
			)

			const result = parseJSONStrict<{
				lat: number | null
				lon: number | null
				resolution_tier: string
				uncertainty_m: number | null
				locality: string | null
				region: string | null
			}>(stdout)

			// We got a coordinate.
			expect(result.lat).not.toBeNull()
			expect(result.lon).not.toBeNull()

			// Coordinate is plausibly in the Round Rock, TX area (within ~50 km).
			expect(result.lat!).toBeGreaterThan(29.5)
			expect(result.lat!).toBeLessThan(31.5)
			expect(result.lon!).toBeGreaterThan(-98.5)
			expect(result.lon!).toBeLessThan(-96.5)

			// Should have resolved to address_point or interpolated (not admin centroid).
			expect(["address_point", "interpolated"]).toContain(result.resolution_tier)

			// Uncertainty_m should be set for non-admin tiers.
			expect(result.uncertainty_m).not.toBeNull()

			// Admin context is populated.
			expect(result.region).toBeTruthy()
		}, 60_000)

		test("--format=text produces readable output with coordinate line", async () => {
			const { stdout } = await withCLISpawnLockAsync(() =>
				runFile(
					process.execPath,
					[
						CLI_PATH,
						"geocode",
						TX_ADDRESS,
						`--resolve-db=${wofPath}`,
						`--address-points-db=${TX_ADDRESS_POINTS_DB}`,
						`--interpolation-db=${TX_INTERPOLATION_DB}`,
						"--format=text",
					],
					{ encoding: "utf8", timeout: 60_000 }
				)
			)

			expect(stdout).toMatch(/resolution_tier/)
			expect(stdout).toMatch(/coordinate/)
		}, 60_000)

		test("--format=json stdout is machine-parseable even with >80-col lines (Ink wrap regression)", async () => {
			// "Toledo Ohio" is a route_pair query: its intent_markers[].message is a ~140-char JSON
			// string. Before writeRawStdout (2026-08-07), Ink's <Text> renderer word-wrapped piped
			// output at 80 cols, inserting REAL newlines inside the JSON string and breaking
			// JSON.parse. This test fails against the unfixed CLI.
			const { stdout } = await withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode", "Toledo Ohio", `--resolve-db=${wofPath}`], {
					encoding: "utf8",
					timeout: 60_000,
				})
			)

			const result = parseJSONStrict<{ lat: number | null; lon: number | null }>(stdout)

			expect(result.lat).not.toBeNull()
			expect(result.lon).not.toBeNull()
			// Toledo, OH — the route_pair reading resolves to the toponym pair's locality.
			expect(result.lat!).toBeGreaterThan(41)
			expect(result.lat!).toBeLessThan(42)
		}, 60_000)

		test("--format=jsonld emits a valid schema.org Place JSON-LD object (#1052)", async () => {
			const { stdout } = await withCLISpawnLockAsync(() =>
				runFile(
					process.execPath,
					[
						CLI_PATH,
						"geocode",
						TX_ADDRESS,
						`--resolve-db=${wofPath}`,
						`--address-points-db=${TX_ADDRESS_POINTS_DB}`,
						`--interpolation-db=${TX_INTERPOLATION_DB}`,
						"--format=jsonld",
					],
					{ encoding: "utf8", timeout: 60_000 }
				)
			)

			const place = parseJSONStrict<{
				"@context": string
				"@type": string
				geo?: { "@type": string; latitude: number; longitude: number }
				address?: { "@type": string; streetAddress?: string; addressRegion?: string; addressCountry?: string }
			}>(stdout)

			expect(place["@context"]).toBe("https://schema.org")
			expect(place["@type"]).toBe("Place")
			// A street-level TX geocode carries a coordinate and a PostalAddress with the street line + ISO country.
			expect(place.geo?.["@type"]).toBe("GeoCoordinates")
			expect(place.geo?.latitude).toBeGreaterThan(29.5)
			expect(place.geo?.latitude).toBeLessThan(31.5)
			expect(place.address?.["@type"]).toBe("PostalAddress")
			expect(place.address?.streetAddress).toMatch(/Flower Hill/i)
			expect(place.address?.addressCountry).toBe("US")
			// Lossy by design: no resolution tier / uncertainty / candidates leak into the JSON-LD.
			expect(stdout).not.toMatch(/resolution_tier|uncertainty_m|candidates/)
		}, 60_000)

		test("--jsonld and --text are byte-identical shorthands for the --format values (#1577)", async () => {
			const run = async (...flags: string[]): Promise<string> => {
				const { stdout } = await withCLISpawnLockAsync(() =>
					runFile(process.execPath, [CLI_PATH, "geocode", TX_ADDRESS, `--resolve-db=${wofPath}`, ...flags], {
						encoding: "utf8",
						timeout: 60_000,
					})
				)

				return stdout
			}

			expect(await run("--jsonld")).toBe(await run("--format=jsonld"))
			expect(await run("--text")).toBe(await run("--format=text"))
		}, 240_000)
	}
)

/**
 * Admin-only degradation: when no database is provided, geocode still returns a coordinate from the WOF admin centroid.
 */
describe.skipIf(!hasCLICompiled || !hasWOFDB)(`geocode admin-only degradation — ${wofPath}`, () => {
	test("geocodes to admin centroid when no databases provided", async () => {
		const { stdout } = await withCLISpawnLockAsync(() =>
			runFile(process.execPath, [CLI_PATH, "geocode", "Round Rock, TX", `--resolve-db=${wofPath}`], {
				encoding: "utf8",
				timeout: 60_000,
			})
		)

		const result = parseJSONStrict<{
			lat: number | null
			lon: number | null
			resolution_tier: string
			locality: string | null
			region: string | null
		}>(stdout)

		// Even without street-level databases, admin resolution should produce a coordinate.
		expect(result.lat).not.toBeNull()
		expect(result.lon).not.toBeNull()
		expect(result.resolution_tier).toBe("admin")
	}, 60_000)
})
