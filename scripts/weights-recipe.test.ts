/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The per-key base directory, pinned.
 *
 *   Nothing in `release.config.json` marks which base an entry resolves against, and getting it wrong fails
 *   SILENTLY — every sibling degrades `existsSync → undefined`, so a mis-based path reports the artifact
 *   absent rather than wrong. Both mistakes this file guards were made while writing it: resolving the
 *   lexicons against one base, and reading a `db` key from the pair-index entries that no entry has, which
 *   returned nothing for all eight countries.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

import { readWeightsRecipe } from "./weights-recipe.ts"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function fixture(config: unknown): Promise<{ repoRoot: string; dataRoot: string }> {
	const repoRoot = fixtures.use(await temporaryDirectory("mw-recipe-repo-")).path
	const dataRoot = fixtures.use(await temporaryDirectory("mw-recipe-data-")).path

	await makeDirectories(repoRoot)
	await writeLocalJSONFile(config, join(repoRoot, "release.config.json"))

	return { repoRoot, dataRoot }
}

const CONFIG = {
	locales: ["en-us", "en-gb"],
	weights: { model: "models/quantized/m.onnx", tokenizer: "models/tokenizer/t.model" },
	softFeed: {
		gazetteerLexicon: "data/gazetteer/anchor-lexicon-v1.json",
		countryLexicon: "data/gazetteer/country-surface-lexicon-v1.json",
		streetTypeLexicon: "data/gazetteer/street-type-lexicon-v3.json",
		localitySurfaceLexicon: "gazetteer/locality-surface-lexicon-v7.json",
		postcodeDBByCountry: { us: "postalcode-us.db" },
		pairIndexByCountry: { us: { delta: 10, boroughDB: "x.db" }, gb: { source: "y.csv", delta: 8 } },
	},
}

describe("readWeightsRecipe — the base directory is per key", () => {
	it("resolves the model and tokenizer against the DATA root", async () => {
		const { repoRoot, dataRoot } = await fixture(CONFIG)
		const recipe = readWeightsRecipe(repoRoot, dataRoot)

		expect(recipe.model).toBe(join(dataRoot, "models/quantized/m.onnx"))
		expect(recipe.tokenizer).toBe(join(dataRoot, "models/tokenizer/t.model"))
	})

	it("resolves the three COMMITTED lexicons against the REPO root", async () => {
		const { repoRoot, dataRoot } = await fixture(CONFIG)

		const by = new Map(
			readWeightsRecipe(repoRoot, dataRoot)
				.linkableFor("en-us")
				.map((a) => [a.shippedName, a])
		)

		for (const name of ["anchor-lexicon-v1.json", "country-surface-lexicon-v1.json", "street-type-lexicon-v3.json"]) {
			expect(by.get(name)?.sourcePath.startsWith(repoRoot), `${name} must be repo-relative`).toBe(true)
		}
	})

	it("resolves the BUILT locality-surface lexicon against the DATA root", async () => {
		// The one that breaks the pattern of its three neighbours, because it is built rather than committed.
		const { repoRoot, dataRoot } = await fixture(CONFIG)

		const by = new Map(
			readWeightsRecipe(repoRoot, dataRoot)
				.linkableFor("en-us")
				.map((a) => [a.shippedName, a])
		)

		expect(by.get("locality-surface-lexicon-v7.json")?.sourcePath).toBe(
			join(dataRoot, "gazetteer/locality-surface-lexicon-v7.json")
		)
	})

	it("lets an absolute config entry pass through, matching copy-weights.ts", async () => {
		const { repoRoot, dataRoot } = await fixture({
			...CONFIG,
			softFeed: { ...CONFIG.softFeed, postcodeDBByCountry: { us: "/elsewhere/postalcode-us.db" } },
		})

		const buildable = readWeightsRecipe(repoRoot, dataRoot).buildableFor("en-us")

		expect(buildable.find((a) => a.shippedName === "postcode-us.bin")?.inputPath).toBe("/elsewhere/postalcode-us.db")
	})
})

describe("readWeightsRecipe — buildable is not linkable", () => {
	it("reports the postcode BINARY as buildable from the shard, never as a linkable file", async () => {
		const { repoRoot, dataRoot } = await fixture(CONFIG)
		const recipe = readWeightsRecipe(repoRoot, dataRoot)

		// The config names `postalcode-us.db`; the resolver looks for `postcode-us.bin`. Treating the entry as
		// linkable would place a DATABASE under the binary's name, and every sibling degrades to `undefined`, so
		// the resolver would then report the artifact absent rather than wrong.
		expect(recipe.linkableFor("en-us").some((a) => a.shippedName.startsWith("postcode-"))).toBe(false)

		const postcode = recipe.buildableFor("en-us").find((a) => a.shippedName === "postcode-us.bin")

		expect(postcode?.inputPath).toBe(join(dataRoot, "wof", "postalcode-us.db"))
	})

	it("reports a pair index for every country the config names, whatever the entry's shape", async () => {
		// `us` carries `boroughDB` and `gb` carries `source`; neither has a `db` key. An earlier draft read `db`
		// and therefore reported NO pair index for any country — silently, since the artifact merely stayed absent.
		const { repoRoot, dataRoot } = await fixture(CONFIG)
		const recipe = readWeightsRecipe(repoRoot, dataRoot)

		expect(recipe.buildableFor("en-us").some((a) => a.shippedName === "pair-index-us.bin")).toBe(true)
		expect(recipe.buildableFor("en-gb").some((a) => a.shippedName === "pair-index-gb.bin")).toBe(true)
	})

	it("names no pair index for a country the config omits", async () => {
		const { repoRoot, dataRoot } = await fixture(CONFIG)

		expect(readWeightsRecipe(repoRoot, dataRoot).buildableFor("fr-fr")).toHaveLength(0)
	})
})

describe("readWeightsRecipe — the dev-only FSTs", () => {
	it("names both FSTs even though the release config does not", async () => {
		// They are dev-only: copy-weights.ts ships neither, so a weights directory has them only because a linker
		// put them there — and their absence resolves the gazetteer and street-context priors OFF with no error.
		const { repoRoot, dataRoot } = await fixture(CONFIG)

		const names = readWeightsRecipe(repoRoot, dataRoot)
			.linkableFor("en-gb")
			.map((a) => a.shippedName)

		expect(names).toContain("fst-en-gb.bin")
		expect(names).toContain("fst-street-morphology.bin")
	})
})

describe("readWeightsRecipe — overrides", () => {
	it("takes the model override outright, so callers cannot disagree about precedence", async () => {
		const { repoRoot, dataRoot } = await fixture(CONFIG)
		const recipe = readWeightsRecipe(repoRoot, dataRoot, { model: "/tmp/experiment.onnx" })

		expect(recipe.model).toBe("/tmp/experiment.onnx")
		expect(recipe.tokenizer).toBe(join(dataRoot, "models/tokenizer/t.model"))
	})
})
