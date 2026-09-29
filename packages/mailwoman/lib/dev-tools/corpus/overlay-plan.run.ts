/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Derive the overlay plan for the next corpus version from the previous version's manifest.
 *
 *   An overlay is a parquet file added to a built corpus after the base build, carrying rows a recipe
 *   produced rather than an adapter. The previous corpus's manifest records every one of them with its
 *   `source` label and the split it entered, so readers can see which overlays the plan retains
 *   rather than maintained by hand.
 *
 *   Each overlay groups under its unsplit original. A manifest entry ending `.train.parquet`,
 *   `.val.parquet` or `.test.parquet` is one output of `corpus split-slice`, so several entries
 *   collapse to one original. This groups them and reports the original each came from.
 *
 *   **Every original is routed, including one holding no row the policy holds out.** `split-slice`
 *   writes a val or test file only where rows reach it. An empty file therefore produces one train file with
 *   the same rows. A hand-maintained per-file list can omit a file and silently overlap holdout with train.
 *   A complete route costs a few seconds per small file.
 *
 *   An original this cannot locate is reported by name and counted. It is never dropped from the plan,
 *   because an overlay missing from the next corpus is a silent loss of the rows a recipe was written
 *   to add.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/overlay-plan.run.ts \
 *     --base-manifest <the previous corpus directory's MANIFEST.json> \
 *     --search <dir,dir,...> --out <plan.json>
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { CARRIED_SOURCES, currentSourceName } from "@mailwoman/corpus/recipes/sources"
import { basename, dirname, join } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

const { values } = parseArguments({
	options: {
		"base-manifest": { type: "string", description: "The previous corpus's inner MANIFEST.json" },
		search: { type: "string", description: "Comma-separated directories to look for each unsplit original in" },
		out: { type: "string", description: "Where to write the plan JSON" },
		routed: {
			type: "string",
			description:
				"The directory holding the routed per-split parquets. Given it, the plan also emits the three " +
				"comma-separated lists overlay-manifest takes, read from the files on disk rather than from the " +
				"originals, so a file routing produced or omitted is reflected in what the manifest records.",
		},
	},
})

const baseManifest = values["base-manifest"]
const search = values.search

if (!baseManifest) throw new Error("--base-manifest <path to the previous corpus MANIFEST.json> is required")

if (!search) throw new Error("--search <dir,dir,...> is required")

/**
 * A base parquet the build wrote, as opposed to an overlay a recipe added.
 */
const BASE_FILE = /^part-\d{4}\.parquet$/u

/**
 * The suffix `corpus split-slice` appends.
 * Several entries from one original share it.
 */
const ROUTED_SUFFIX = /\.(train|val|test)\.parquet$/u

interface ManifestSlice {
	split: string
	path: string
	source?: string
	rows: number
}

interface OverlayOriginal {
	/**
	 * The original's name with no split suffix and no extension.
	 */
	stem: string
	/**
	 * The `source` label `overlay-manifest --source` needs, in its current spelling.
	 *
	 * The previous manifest preserves the spelling that was current when written.
	 * `currentSourceName` maps retired spellings forward.
	 *
	 * A retired spelling passed to `overlay-manifest` would make the manifest disagree with the rows.
	 * A later plan would then repeat the stale label.
	 */
	source: string
	/**
	 * What the previous manifest recorded, where that differs from {@link OverlayOriginal.source}.
	 */
	retiredSource?: string
	/**
	 * The splits that held this file in the previous corpus.
	 * They show whether it was routed before.
	 */
	previousSplits: string[]
	previousRows: number
	/**
	 * Where its unsplit original was found, or `null` when no search directory holds it.
	 */
	unsplitPath: string | null
}

const manifest = await readLocalJSONFile<{ corpus_version: string; slices: ManifestSlice[] }>(baseManifest)
const overlays = manifest.slices.filter((slice) => !BASE_FILE.test(basename(slice.path)))

if (!overlays.length) {
	throw new Error(`${baseManifest} records no overlay slices; every entry looks like a base part-NNNN.parquet`)
}

const grouped = new Map<string, { source: Set<string>; splits: Set<string>; rows: number }>()

for (const slice of overlays) {
	const name = basename(slice.path)
	const stem = name.replace(ROUTED_SUFFIX, "").replace(/\.parquet$/u, "")
	const entry = grouped.get(stem) ?? { source: new Set<string>(), splits: new Set<string>(), rows: 0 }

	if (slice.source) {
		entry.source.add(slice.source)
	}

	entry.splits.add(slice.split)
	entry.rows += slice.rows
	grouped.set(stem, entry)
}

const searchDirectories = TextSpliterator.from(search, { delimiter: "," }).toArray()

/**
 * Index every parquet under the search roots by basename.
 *
 * An original sits under the version directory that first produced it,
 * so the roots are walked rather than listed.
 * The plan excludes the previous corpus directory because its files are the copies this plan replaces.
 *
 * A copy that already followed the old policy would repeat its previous routing.
 */
const index = new Map<string, string[]>()
const previousCorpusDirectory = dirname(baseManifest)

for (const root of searchDirectories) {
	const found = await Globerator.from("**/*.parquet", { cwd: root, onlyFiles: true }).toArray()

	for (const relative of found) {
		const entry = join(root, String(relative))

		if (entry.startsWith(previousCorpusDirectory)) continue

		const name = basename(entry)
		index.set(name, [...(index.get(name) ?? []), entry])
	}
}

const originals: OverlayOriginal[] = []
const ambiguous: string[] = []
const multiplyLocated: string[] = []
const unmappable: string[] = []

for (const [stem, entry] of [...grouped].toSorted(([a], [b]) => a.localeCompare(b))) {
	if (entry.source.size !== 1) {
		// Two labels for one original means the plan cannot state what `--source` to pass for it.
		ambiguous.push(`${stem}: ${!entry.source.size ? "no source recorded" : [...entry.source].join(", ")}`)
	}

	// Check `.migrated.parquet` first.
	// When both forms exist, this form includes the register, surface
	// and recipe columns a current corpus needs.
	// The plain file predates those columns.
	let unsplitPath: string | null = null

	for (const candidateName of [`${stem}.migrated.parquet`, `${stem}.parquet`]) {
		const found = index.get(candidateName)

		if (!found?.length) continue

		if (found.length > 1) {
			multiplyLocated.push(`${candidateName}: ${found.join(", ")}`)
		}

		unsplitPath = found[0]!

		break
	}

	const recorded = [...entry.source][0] ?? ""

	// A retained source is one no recipe in this repository produces, so it keeps
	// its upstream spelling and maps to itself.
	// `currentSourceName` answers only for the recipe outputs.
	const current = CARRIED_SOURCES.includes(recorded) ? recorded : currentSourceName(recorded)

	if (recorded && !current) {
		// A label absent from both tables has no forward mapping.
		// `overlay-manifest` would record a claim the rows may not support if it received this label.
		unmappable.push(`${stem}: ${recorded}`)
	}

	originals.push({
		stem,
		source: current ?? recorded,
		...(current && current !== recorded ? { retiredSource: recorded } : {}),
		previousSplits: [...entry.splits].toSorted(),
		previousRows: entry.rows,
		unsplitPath,
	})
}

const located = originals.filter((original) => original.unsplitPath !== null)
const missing = originals.filter((original) => original.unsplitPath === null)
const routedBefore = originals.filter((original) => original.previousSplits.length > 1)

if (values.out) {
	await writeLocalJSONFile(
		{
			derived_from: baseManifest,
			previous_corpus_version: manifest.corpus_version,
			searched: searchDirectories,
			overlay_files_in_previous: overlays.length,
			originals,
		},
		values.out
	)
}

console.log(`derived from        ${baseManifest}`)
console.log(`previous version    ${manifest.corpus_version}`)
console.log(`overlay files       ${overlays.length}`)
console.log(`distinct originals  ${originals.length}`)
console.log(`  routed before     ${routedBefore.length}`)
console.log(`  located on disk   ${located.length}`)
console.log(`  not located       ${missing.length}`)

if (ambiguous.length) {
	console.log()
	console.log(`${ambiguous.length} originals do not record exactly one source label:`)

	for (const line of ambiguous) {
		console.log(`  ${line}`)
	}
}

if (missing.length) {
	console.log()
	console.log(`${missing.length} originals were not found in any search directory:`)

	for (const original of missing) {
		console.log(`  ${original.stem}.parquet  (source ${original.source || "unknown"})`)
	}

	console.log()
	console.log("Each is rows a recipe was written to add. Locate it or decide deliberately to drop it.")
}

if (unmappable.length) {
	console.log()
	console.log(`${unmappable.length} originals record a source the table does not know:`)

	for (const line of unmappable) {
		console.log(`  ${line}`)
	}

	console.log()
	console.log("Add it to RECIPE_SOURCES or CARRIED_SOURCES in packages/corpus/lib/recipes/sources.ts.")
}

const renamed = originals.filter((original) => original.retiredSource)

if (renamed.length) {
	console.log()
	console.log(`${renamed.length} sources map from a retired spelling to their current one:`)

	for (const original of renamed) {
		console.log(`  ${original.retiredSource} -> ${original.source}`)
	}
}

/**
 * The three comma-separated lists `overlay-manifest` takes, read from the routed files on disk.
 *
 * The lists are positional: `overlay-manifest` zips `--parquet`, `--source` and `--split` by index,
 * so a transposition between two of them is a file recorded under another file's source and split.
 *
 * These entries are derived.
 * The source comes from the plan's current spelling instead of the previous manifest.
 *
 * A directory read rather than a read of the originals is deliberate: routing decides how many files
 * exist and which splits each source enters, so the plan lists files it wrote and files it declined.
 */
async function routedLists(directory: string): Promise<{ parquet: string[]; source: string[]; split: string[] }> {
	const names = (await Globerator.from("*.parquet", { cwd: directory, onlyFiles: true }).toArray())
		.map((entry) => basename(String(entry)))
		.toSorted((a, b) => a.localeCompare(b))

	const parquet: string[] = []
	const source: string[] = []
	const split: string[] = []
	const rejected: string[] = []

	using db = await openDuckDB()

	for (const name of names) {
		// The label comes from the file's `source` column.
		// An assembly step chooses the filename.
		// `corpus merge-source` writes `<stem>-00000.parquet` regardless of `--out`.
		// A stem that matched an original before the merge therefore may not match afterward.
		// The column is what the loader groups by, so reading it is the only attribution
		// that cannot disagree with the rows.
		const path = join(directory, name)
		const result = await db.runAndReadAll(`SELECT DISTINCT source FROM read_parquet('${path}')`)
		const stored = result.getRowObjects().map((row: Record<string, unknown>) => row.source as string)

		if (stored.length !== 1) {
			rejected.push(`${name}: ${stored.length} distinct source values (${stored.toSorted().join(", ")})`)

			continue
		}

		const label = stored[0]!

		if (!CARRIED_SOURCES.includes(label) && !currentSourceName(label)) {
			rejected.push(`${name}: source ${label}, which neither table knows`)

			continue
		}

		// The manifest records the name held by the corpus.
		// A corpus copy drops the `.migrated` infix that marks files from an older corpus.
		// `overlay-manifest` resolves `<newDir>/<split>/<parquet>`, so a list carrying
		// the staged spelling resolves to a path the corpus does not have.
		parquet.push(name.replace(".migrated", ""))
		source.push(label)
		split.push(splitOf(name))
	}

	if (rejected.length) {
		console.log()
		console.log(`${rejected.length} routed files cannot enter a manifest:`)

		for (const line of rejected) {
			console.log(`  ${line}`)
		}

		process.exitCode = 1
	}

	return { parquet, source, split }
}

/**
 * The split assigned to a routed filename, defaulting to `train` when the name has no suffix.
 */
function splitOf(name: string): string {
	return ROUTED_SUFFIX.exec(name)?.[1] ?? "train"
}

if (values.routed) {
	const lists = await routedLists(values.routed)

	console.log()
	console.log(`${lists.parquet.length} routed files, ready for overlay-manifest:`)
	console.log()
	console.log(`--parquet "${lists.parquet.join(",")}"`)
	console.log()
	console.log(`--source  "${lists.source.join(",")}"`)
	console.log()
	console.log(`--split   "${lists.split.join(",")}"`)
}

console.log()

if (values.out) {
	console.log(`plan written to ${values.out}`)
} else {
	console.log(stringifyJSON(originals))
}

if (missing.length || ambiguous.length || unmappable.length) {
	process.exitCode = 1
}
