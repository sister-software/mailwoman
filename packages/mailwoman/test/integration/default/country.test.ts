import { pathExists } from "@mailwoman/core/fs/readers"
import { runFile } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { mailwomanCLIPath } from "mailwoman/cli-kit/metadata"
import { parseCommand } from "mailwoman/cli-native/spec"
import { localeToCountry, resolverDefaultCountry, spec as parseSpec } from "mailwoman/commands/parse"
import { $public } from "mailwoman/env"
import { withCLISpawnLockAsync } from "mailwoman/test-kit/cli-spawn-lock"
import { describe, expect, test, vi } from "vitest"

const CLI_SPAWN_TIMEOUT_MS = 60_000
const CLI_TEST_TIMEOUT_MS = 120_000

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })

const cliBin = await mailwomanCLIPath()
const GLOBAL_WOF = $public.MAILWOMAN_WOF_GLOBAL_DB ?? wofDatabasePath("admin-global-priority.db")

describe("localeToCountry", () => {
	test("infers the ISO country from a BCP-47 region subtag", () => {
		expect(localeToCountry("en-US")).toBe("US")
		expect(localeToCountry("fr-FR")).toBe("FR")
		expect(localeToCountry("de-DE")).toBe("DE")
	})

	test("ignores script subtags and language-only tags (no guessing)", () => {
		expect(localeToCountry("en")).toBeUndefined()
		expect(localeToCountry("zh-Hant")).toBeUndefined()
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

describe("--country-scope separates country policy from the resolver backend", () => {
	test("'auto' passes locale country on both backends", () => {
		expect(resolverDefaultCountry({ locale: "en-US" }, false)).toBe("US")
		expect(resolverDefaultCountry({ locale: "en-US" }, true)).toBe("US")
	})

	test("'locale' scopes on either backend", () => {
		expect(resolverDefaultCountry({ locale: "en-US", countryScope: "locale" }, false)).toBe("US")
		expect(resolverDefaultCountry({ locale: "en-US", countryScope: "locale" }, true)).toBe("US")
	})

	test("'none' scopes on neither backend", () => {
		expect(resolverDefaultCountry({ locale: "en-US", countryScope: "none" }, false)).toBeUndefined()
		expect(resolverDefaultCountry({ locale: "en-US", countryScope: "none" }, true)).toBeUndefined()
	})

	test("an explicit --default-country outranks every scope", () => {
		expect(resolverDefaultCountry({ defaultCountry: "FR", locale: "en-US", countryScope: "none" }, true)).toBe("FR")

		expect(
			resolverDefaultCountry({ defaultCountry: "none", locale: "en-US", countryScope: "locale" }, false)
		).toBeUndefined()
	})

	test("the schema defaults to 'auto', so an unset flag preserves the old behavior", () => {
		expect(parseCommand(parseSpec, ["address"]).values["country-scope"]).toBe("auto")
	})
})

describe("--default-country schema validation", () => {
	test("accepts an explicit ISO country", () => {
		expect(parseCommand(parseSpec, ["--default-country", "US", "address"]).values["default-country"]).toBe("US")
	})

	test("is optional (undefined when omitted)", () => {
		expect(parseCommand(parseSpec, ["address"]).values["default-country"]).toBeUndefined()
	})
})

// oxlint-disable-next-line vitest/valid-title, vitest/valid-describe-callback -- an aliased describe. the title and callback arrive where it is invoked
const describeIfGlobal = describe.skipIf(!(await pathExists(GLOBAL_WOF)))

describeIfGlobal(`parse --resolve against the global WOF (${GLOBAL_WOF})`, () => {
	const run = (address: string, extra: string[] = []) =>
		withCLISpawnLockAsync(() =>
			runFile(
				"node",
				[cliBin, "parse", "--neural", "--resolve", "--resolve-db", GLOBAL_WOF, "--format", "xml", ...extra, address],
				{
					env: childEnv({ NODE_NO_WARNINGS: "1" }),
					maxBuffer: 4 * 1024 * 1024,
					timeout: CLI_SPAWN_TIMEOUT_MS,
				}
			)
		)

	const localityLat = (xml: string): number | null => {
		const m = /<locality[^>]*lat="([-0-9.]+)"/.exec(xml)

		return m ? Number(m[1]) : null
	}

	test(
		"default (US inferred from en-US) resolves New York to the US city, not a foreign homonym",
		async () => {
			const { stdout } = await run("350 5th Ave, New York, NY 10118")

			const m = /locality[^>]*lat="(4[01]\.\d+)" lon="(-7[34]\.\d+)"/.exec(stdout)
			expect(m, `expected a NYC-range locality coordinate, got:\n${stdout}`).not.toBeNull()
		},
		CLI_TEST_TIMEOUT_MS
	)

	test(
		"--default-country scoping is a real mechanism: US vs FR flips the resolved namesake",
		async () => {
			const usLat = localityLat((await run("Paris, TX")).stdout)
			const frLat = localityLat((await run("Paris, TX", ["--default-country", "FR", "--no-admin-coherence"])).stdout)

			expect(usLat, "expected a Paris locality under the en-US default").not.toBeNull()
			expect(frLat, "expected a Paris locality under --default-country FR").not.toBeNull()

			expect(usLat!).toBeGreaterThan(32)
			expect(usLat!).toBeLessThan(36)
			expect(frLat!).toBeGreaterThan(45)

			expect(usLat).not.toBe(frLat)
		},
		CLI_TEST_TIMEOUT_MS
	)

	test("AdminCoherence (default-ON,) binds a namesake to its region token even with no country scope", async () => {
		const lat = localityLat((await run("Paris, TX", ["--default-country", "none"])).stdout)

		expect(lat, "expected a Paris locality").not.toBeNull()
		expect(lat!).toBeGreaterThan(32)
		expect(lat!).toBeLessThan(36)
	})
})
