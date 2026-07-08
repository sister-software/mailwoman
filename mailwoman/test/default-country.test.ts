/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regression guard for `parse --default-country` (the resolver country scope). Without a country
 *   hint the WOF resolver resolves globally; the demo passes `country: "US"`, and this gives the
 *   CLI parity by inferring the country from `--locale` (overridable, `none` to disable).
 *
 *   Note (#595): a bare region abbreviation (`NY`) once landed on a foreign homonym (a Scottish
 *   locality at lat ~57) without a country hint — the original motivation. WOF ranking has since
 *   improved so US New York now wins even unfiltered, so `NY` no longer demonstrates the opt-out.
 *   The end-to-end test instead uses `Paris, TX`, which still flips: with the en-US hint it
 *   resolves to Paris, TEXAS (lat ~33.7); with `--default-country none` the global ranking picks
 *   the far-more- populous Paris, FRANCE (lat ~48.9) — a live differential that proves the opt-out
 *   changes the result.
 *
 *   The unit tests (the locale→country inference + the override precedence) are CI-safe. The
 *   end-to-end resolution check needs the GLOBAL admin DB, so it skips when that DB is absent.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

import { $public } from "@mailwoman/core/env"
import { childEnv, dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, test } from "vitest"

import { localeToCountry, options as parseOptions, resolverDefaultCountry } from "../commands/parse.js"

const exec = promisify(execFile)
const cliBin = repoRootPath("out", "cli.js")
const GLOBAL_WOF = $public.MAILWOMAN_WOF_GLOBAL_DB ?? String(dataRootPath("wof", "admin-global-priority.db"))

describe("localeToCountry", () => {
	test("infers the ISO country from a BCP-47 region subtag", () => {
		expect(localeToCountry("en-US")).toBe("US")
		expect(localeToCountry("fr-FR")).toBe("FR")
		expect(localeToCountry("de-DE")).toBe("DE")
	})
	test("ignores script subtags and language-only tags (no guessing)", () => {
		expect(localeToCountry("en")).toBeUndefined()
		expect(localeToCountry("zh-Hant")).toBeUndefined() // 4-letter script subtag, not a region
		expect(localeToCountry(undefined)).toBeUndefined()
	})
	test("reads the trailing region of a multi-subtag tag", () => {
		expect(localeToCountry("zh-Hant-TW")).toBe("TW")
	})
})

describe("resolverDefaultCountry", () => {
	test("explicit --default-country wins over the locale", () => {
		expect(resolverDefaultCountry({ defaultCountry: "FR", locale: "en-US" })).toBe("FR")
	})
	test("falls back to the locale's country when unset", () => {
		expect(resolverDefaultCountry({ locale: "de-DE" })).toBe("DE")
	})
	test("'none' disables the filter", () => {
		expect(resolverDefaultCountry({ defaultCountry: "none", locale: "en-US" })).toBeUndefined()
	})
})

describe("--default-country schema validation", () => {
	test("accepts an explicit ISO country", () => {
		expect(parseOptions.parse({ defaultCountry: "US" }).defaultCountry).toBe("US")
	})
	test("is optional (undefined when omitted)", () => {
		expect(parseOptions.parse({}).defaultCountry).toBeUndefined()
	})
})

// End-to-end: needs the GLOBAL admin DB (the US-only DB can't reproduce the foreign homonym).
const describeIfGlobal = describe.skipIf(!existsSync(GLOBAL_WOF))
describeIfGlobal(`parse --resolve against the global WOF (${GLOBAL_WOF})`, () => {
	const run = (address: string, extra: string[] = []) =>
		exec(
			"node",
			[cliBin, "parse", "--neural", "--resolve", "--resolve-db", GLOBAL_WOF, "--format", "xml", ...extra, address],
			{
				env: childEnv({ NODE_NO_WARNINGS: "1" }),
				maxBuffer: 4 * 1024 * 1024,
			}
		)

	// The resolver prints lat/lon on the line after the opening tag; `[^>]*` spans that newline.
	const localityLat = (xml: string): number | null => {
		const m = /<locality[^>]*lat="([-0-9.]+)"/.exec(xml)

		return m ? Number(m[1]) : null
	}

	test("default (US inferred from en-US) resolves New York to the US city, not a foreign homonym", async () => {
		const { stdout } = await run("350 5th Ave, New York, NY 10118")
		// Locality "New York" resolves to a NYC-range coordinate (lat 40–41).
		const m = /locality[^>]*lat="(4[01]\.\d+)" lon="(-7[34]\.\d+)"/.exec(stdout)
		expect(m, `expected a NYC-range locality coordinate, got:\n${stdout}`).not.toBeNull()
	})

	test("--default-country scoping is a real mechanism: US vs FR flips the resolved namesake", async () => {
		// `Paris, TX`, no postcode (a postcode would re-pin the country via the #369 anchor). The en-US
		// default scopes "Paris" to Paris, TEXAS (~33.7°N); an explicit `--default-country FR` scopes it to
		// Paris, FRANCE (~48.9°N). Same input, different country scope, demonstrably different place.
		// HISTORY: this probe used `--default-country none` and asserted the unscoped ranking picks the
		// more-populous foreign twin (itself replacing the NY→Scotland probe #595 found dead). That premise
		// broke on current gazetteer artifacts — unscoped ranking now keeps US namesakes (#905, pre-existing
		// on main, invisible in CI because this suite needs the lab DB). Probing an EXPLICIT scope flip tests
		// the same mechanism without depending on global-ranking policy. adminCoherence is pinned off so the
		// probe observes scoping alone (default-ON since #895 — asserted separately below).
		const usLat = localityLat((await run("Paris, TX")).stdout)
		const frLat = localityLat((await run("Paris, TX", ["--default-country", "FR", "--no-admin-coherence"])).stdout)

		expect(usLat, "expected a Paris locality under the en-US default").not.toBeNull()
		expect(frLat, "expected a Paris locality under --default-country FR").not.toBeNull()
		// Default → Paris, Texas (≈ 33.7°N); FR scope → Paris, France (≈ 48.9°N).
		expect(usLat!).toBeGreaterThan(32)
		expect(usLat!).toBeLessThan(36)
		expect(frLat!).toBeGreaterThan(45)
		// The point of the test: the scope changed the resolved place.
		expect(usLat).not.toBe(frLat)
	})

	test("adminCoherence (default-ON, #895) binds a namesake to its region token even with no country scope", async () => {
		// The #833 class: with coherence ON (the default), "Paris, TX" under `--default-country none`
		// stays Paris, TEXAS — the region token wins over the more-populous foreign twin. This is the
		// behavior the greedy probe above must pin OFF to observe raw ranking.
		const lat = localityLat((await run("Paris, TX", ["--default-country", "none"])).stdout)

		expect(lat, "expected a Paris locality").not.toBeNull()
		expect(lat!).toBeGreaterThan(32)
		expect(lat!).toBeLessThan(36)
	})
})
