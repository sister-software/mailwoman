/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The scope-register guard over a planted tree: a drifted tier, an unplaced shipping locale, a stale reason.
 *
 *   The case the check was written for is `reports a country the declaration tiers and the register does not`. The
 *   live instance was the other list — `D_RULE_COUNTRIES` read `["FR", "GB", "DE"]` while tier 1 read US and FR, and
 *   nothing reported it for four months because a list that does not name a country answers nothing for it.
 *
 *   The parser case matters for the shape. Every membership assertion here is vacuously true against a table that
 *   parsed as empty, so the check refuses a declaration it read fewer tier rows out of than the register declares.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { declaredTiers, localeScopeCheck } from "@mailwoman/repo-health/checks/locale/scope"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const DECLARATION = "docs/engineering/SCOPE.mdx"

/**
 * The five tier rows as `scope.mdx` writes them, minus the evidence column's prose.
 * Every fixture starts from these and edits the one row its case is about.
 */
const TIER_ROWS: Record<string, string[]> = {
	"1": ["US", "FR"],
	"2": ["DE", "ES"],
	"3": ["NO", "SE"],
	"4": ["CZ", "PL"],
	"5": ["JP", "CN"],
}

function declaration(tiers: Record<string, string[]> = TIER_ROWS): string {
	const rows = Object.entries(tiers).map(
		([tier, countries]) => `| **${tier} — a label the check never reads** | ${countries.join(", ")} | evidence prose |`
	)

	return ["# Scope", "", "| Tier | Locales | What backs the claim |", "| --- | --- | --- |", ...rows, ""].join("\n")
}

async function plant(options: { scope: Record<string, unknown>; locales?: string[]; markdown?: string }) {
	const repoRoot = String(fixtures.use(await temporaryDirectory("locale-scope-")).path)

	const files: Record<string, string> = {
		"release.config.json": stringifyJSON({ locales: options.locales ?? ["en-us", "fr-fr"] }),
		"scope.config.json": stringifyJSON(options.scope),
		[DECLARATION]: options.markdown ?? declaration(),
	}

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(repoRoot, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(repoRoot, file))
	}

	return { repoRoot, trackedFiles: Object.keys(files) }
}

const REGISTER_MATCHING_THE_ROWS = {
	tiers: TIER_ROWS,
	dRuleProtected: {},
	untieredShippingLocales: {},
}

describe("declaredTiers", () => {
	it("reads membership out of the table and leaves the evidence column alone", () => {
		const tiers = declaredTiers(declaration())

		expect(tiers.get("1")).toEqual(["US", "FR"])
		expect(tiers.get("5")).toEqual(["JP", "CN"])
	})

	it("ignores a row whose tier is not a number, because the Blocked row is prose with issue links", () => {
		const markdown = [
			declaration(),
			"| **Blocked / queued** | SE as locale 17 ([#202](https://example.test)), GB/IE/SE via OSM | external |",
		].join("\n")

		expect([...declaredTiers(markdown).keys()].toSorted()).toEqual(["1", "2", "3", "4", "5"])
	})
})

describe("localeScopeCheck", () => {
	it("passes when the register and the declaration name the same countries", async () => {
		const context = await plant({ scope: REGISTER_MATCHING_THE_ROWS })

		expect(await localeScopeCheck.run(context)).toEqual([])
	})

	it("reports a country the declaration tiers and the register does not", async () => {
		// The live shape of the defect: the doc moves, the list beside it does not, and every
		// consumer of the list reads the missing country as "no claim here" rather than as an error.
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, tiers: { ...TIER_ROWS, "1": ["FR"] } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages).toContain("tier 1 holds US in the declaration and not in the register")
	})

	it("reports the drift in the other direction too", async () => {
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, tiers: { ...TIER_ROWS, "3": ["NO", "SE", "IS"] } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages).toContain("tier 3 holds IS in the register and not in the declaration")
	})

	it("refuses a declaration it parsed too few rows out of, rather than passing vacuously", async () => {
		const context = await plant({
			scope: REGISTER_MATCHING_THE_ROWS,
			markdown: "# Scope\n\nThe table moved to a component and this page renders it.\n",
		})

		const diagnostics = await localeScopeCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toContain("the parser matched nothing")
	})

	it("reports a shipping locale placed in no tier and given no reason", async () => {
		// GB, IN and NZ are in this state on the current tree, each with a stated reason.
		// A fourth that arrives without one is the case this refuses.
		const context = await plant({
			scope: REGISTER_MATCHING_THE_ROWS,
			locales: ["en-us", "fr-fr", "en-gb"],
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages).toContain(
			"GB ships a weights package, sits in no tier, and has no entry in untieredShippingLocales saying why"
		)
	})

	it("admits a shipping locale placed in no tier WITH a reason", async () => {
		const context = await plant({
			scope: {
				...REGISTER_MATCHING_THE_ROWS,
				untieredShippingLocales: { GB: "the tier table predates the overlay; tiering it needs the evidence written" },
			},
			locales: ["en-us", "fr-fr", "en-gb"],
		})

		expect(await localeScopeCheck.run(context)).toEqual([])
	})

	it("reports a reason that has gone stale because the country was tiered", async () => {
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, untieredShippingLocales: { DE: "a reason nobody removed" } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages).toContain(
			"untieredShippingLocales still names DE, which the declaration now places in a tier — remove the entry"
		)
	})

	it("reports a protection for a country tier 1 already protects", async () => {
		// Two sources for one fact is what the register replaced. reproducing it inside
		// the register is the same defect one file further in.
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, dRuleProtected: { US: "belt and braces" } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages).toContain(
			"dRuleProtected names US, which tier 1 already protects unconditionally — two sources for one fact is what this register replaced"
		)
	})

	it("reports a protection for a country the project does not cover", async () => {
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, dRuleProtected: { ZZ: "a country that ships nothing" } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages.some((message) => message.startsWith("dRuleProtected names ZZ, which is in no tier"))).toBe(true)
	})

	it("reports an empty reason, because a blank string is not a reason someone can read", async () => {
		const context = await plant({
			scope: { ...REGISTER_MATCHING_THE_ROWS, dRuleProtected: { DE: "" } },
		})

		const messages = (await localeScopeCheck.run(context)).map((diagnostic) => diagnostic.message)

		expect(messages.some((message) => message.startsWith("dRuleProtected names DE with an empty reason"))).toBe(true)
	})
})
