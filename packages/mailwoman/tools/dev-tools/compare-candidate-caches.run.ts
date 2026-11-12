// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compares two weights caches staged by `stage-candidate-cache.run.ts`.
 *
 *   The tool prints each cache's file and symlink counts, every relative path whose
 *   md5 differs or which only one cache holds, and the base package card's version,
 *   corpus version and declared `model.onnx` md5.
 *   A symlink is hashed through its target, so a linked cache and a copied
 *   cache of the same files compare equal.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/compare-candidate-caches.run.ts <cache a> <cache b>
 */

import { readLocalJSONFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { isFile, isSymbolicLink } from "@mailwoman/core/fs/readers/stat"
import { md5File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { PathBuilder } from "path-ts"

const { positionals } = parseArguments({ options: {}, allowPositionals: true })
const [first, second] = positionals

if (!first || !second || positionals.length > 2) throw new Error("usage: <cache a> <cache b>")

interface CacheListing {
	root: string
	md5ByPath: Map<string, string>
	symlinks: number
}

async function listCache(root: string): Promise<CacheListing> {
	const listing: CacheListing = { root, md5ByPath: new Map(), symlinks: 0 }
	const base = PathBuilder.from(root)

	for (const absolute of await sortedGlob(base, "**/*")) {
		if (!(await isFile(absolute))) continue

		if (await isSymbolicLink(absolute)) {
			listing.symlinks += 1
		}

		listing.md5ByPath.set(absolute.slice(base.toString().length + 1), await md5File(absolute))
	}

	return listing
}

interface BaseCard {
	version?: string
	training?: { corpus_version?: string }
	files_md5?: Record<string, string>
}

const listings = [await listCache(first), await listCache(second)] as const

for (const listing of listings) {
	console.log(`${listing.root}: ${listing.md5ByPath.size} file(s), ${listing.symlinks} symlink(s)`)
}

const [a, b] = listings
const paths = new Set([...a.md5ByPath.keys(), ...b.md5ByPath.keys()])
let differing = 0

for (const path of [...paths].toSorted()) {
	const left = a.md5ByPath.get(path)
	const right = b.md5ByPath.get(path)

	if (left === right) continue

	differing += 1

	console.log(`differs: ${path} ${left ?? "absent"} ${right ?? "absent"}`)
}

console.log(`${differing} of ${paths.size} path(s) differ`)

for (const listing of listings) {
	const card = await readLocalJSONFile<BaseCard>(weightsCachePackageDir(listing.root, "en-us")("model-card.json"))

	console.log(
		`${listing.root} card: version=${card.version} corpus=${card.training?.corpus_version} ` +
			`model.onnx md5=${card.files_md5?.["model.onnx"]}`
	)
}
