/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The content key for the derived-weights store at `$MAILWOMAN_DATA_ROOT/derived/weights/<key>`.
 *
 *   why A local store: the `weights-*` actions/cache entry carried 76.3 MB of real files and took
 *   48–54s to restore on the two `mailwoman-data` legs — about 1.6 MB/s over the lab's degraded path
 *   to GitHub's cache service — to a host that already has the source model on local disk
 *   (`release.config.json` → `dataRoot`). Only `postcode-<cc>.bin` and `pair-index-<cc>.bin` are
 *   expensive to produce, so those are what the store holds. The runners are self-hosted, so the
 *   filesystem persists across runs and the store is durable.
 *
 *   why the generators are hashed: on 2026-08-02 the workflow key hashed `release.config.json` and
 *   `data/gazetteer/*` but not the extractor, so a currency-filter change produced new artifacts
 *   while the cache served old ones and the pair-index↔card parity guard failed with
 *   `expected 47878 to be 49033`. The generating code is part of the input rather than context around it.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer, statPath } from "@mailwoman/core/fs/readers"
import { createHash } from "@mailwoman/core/hash"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { POSTCODE_BINARY_KEY_FLOORS } from "mailwoman/gazetteer-pipeline/postcode/binary"
import { type PathBuilderLike, relative, resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * Repo-relative files the derived binaries are a function of, beyond the `data/gazetteer`
 * payload enumerated by {@link derivedWeightsInputs}.
 *
 * The first entry mirrors the retired workflow cache key.
 * The rest are what that key missed: the modules that generate the binaries — each source
 * module paired with its compiled counterpart, because the build spawns the compiled CLI.
 *
 * Hashing source alone re-created the #1528 poisoning in cache form: a stale-compiled
 * builder under already-fixed source computes the fixed key, builds with the broken code,
 * and the store then serves that artifact to every fresh-compiled run forever.
 * With the compiled bytes in the key, a stale compile keys separately from a fresh one,
 * so its output can never be served to a checkout whose compiled tree differs.
 *
 * (Transitive compiled imports are deliberately not hashed, which would invalidate
 * the store on every unrelated commit and delete its reason to exist. The direct
 * builder modules are where both real incidents lived.)
 *
 * Add here whenever a new input starts feeding the build.
 * A key that omits an input serves stale artifacts silently, which is the
 * failure this list exists to prevent.
 */
export const DERIVED_WEIGHTS_INPUTS: readonly string[] = [
	"release.config.json",
	"packages/mailwoman/lib/gazetteer-pipeline/borough-pairs.ts",
	"packages/mailwoman/lib/gazetteer-pipeline/lieudit-pairs.ts",
	"packages/mailwoman/lib/commands/gazetteer/pair-index.tsx",
	"packages/mailwoman/lib/commands/gazetteer/postcode/binary.tsx",
	"packages/mailwoman/out/gazetteer-pipeline/borough-pairs.js",
	"packages/mailwoman/out/gazetteer-pipeline/lieudit-pairs.js",
	"packages/mailwoman/out/commands/gazetteer/pair-index.js",
	"packages/mailwoman/out/commands/gazetteer/postcode/binary.js",
]

/**
 * The `data/gazetteer` payload, matched the way the retired workflow key matched it (`*.json` + `*.jsonl`).
 *
 * Enumerated rather than hardcoded so a new extract is picked up without a code change.
 * The opposite trade from {@link DERIVED_WEIGHTS_INPUTS}, where an explicit list is the point.
 */
async function gazetteerDataPaths(): Promise<string[]> {
	const dir = repoRootPathBuilder("data", "gazetteer")

	if (!(await pathExists(dir))) return []

	return Globerator.files(["json", "jsonl"], { cwd: dir, absolute: true, recursive: false }).toArray()
}

/**
 * The postcode pipeline modules the postcode-binary command calls into — source and compiled,
 * enumerated like the data payload so a new module joins the key without a code change.
 *
 * The #1527 fix lived here, one import below the command module the explicit list carried,
 * which is how the stale build escaped the key.
 */
async function postcodePipelinePaths(): Promise<string[]> {
	const root = repoRootPathBuilder()

	const dirs = [
		root("packages", "mailwoman", "lib", "gazetteer-pipeline", "postcode"),
		root("packages", "mailwoman", "out", "gazetteer-pipeline", "postcode"),
	]

	const paths: string[] = []

	for (const dir of dirs) {
		if (!(await pathExists(dir))) continue

		for await (const name of Globerator.from("*", { cwd: dir, absolute: false })) {
			if ((name.endsWith(".ts") || name.endsWith(".js")) && !name.includes(".test.") && !name.endsWith(".map")) {
				paths.push(dir(name).toString())
			}
		}
	}

	return paths
}

/**
 * One hashed input: a stable name plus wherever this checkout happens to keep it.
 */
export interface DerivedWeightsInput {
	/**
	 * Repo-relative identity of the input.
	 *
	 * Hashed.
	 * Must not vary by checkout location.
	 */
	name: string
	/**
	 * Absolute path to read.
	 *
	 * Not hashed — see {@link derivedWeightsKeyFrom}.
	 */
	path: PathBuilderLike
}

/**
 * Every input this checkout's key is computed over, named repo-relatively.
 */
async function derivedWeightsInputs(): Promise<DerivedWeightsInput[]> {
	const root = repoRootPath()
	const [gazetteerData, postcodePipeline] = await Promise.all([gazetteerDataPaths(), postcodePipelinePaths()])

	return [
		...DERIVED_WEIGHTS_INPUTS.map((name) => ({ name, path: resolvePath(root, name) })),
		...gazetteerData.map((path) => ({ name: relative(root, path), path })),
		...postcodePipeline.map((path) => ({ name: relative(root, path), path })),
	]
}

/**
 * Hash an explicit input list.
 *
 * Exported for testing.
 * Production callers want {@link derivedWeightsKey}.
 *
 * Sorted by name, so the caller's ordering cannot change the key.
 * Each entry contributes its name and its bytes.
 *
 * ⚠ The name is repo-relative and the absolute path is deliberately not hashed.
 * Hashing absolute paths was the first version's bug: every GitHub runner checks out to
 * its own work directory, so lab-1, lab-2, lab-3 and a local worktree each computed a
 * different key over byte-identical inputs and none of them ever saw another's work.
 *
 * It surfaced as four store directories holding the same eleven artifacts, and as a 41s
 * `pair-index-nz.bin` rebuild on a runner where that exact file was already on disk under a different key.
 *
 * A missing input contributes a `\0absent` marker rather than nothing —
 * "the file is gone" and "the file is empty" must not collide.
 */
export async function derivedWeightsKeyFrom(inputs: readonly DerivedWeightsInput[]): Promise<string> {
	const hash = createHash("sha256")

	for (const { name, path } of inputs.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		hash.update(name)
		hash.update("\0")

		try {
			await statPath(path)
			hash.update(await readLocalBuffer(path))
		} catch {
			hash.update("\0absent")
		}

		hash.update("\0")
	}

	return hash.digest("hex").slice(0, 16)
}

/**
 * The key for this checkout's derived weights.
 *
 * Identical across checkouts with identical input content, wherever they live on disk.
 * That invariance is the whole point of the store.
 */
export async function derivedWeightsKey(): Promise<string> {
	return derivedWeightsKeyFrom(await derivedWeightsInputs())
}

/**
 * Where the derived binaries for `key` live.
 */
export function derivedWeightsDir(key: string): string {
	return dataRootPath("derived", "weights", key).toString()
}

/**
 * The reason a store entry must not be served (or stashed), or `null` when it looks like a product.
 *
 * The second net behind the build-time floors (#1509): the store once held a 10-byte empty
 * `postcode-gb.bin` a stale-compiled builder wrote, and served it as a HIT indefinitely (#1528).
 * A `postcode-<cc>.bin` is refused when its PCB1 header is malformed or its record count sits
 * below the lowest calibrated floor for that country, for GB that is the outward floor, so a
 * legitimate outward-granularity bin is never false-refused while the empty/collapsed class always is.
 *
 * The calibrated per-granularity check remains the builder's.
 * This one only has the header to read.
 *
 * Non-postcode entries (pair indexes) pass — their reader validates a typed header
 * on load, and no measured floor exists for them yet.
 */
/**
 * Magic (4) + u32 recordCount (4) + u8 countryCount (1).
 *
 * The PCB1 prefix the serve check reads.
 * Anything shorter cannot carry a record count at all.
 */
const PCB1_HEADER_BYTES = 9

export async function derivedStoreServeViolation(filename: string, path: PathBuilderLike): Promise<string | null> {
	const match = /^postcode-([a-z]{2})\.bin$/.exec(filename)

	if (!match) return null

	const country = match[1]!.toUpperCase()

	let header: Buffer

	try {
		header = await readLocalBuffer(path)
	} catch (error) {
		return `unreadable store entry: ${String(error)}`
	}

	if (header.length < PCB1_HEADER_BYTES || header.toString("latin1", 0, 4) !== "PCB1") {
		return `not a PCB1 binary (${header.length} bytes)`
	}

	const records = header.readUInt32LE(4)

	const floor =
		country === "GB" ? POSTCODE_BINARY_KEY_FLOORS["GB:outward"]! : (POSTCODE_BINARY_KEY_FLOORS[country] ?? 1)

	if (records < floor) {
		return `${records.toLocaleString()} records, below the ${country} floor of ${floor.toLocaleString()} — an empty or collapsed binary is never a valid cache entry (#1509/#1528)`
	}

	return null
}
