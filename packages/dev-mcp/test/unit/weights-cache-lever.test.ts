/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate-weights lever, and the guard that keeps it from measuring the shipped model.
 *
 *   `resolveWeights` treats an explicit `cacheRoot` as authoritative ONLY when that directory actually holds the
 *   binaries; a cache missing them falls through to the installed workspace package, which in this repo always
 *   resolves. So a typo in a cache path does not fail — it grades the SHIPPED model and labels the answer with the
 *   candidate's name. That is the failure this file pins: the engine refuses BEFORE the multi-second session build,
 *   and it refuses differently for a wrong-shaped root than for a correctly-shaped one that is under-staged.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import {
	assertWeightsCacheStaged,
	EFFECTIVE_KEY_FOR,
	effectiveKeyFor,
	engineID,
	EngineRegistry,
	resolveConfig,
} from "@mailwoman/dev-mcp/engine-registry"
import { ENGINE_CONFIG_SCHEMA } from "@mailwoman/dev-mcp/tool-kit"
import { computeTreeFingerprint } from "@mailwoman/dev-mcp/tree-fingerprint"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { join } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Lay out a cache root the way `weightsCachePackageDir` expects, staged to the requested depth.
 *
 * `declared` becomes the card's `files_md5`, which is what separates an under-staged cache from a complete one — the
 * card is the only thing that knows which siblings this bundle is supposed to carry.
 */
async function stageCache(
	stage: "wrong-shape" | "under-staged" | "ok",
	declared: string[] = ["fst-en-us.bin"]
): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("mwdev-weights-cache-")).path
	const packageDir = weightsCachePackageDir(root, "en-us")

	await makeDirectories(packageDir)

	if (stage === "wrong-shape") return root

	await writeLocalTextFile("not a real model", join(packageDir, "model.onnx"))
	await writeLocalTextFile("not a real tokenizer", join(packageDir, "tokenizer.model"))

	await writeLocalJSONFile(
		{ files_md5: Object.fromEntries(declared.map((name) => [name, "0"])) },
		join(packageDir, "model-card.json")
	)

	if (stage === "under-staged") return root

	for (const name of declared) {
		await writeLocalTextFile("", join(packageDir, name))
	}

	return root
}

describe("weights_cache — the lever", () => {
	it("is a key the tool schema accepts", () => {
		expect(Object.keys(ENGINE_CONFIG_SCHEMA.shape)).toContain("weights_cache")
	})

	it("translates to the session option that reaches resolveWeights", () => {
		expect(effectiveKeyFor("weights_cache")).toBe("weightsCacheRoot")
		expect(EFFECTIVE_KEY_FOR.weights_cache).toBe("weightsCacheRoot")
	})

	it("is ABSENT from the effective config when unset", () => {
		// Not `undefined`, absent. The effective config is hashed into the engine id and reported as provenance, and an
		// explicit `weightsCacheRoot: undefined` would claim the caller made a choice about the model when they did not.
		expect(resolveConfig({})).not.toHaveProperty("weightsCacheRoot")
	})

	it("reaches the session verbatim when set", () => {
		expect(resolveConfig({ weights_cache: "/tmp/v440-cache" }).weightsCacheRoot).toBe("/tmp/v440-cache")
	})

	it("makes two candidates two engines", () => {
		// The whole point of the lever: shipped-vs-candidate must not share a warm session. `engineID` hashes the
		// effective config, so this holds automatically — and this test is what notices if the key ever stops being
		// part of that config.
		const fingerprint = computeTreeFingerprint(process.cwd())
		const shipped = engineID(resolveConfig({}), fingerprint)
		const candidate = engineID(resolveConfig({ weights_cache: "/tmp/v440-cache" }), fingerprint)
		const other = engineID(resolveConfig({ weights_cache: "/tmp/v433-cache" }), fingerprint)

		expect(new Set([shipped, candidate, other]).size).toBe(3)
	})
})

describe("weights_cache — the guard", () => {
	it("accepts a fully staged cache", async () => {
		const staged = await stageCache("ok")

		expect(() => assertWeightsCacheStaged(staged)).not.toThrow()
	})

	it("names the missing binaries on a wrong-shaped root", async () => {
		const root = await stageCache("wrong-shape")

		expect(() => assertWeightsCacheStaged(root)).toThrow(/model\.onnx/)
		expect(() => assertWeightsCacheStaged(root)).toThrow(/tokenizer\.model/)
	})

	it("separates under-staged from wrong-shape", async () => {
		// The two need different fixes — restage the bundle vs copy the siblings the card declares — and the #1516
		// failure they prevent looks like a model regression, not a missing file. One message for both sends the
		// reader to the wrong place.
		const root = await stageCache("under-staged", ["fst-en-us.bin", "postcode-en-us.bin"])

		expect(() => assertWeightsCacheStaged(root)).toThrow(/declares/)
		expect(() => assertWeightsCacheStaged(root)).toThrow(/postcode-en-us\.bin/)
	})

	it("checks the locale the engine will actually load", async () => {
		// A cache staged for en-us is not a cache for fr-fr, and the resolver would silently fall through to the
		// installed fr-fr package rather than report that.
		const root = await stageCache("ok")

		expect(() => assertWeightsCacheStaged(root, "fr-fr")).toThrow(/fr-fr/)
	})

	it("refuses at acquire BEFORE building a session", async () => {
		const registry = new EngineRegistry(process.cwd())

		await expect(registry.acquire({ weights_cache: "/nonexistent/v999-cache" })).rejects.toThrow(/v999-cache/)

		// The measurable half: a refusal that happened after a 1.4 s build would still be correct and would still cost
		// the build. Nothing resident means it refused on the path, not on the artifacts.
		expect(registry.size).toBe(0)
	})
})
