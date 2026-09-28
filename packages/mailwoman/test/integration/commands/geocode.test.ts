/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `mailwoman geocode` command: unconditional argument-validation tests plus DB-conditional integration tests gated on live database files being present.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import {
	addressPointDatabasePath,
	interpolationDatabasePath,
	wofDatabasePath,
} from "@mailwoman/resolver-wof-sqlite/paths"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { $public } from "mailwoman/env"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { describe, expect, test, vi } from "vitest"

const CLI_PATH = await mailwomanCLIPath()

const DEFAULT_WOF_PATH = wofDatabasePath("admin-global-priority.db")
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH

const TX_ADDRESS_POINTS_DB = addressPointDatabasePath("address-points-us-tx.db")
const TX_INTERPOLATION_DB = interpolationDatabasePath("interpolation-us-tx.db")

/**
 * Wall-clock budget for a CLI spawn, set to absorb the eight concurrent spawns
 * vitest can run rather than a single-spawn cost.
 */
const CLI_SPAWN_TIMEOUT_MS = 45_000

/**
 * Per-test budget, which must exceed {@link CLI_SPAWN_TIMEOUT_MS} plus time queued on the spawn lock.
 */
const CLI_TEST_TIMEOUT_MS = 120_000

/**
 * Vitest's per-test budget for this whole file, set at file scope because every test
 * spawns the compiled CLI and queues behind {@link withCLISpawnLockAsync}.
 */
vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const hasWOFDB = await pathExists(wofPath)
const hasCLICompiled = await pathExists(CLI_PATH)
const hasTxAddressPoints = await pathExists(TX_ADDRESS_POINTS_DB)
const hasTxInterpolation = await pathExists(TX_INTERPOLATION_DB)

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
					// Set a bogus WOF path so the command fails on arg validation rather than on missing DB.
					env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
					timeout: CLI_SPAWN_TIMEOUT_MS,
				})
			)
		} catch (error: unknown) {
			threw = true
			const execErr = error as { stdout?: string; stderr?: string; code?: number }
			output = (execErr.stdout ?? "") + (execErr.stderr ?? "")
			// The promisified spawn carries the exit code in `.code`.
			status = execErr.code
		}

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

		// Rejected before any database or weights work, so this test needs neither.
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
					// Unset the env var and point the data root at an empty dir so the error interface
					// is reached, since a default database set would otherwise be auto-attached.
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
		expect(output).toMatch(/MAILWOMAN_WOF_DB|resolve-db|wof/i)
	})
})

const hasTxDatabases = hasTxAddressPoints && hasTxInterpolation

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

			expect(result.lat).not.toBeNull()
			expect(result.lon).not.toBeNull()

			expect(result.lat!).toBeGreaterThan(29.5)
			expect(result.lat!).toBeLessThan(31.5)
			expect(result.lon!).toBeGreaterThan(-98.5)
			expect(result.lon!).toBeLessThan(-96.5)

			expect(["address_point", "interpolated"]).toContain(result.resolution_tier)

			expect(result.uncertainty_m).not.toBeNull()

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
			const { stdout } = await withCLISpawnLockAsync(() =>
				runFile(process.execPath, [CLI_PATH, "geocode", "Toledo Ohio", `--resolve-db=${wofPath}`], {
					encoding: "utf8",
					timeout: 60_000,
				})
			)

			const result = parseJSONStrict<{ lat: number | null; lon: number | null }>(stdout)

			expect(result.lat).not.toBeNull()
			expect(result.lon).not.toBeNull()
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

		expect(result.lat).not.toBeNull()
		expect(result.lon).not.toBeNull()
		expect(result.resolution_tier).toBe("admin")
	}, 60_000)
})
