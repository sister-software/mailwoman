/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Report, and with `--delete` remove, corpus store directories no root reaches.
 *
 *   The roots are the version manifests named by a frozen training manifest under
 *   `packages/corpus/data/training-manifests/` or by a model card (`packages/neural-weights-*\/model-card.json`).
 *   `store-gc.ts` defines reachability. Without `--delete` the tool only reports. With it, it removes an
 *   unreachable directory whose newest file is older than `--retain-days`, and it refuses to delete anything
 *   while any root's manifest is unreadable, because the reachable set is then unknown.
 *
 *   Usage:
 *   node packages/mailwoman/tools/dev-tools/corpus/store-gc.run.ts [--versioned-root <dir>] [--store <dir> ...]
 *   node packages/mailwoman/tools/dev-tools/corpus/store-gc.run.ts --delete --retain-days 30
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { isDirectory } from "@mailwoman/core/fs/readers/stat"
import { removeDirectory } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import {
	listStoreDirectories,
	modelCardRoots,
	readRootReach,
	type StoreRoot,
	trainingManifestRoots,
	unreachableDirectories,
} from "./store-gc.ts"

const { values } = parseArguments({
	options: {
		"versioned-root": {
			type: "string",
			description: "The corpus/versioned directory version manifests sit under. Defaults to the data root's",
		},
		store: {
			type: "string",
			multiple: true,
			description: "A store directory to collect. Defaults to every <versioned-root>/*/store",
		},
		delete: { type: "boolean", default: false, description: "Remove unreachable directories past the window" },
		"retain-days": {
			type: "string",
			description: "With --delete, keep an unreachable directory whose newest file is younger than this",
		},
	},
})

const versionedRoot = values["versioned-root"] ?? dataRootPath("corpus", "versioned").toString()

let retainMs: number | null = null

if (values.delete) {
	const days = Number(values["retain-days"])

	if (!values["retain-days"] || !Number.isFinite(days) || days < 0) {
		throw new Error("--delete requires --retain-days <non-negative days>")
	}

	retainMs = days * 86_400_000
}

const roots: StoreRoot[] = await trainingManifestRoots(
	repoRootPathBuilder("packages", "corpus", "data", "training-manifests")
)

const cards = await Globerator.from("packages/neural-weights-*/model-card.json", {
	cwd: repoRootPathBuilder().toString(),
	onlyFiles: true,
}).toArray()

for (const card of cards.toSorted()) {
	const { roots: named, unparsed } = await modelCardRoots(repoRootPathBuilder(card).toString())

	roots.push(...named)

	for (const value of unparsed) {
		console.log(
			`${card}: corpus_version ${stringifyJSON(value.slice(0, 80))} is not a corpus version, so it is not a root`
		)
	}
}

const versions = [...new Set(roots.map((root) => root.corpusVersion))].toSorted()

console.log(`${roots.length} roots name ${versions.length} corpus versions: ${versions.join(", ")}`)

const reach = await readRootReach(
	versions.map((corpusVersion) => roots.find((root) => root.corpusVersion === corpusVersion)!),
	versionedRoot
)

const reached = new Set<string>()
const unreadable = reach.filter((entry) => "unreadable" in entry)

for (const entry of reach) {
	if ("reached" in entry) {
		for (const path of entry.reached) {
			reached.add(path)
		}
	} else {
		console.log(
			`UNREADABLE ROOT ${entry.root.corpusVersion} (named by ${entry.root.namedBy}): ${entry.manifest}: ${entry.unreadable}`
		)
	}
}

// A store root is `<version>/store`, read off the files inside one so an empty store is not listed.
const stores = values.store ?? [
	...new Set(
		(await Globerator.from("*/store/**/*", { cwd: versionedRoot, onlyFiles: true }).toArray()).map((relative) =>
			resolvePath(versionedRoot, relative.split("/")[0]!, "store")
		)
	),
]

let unreachableBytes = 0
const candidates: Array<{ path: string; bytes: number; newestMtimeMs: number }> = []

for (const store of stores.toSorted()) {
	if (!(await isDirectory(store))) throw new Error(`${store} is not a directory`)

	const directories = await listStoreDirectories(store)
	const unreachable = unreachableDirectories(directories, reached)

	console.log(`${store}: ${directories.length} directories, ${unreachable.length} unreachable`)

	for (const directory of unreachable) {
		console.log(`  unreachable ${directory.path} ${ByteFormatter.formatIEC(directory.bytes)}`)

		unreachableBytes += directory.bytes
		candidates.push(directory)
	}
}

console.log(`${candidates.length} unreachable directories, ${ByteFormatter.formatIEC(unreachableBytes)}`)

if (retainMs != null) {
	if (unreadable.length) {
		throw new Error(
			`refusing to delete: ${unreadable.length} root manifest(s) unreadable, so the reachable set is unknown`
		)
	}

	const cutoff = Date.now() - retainMs
	let removed = 0

	for (const directory of candidates) {
		if (directory.newestMtimeMs > cutoff) {
			console.log(`  kept (inside the retention window) ${directory.path}`)

			continue
		}

		await removeDirectory(directory.path)

		removed++

		console.log(`  removed ${directory.path}`)
	}

	console.log(`removed ${removed} of ${candidates.length} unreachable directories`)
}
