/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the `mailwoman geocode` command.
 *
 *   Structure mirrors `reverse.test.ts`: unconditional argument-validation tests that run in every
 *   environment, plus DB-gated integration tests (`describe.skipIf`) that gate on live shard files
 *   being present on disk.
 *
 *   Integration suite paths:
 *
 *   - WOF admin DB: $MAILWOMAN_WOF_DB or /mnt/playpen/mailwoman-data/wof/admin-global-priority.db
 *   - Address-point shard: --address-points-db flag (explicit, skips state-selection)
 *   - Interpolation shard: --interpolation-db flag (explicit, skips state-selection)
 *
 *   The integration test demonstrates the compiled CLI geocoding a real TX address with explicit
 *   shard overrides, expecting a street-level coordinate near 30.5, -97.6.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $public } from "@mailwoman/core/env"
import { childEnv, dataRootPath, repoRootPathBuilder } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLI_PATH = String(repoRootPathBuilder("mailwoman", "out", "cli.js"))

const DEFAULT_WOF_PATH = String(dataRootPath("wof", "admin-global-priority.db"))
const wofPath = $public.MAILWOMAN_WOF_DB ?? DEFAULT_WOF_PATH

// Per-state TX shards (the demo address is Round Rock, TX).
const TX_ADDRESS_POINTS_DB = "/mnt/playpen/mailwoman-data/address-points/address-points-us-tx.db"
const TX_INTERPOLATION_DB = "/mnt/playpen/mailwoman-data/interpolation/interpolation-us-tx.db"

const hasWOFDb = existsSync(wofPath)
const hasCLICompiled = existsSync(CLI_PATH)
const hasTxAddressPoints = existsSync(TX_ADDRESS_POINTS_DB)
const hasTxInterpolation = existsSync(TX_INTERPOLATION_DB)

// ---------------------------------------------------------------------------
// Argument-validation tests (unconditional — no DB required)
// ---------------------------------------------------------------------------

describe("geocode argument validation", () => {
	test("missing address argument exits 1 with a descriptive error", () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}
		expect(() =>
			execFileSync(process.execPath, [CLI_PATH, "geocode"], {
				encoding: "utf8",
				// Set a bogus WOF path so the command fails on arg validation, not on missing DB.
				env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
				timeout: 10_000,
			})
		).toThrow()
	})

	test("empty address string exits 1", () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}
		expect(() =>
			execFileSync(process.execPath, [CLI_PATH, "geocode", "   "], {
				encoding: "utf8",
				env: childEnv({ MAILWOMAN_WOF_DB: "/nonexistent/wof.db" }),
				timeout: 10_000,
			})
		).toThrow()
	})

	test("missing WOF DB exits 1 with a descriptive error (empty data root — the default shard set no longer exists)", () => {
		if (!hasCLICompiled) {
			console.warn("Skipping: CLI not compiled at", CLI_PATH)

			return
		}
		let threw = false
		let output = ""

		try {
			execFileSync(process.execPath, [CLI_PATH, "geocode", "123 Main St, Anytown, TX 78000"], {
				encoding: "utf8",
				// Unset the env var AND point the data root at an empty dir: since the proximity-bias
				// pass, geocode auto-attaches the wofShardPaths default set when the env is absent —
				// on a standard data root that now SUCCEEDS (the new contract). The error contract
				// only survives when no default shard exists either.
				env: childEnv({
					MAILWOMAN_WOF_DB: undefined,
					MAILWOMAN_DATA_ROOT: mkdtempSync(join(tmpdir(), "mw-empty-")),
				}),
				timeout: 15_000,
			})
		} catch (err: unknown) {
			threw = true
			const execErr = err as { stderr?: string; stdout?: string }
			// Pastel renders errors to stdout (as a React component); stderr may be empty.
			output = (execErr.stdout ?? "") + (execErr.stderr ?? "")
		}
		expect(threw).toBe(true)
		// The error message should mention how to provide a DB path.
		expect(output).toMatch(/MAILWOMAN_WOF_DB|resolve-db|wof/i)
	})
})

// ---------------------------------------------------------------------------
// DB-gated integration tests
// ---------------------------------------------------------------------------

const hasTxShards = hasTxAddressPoints && hasTxInterpolation

/**
 * Integration: compiled CLI geocodes a real Round Rock, TX address with explicit shard overrides. Expects a
 * street-level coordinate near 30.5, -97.6 (Round Rock area).
 */
describe.skipIf(!hasCLICompiled || !hasWOFDb || !hasTxShards)(`geocode integration — ${wofPath} + TX shards`, () => {
	const TX_ADDRESS = "2929 Flower Hill Drive, Round Rock, TX 78664"

	test("street-level geocode returns address_point or interpolated tier near Round Rock, TX", () => {
		const stdout = execFileSync(
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

		const result = JSON.parse(stdout) as {
			lat: number | null
			lon: number | null
			resolution_tier: string
			uncertainty_m: number | null
			locality: string | null
			region: string | null
		}

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

	test("--format=text produces readable output with coordinate line", () => {
		const stdout = execFileSync(
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

		expect(stdout).toMatch(/resolution_tier/)
		expect(stdout).toMatch(/coordinate/)
	}, 60_000)
})

/**
 * Admin-only degradation: when no shard is provided, geocode still returns a coordinate from the WOF admin centroid.
 */
describe.skipIf(!hasCLICompiled || !hasWOFDb)(`geocode admin-only degradation — ${wofPath}`, () => {
	test("geocodes to admin centroid when no shards provided", () => {
		const stdout = execFileSync(process.execPath, [CLI_PATH, "geocode", "Round Rock, TX", `--resolve-db=${wofPath}`], {
			encoding: "utf8",
			timeout: 60_000,
		})

		const result = JSON.parse(stdout) as {
			lat: number | null
			lon: number | null
			resolution_tier: string
			locality: string | null
			region: string | null
		}

		// Even without street-level shards, admin resolution should produce a coordinate.
		expect(result.lat).not.toBeNull()
		expect(result.lon).not.toBeNull()
		expect(result.resolution_tier).toBe("admin")
	}, 60_000)
})
