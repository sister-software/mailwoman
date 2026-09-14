/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The country→locale guard over a planted tree: a missing shipping locale, a transposed pair, a legal subset.
 *
 *   The check reads four fixed paths, so a fixture plants those paths. The defect it was written for is the one the
 *   first case reproduces: `release.config.json` gains a locale under `charWeights`, the Latin-only census table is
 *   not touched, and every consumer reads the absence as a country with no weights package.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { localeTablesCheck, shippingLocales } from "@mailwoman/repo-health/checks/locale-tables"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CENSUS = "packages/mailwoman/lib/coverage/census.ts"
const ROUTING = "packages/mailwoman/lib/eval-harness/gauntlet/routing.ts"
const INVARIANCE = "packages/mailwoman/lib/eval-harness/invariance/parser.ts"
const LADDER = "packages/mailwoman/lib/eval-harness/autocomplete-ladder.ts"

const weightsMap = (pairs: ReadonlyArray<readonly [string, string]>) =>
	`export const WEIGHTS_PACKAGE_BY_COUNTRY: ReadonlyMap<string, string> = new Map([\n${pairs
		.map(([country, locale]) => `\t["${country}", "${locale}"],`)
		.join("\n")}\n])\n`

const objectTable = (name: string, pairs: ReadonlyArray<readonly [string, string]>) =>
	`export const ${name}: Readonly<Record<string, string>> = {\n${pairs
		.map(([country, locale]) => `\t${country}: "${locale}",`)
		.join("\n")}\n}\n`

async function plant(options: {
	config: Record<string, unknown>
	weights: ReadonlyArray<readonly [string, string]>
	overlay?: ReadonlyArray<readonly [string, string]>
	invariance?: ReadonlyArray<readonly [string, string]>
	ladder?: ReadonlyArray<readonly [string, string]>
}) {
	const root = fixtures.use(await temporaryDirectory("locale-tables-")).path

	const files: Record<string, string> = {
		"release.config.json": stringifyJSON(options.config),
		[CENSUS]: weightsMap(options.weights),
		[ROUTING]: objectTable("OVERLAY_LOCALE_BY_COUNTRY", options.overlay ?? [["GB", "en-GB"]]),
		[INVARIANCE]: objectTable("COUNTRY_TO_LOCALE", options.invariance ?? [["US", "en-US"]]),
		[LADDER]: objectTable("FST_LOCALE_BY_COUNTRY", options.ladder ?? [["US", "en-us"]]),
	}

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(root, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(root, file))
	}

	return { repoRoot: String(root), trackedFiles: Object.keys(files) }
}

describe("shippingLocales", () => {
	it("takes the Latin list and every character-path family's overlays", () => {
		const locales = shippingLocales({
			locales: ["en-us", "fr-fr"],
			charWeights: { cjk: { overlays: ["ja-jp", "zh-cn"] } },
		})

		expect([...locales].toSorted()).toEqual(["en-us", "fr-fr", "ja-jp", "zh-cn"])
	})

	it("survives a config with no character-path family", () => {
		expect([...shippingLocales({ locales: ["en-us"] })]).toEqual(["en-us"])
	})
})

describe("localeTablesCheck", () => {
	it("reports a shipping locale the census table does not name", async () => {
		const context = await plant({
			config: { locales: ["en-us"], charWeights: { cjk: { overlays: ["ja-jp", "zh-cn"] } } },
			weights: [["US", "en-us"]],
		})

		const diagnostics = await localeTablesCheck.run(context)

		expect(diagnostics).toHaveLength(2)
		expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("ships ja-jp")
		expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("ships zh-cn")
		expect(diagnostics.every((diagnostic) => diagnostic.file === CENSUS)).toBe(true)
	})

	it("reports a country key that disagrees with its locale's region", async () => {
		const context = await plant({
			config: { locales: ["en-us", "de-de"] },
			weights: [
				["US", "en-us"],
				["DE", "de-de"],
			],
			overlay: [["GB", "de-DE"]],
		})

		const diagnostics = await localeTablesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.message).toContain("maps GB to de-DE")
		expect(diagnostics[0]!.file).toBe(ROUTING)
	})

	it("admits a deliberate subset, and asks completeness only of the census table", async () => {
		const context = await plant({
			config: { locales: ["en-us", "de-de", "es-es"] },
			weights: [
				["US", "en-us"],
				["DE", "de-de"],
				["ES", "es-es"],
			],
			// Each of the three is a subset of what ships, which is their contract.
			overlay: [["DE", "de-DE"]],
			invariance: [["US", "en-US"]],
			ladder: [["ES", "es-es"]],
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})

	it("admits a table naming a locale that does not ship yet", async () => {
		const context = await plant({
			config: { locales: ["en-us"] },
			weights: [["US", "en-us"]],
			// `FST_LOCALE_BY_COUNTRY` carries `ko-kr` ahead of the Korean package; the ladder resolves an FST by path
			// and answers nothing when the file is absent.
			ladder: [
				["US", "en-us"],
				["KR", "ko-kr"],
			],
		})

		expect(await localeTablesCheck.run(context)).toEqual([])
	})

	it("reports a declaration it cannot read rather than passing an unguarded table", async () => {
		const context = await plant({
			config: { locales: ["en-us"] },
			weights: [["US", "en-us"]],
		})

		await writeLocalTextFile(
			"export const OVERLAY_LOCALE_BY_COUNTRY = buildRouting()\n",
			resolvePath(context.repoRoot, ROUTING)
		)

		const diagnostics = await localeTablesCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]!.message).toContain("cannot read it")
	})
})
