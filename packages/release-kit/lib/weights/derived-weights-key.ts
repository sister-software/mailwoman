/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The content key for the derived-weights store at `$MAILWOMAN_DATA_ROOT/derived/weights/<key>`.
 *
 *   The generating code is hashed along with the inputs it reads, so a change to the extractor
 *   produces new artifacts rather than letting the store serve old ones under the old key.
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
 * Each generating source module is paired with its compiled counterpart because the build spawns
 * the compiled CLI; hashing source alone lets a stale compile compute the fixed key and build with
 * the broken code. Transitive compiled imports are deliberately excluded, or the store would
 * invalidate on every unrelated commit.
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
 * The `data/gazetteer` payload, enumerated rather than hardcoded so a new extract joins the key
 * without a code change.
 */
async function gazetteerDataPaths(): Promise<string[]> {
	const dir = repoRootPathBuilder("data", "gazetteer")

	if (!(await pathExists(dir))) return []

	return Globerator.files(["json", "jsonl"], { cwd: dir, absolute: true, recursive: false }).toArray()
}

/**
 * The postcode pipeline modules the postcode-binary command calls into — source and compiled,
 * enumerated like the data payload so a new module joins the key without a code change.
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
	 * Repo-relative identity of the input; hashed, and it must not vary by checkout location.
	 */
	name: string
	/**
	 * Absolute path to read, deliberately not hashed — see {@link derivedWeightsKeyFrom}.
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
 * Hash an explicit input list, sorted by name so the caller's ordering cannot change the key.
 *
 * Exported for testing; production callers want {@link derivedWeightsKey}.
 *
 * Only the repo-relative name is hashed, never the absolute path, so checkouts at different roots
 * agree on the key over byte-identical inputs. A missing input contributes a `\0absent` marker
 * rather than an empty contribution, so a gone file and an empty file do not collide.
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
 * The key for this checkout's derived weights, identical across checkouts with identical input
 * content wherever they live on disk.
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
 * A `postcode-<cc>.bin` is refused when its PCB1 header is malformed or its record count sits
 * below the lowest calibrated floor for that country — for GB that is the outward floor, so a
 * legitimate outward-granularity bin is never false-refused while an empty or collapsed one is.
 * The calibrated per-granularity check remains the builder's; this one only has the header to read.
 * Non-postcode entries pass, because their reader validates a typed header on load.
 */
/**
 * Magic (4) + u32 recordCount (4) + u8 countryCount (1) — the PCB1 prefix the serve check reads.
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
