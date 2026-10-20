/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Store reachability: a directory a root's manifest lists is live, every other one is unreachable, and an
 *   unreadable root is reported rather than read as an empty reach.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { afterAll, describe, expect, it } from "vitest"

import {
	listStoreDirectories,
	modelCardRoots,
	readRootReach,
	trainingManifestRoots,
	unreachableDirectories,
	versionManifestPath,
} from "./store-gc.ts"

const root = await temporaryDirectory("mw-store-gc-")

afterAll(() => root[Symbol.asyncDispose]())

describe("store reachability", () => {
	it("keeps the directories a root's manifest lists and reports the rest with their sizes", async () => {
		const versioned = root.path("versioned")
		const store = versioned("v0.8.0", "store")
		const live = store("ban", "aaa").toString()
		const dead = store("ban", "bbb").toString()

		await writeLocalTextFile("1234", live + "/data.parquet")
		await writeLocalTextFile("12345678", dead + "/data.parquet")
		await writeLocalTextFile("{}", dead + "/data.RECORD.json")

		await writeLocalJSONFile(
			{ slices: [{ split: "train", path: live + "/data.parquet" }], deletions: [] },
			versionManifestPath(versioned, "v0.8.0")
		)

		const manifests = root.path("training-manifests")

		await writeLocalJSONFile({ corpusVersion: "v0.8.0" }, manifests("v0.8.0.json"))

		const roots = await trainingManifestRoots(manifests)
		const reach = await readRootReach(roots, versioned)
		const reached = reach.flatMap((entry) => ("reached" in entry ? entry.reached : []))
		const unreachable = unreachableDirectories(await listStoreDirectories(store.toString()), reached)

		expect(unreachable.map((directory) => directory.path)).toEqual([dead])
		expect(unreachable[0]!.bytes).toBe(10)
	})

	it("reports a root whose version manifest is absent rather than reading it as an empty reach", async () => {
		const reach = await readRootReach([{ namedBy: "card", corpusVersion: "v9.9.9-absent" }], root.path("versioned"))

		expect(reach[0]).toMatchObject({ unreadable: "the version manifest is absent" })
	})

	it("reads every corpus_version of a model card and sets aside a value that is not a version", async () => {
		const card = root.path("model-card.json").toString()

		await writeLocalJSONFile(
			{ training: { corpus_version: "v0.7.10-gb-county" }, history: [{ corpus_version: "v257 fragment corpus" }] },
			card
		)

		const { roots, unparsed } = await modelCardRoots(card)

		expect(roots.map((entry) => entry.corpusVersion)).toEqual(["v0.7.10-gb-county"])
		expect(unparsed).toEqual(["v257 fragment corpus"])
	})
})
