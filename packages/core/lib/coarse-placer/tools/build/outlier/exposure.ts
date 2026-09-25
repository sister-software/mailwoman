/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Builds training rows for the coarse placer's `OTHER` class from scripts outside the model's countries.
 *
 *   Without these rows the model assigns unseen scripts to an in-map country with high confidence. The rows come
 *   from native-script names in the WOF `names` table, sampled evenly per language and kept only when the name is
 *   mostly in a script other than Latin or CJK. They are appended to the existing splits, so run this after
 *   `mailwoman placer build-dataset`.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"
import { type PathBuilderLike, resolvePath } from "path-ts"

import { scriptOf } from "#coarse-placer/featurize"
import { hashFNV1a } from "#coarse-placer/fnv-hash"
import { defaultDataDir } from "#coarse-placer/tools/paths"
import { databaseRootPath, dataRootPath } from "#data-root"
import { appendLocalTextFile } from "#fs/writers"
import { stringifyJSON } from "#json"

/**
 * The minimum share of counted characters that must be off-map for a name to be kept.
 */
const OFFMAP_DOMINANCE = 0.6

/**
 * Options for {@linkcode buildOutlierExposure}.
 */
export interface BuildOutlierExposureOptions {
	/**
	 * The number of names sampled per language.
	 * The default is 2,500.
	 */
	perLang?: number
	/**
	 * The WOF admin SQLite path.
	 *
	 * The default is `$MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db`.
	 */
	wof?: PathBuilderLike
	/**
	 * The dataset directory whose split files receive the rows.
	 * The default is `<repo>/data/coarse-placer`.
	 */
	data?: PathBuilderLike
}

/**
 * The result of {@linkcode buildOutlierExposure}.
 */
export interface BuildOutlierExposureResult {
	/**
	 * The number of `OTHER` rows written, counting names and their address-shaped variants.
	 */
	total: number
}

/**
 * Languages whose WOF names use scripts outside Latin and CJK.
 *
 * CJK is excluded because CN, JP, KR and TW are in-map classes.
 *
 * TODO: Derive this list from `@mailwoman/codex`.
 */
const OFF_MAP_LANGS = [
	// Cyrillic
	"rus",
	"ukr",
	"bel",
	"bul",
	"srp",
	"mkd",
	// Greek
	"ell",
	// Arabic script
	"ara",
	"fas",
	"urd",
	"snd",
	"pus",
	// Hebrew
	"heb",
	"yid",
	// Devanagari
	"hin",
	"mar",
	"nep",
	"san",
	// Other Brahmic scripts
	"ben",
	"tam",
	"tel",
	"kan",
	"mal",
	"sin",
	// Southeast Asian scripts
	"tha",
	"lao",
	"khm",
	"mya",
	// Georgian, Armenian and Ethiopic
	"kat",
	"hye",
	"amh",
]

/**
 * Returns whether most letters in `s` belong to a script other than Latin or CJK.
 */
function isOffMapScript(s: string): boolean {
	let off = 0
	let total = 0

	for (const ch of s) {
		const cp = ch.codePointAt(0)!

		// ASCII digits, spaces and punctuation are not counted.
		if (cp <= 0x40 || (cp >= 0x5b && cp <= 0x60) || cp === 0x20) continue

		total++
		const script = scriptOf(cp)

		if (script !== "latin" && script !== "cjk" && cp > 0x2_ff) {
			off++
		}
	}

	return total > 0 && off / total > OFFMAP_DOMINANCE
}

/**
 * Adds a house number to a name so it resembles a real off-map address such as "ул. Тверская, д. 1".
 *
 * These variants teach the model that digits and punctuation do not imply an in-map country.
 */
function addressVariant(name: string, h: number): string {
	// The house number has one to four digits.
	const n = (h % 4) + 1
	const num = String(h % Math.pow(10, n) || 7)

	switch (h % 3) {
		case 0:
			return `${name} ${num}`
		case 1:
			return `${num} ${name}`
		default:
			return `${name}, ${num}`
	}
}

/**
 * The WOF `names` columns this tool reads.
 *
 * The resolver package depends on core, so core cannot import the resolver's `WOFDatabase` schema.
 */
interface WOFNameRead {
	names: { name: string; language: string }
}

/**
 * Appends `OTHER` rows built from off-map WOF names to the dataset splits.
 */
export async function buildOutlierExposure(
	options: BuildOutlierExposureOptions = {},
	report?: (line: string) => void
): Promise<BuildOutlierExposureResult> {
	const PER = options.perLang ?? 2500
	const wofPath = options.wof || databaseRootPath(dataRootPath())("wof", "admin-global-priority.db")
	const dataDir = options.data || defaultDataDir()

	using db = new DatabaseClient<WOFNameRead>(wofPath, { readOnly: true })
	const pool: string[] = []
	const seen = new Set<string>()

	for (const lang of OFF_MAP_LANGS) {
		const rows = db
			.prepare(`SELECT name FROM names WHERE language = ? AND length(name) >= 4 LIMIT ?`)
			.all(lang, PER * 2)

		let kept = 0

		for (const r of rows) {
			if (kept >= PER) break
			const name = String(r.name).trim()

			if (!name || seen.has(name) || !isOffMapScript(name)) continue
			seen.add(name)
			pool.push(name)
			pool.push(addressVariant(name, hashFNV1a(name)))

			kept++
		}

		report?.(`  ${lang}: ${kept}`)
	}

	// Sorting by hash shuffles deterministically before the 80/10/10 split.
	pool.sort((a, b) => hashFNV1a(a) - hashFNV1a(b))
	const nVal = Math.floor(pool.length * 0.1)
	const nTest = Math.floor(pool.length * 0.1)

	const splits: Record<string, string[]> = {
		val: pool.slice(0, nVal),
		test: pool.slice(nVal, nVal + nTest),
		train: pool.slice(nVal + nTest),
	}

	for (const [split, names] of Object.entries(splits)) {
		const lines = names.map((raw) => stringifyJSON({ raw, country: "OTHER" })).join("\n") + "\n"
		await appendLocalTextFile(lines, resolvePath(dataDir, `${split}.jsonl`))
		report?.(`appended ${names.length} OTHER → ${split}.jsonl`)
	}

	report?.(`total OTHER pool: ${pool.length}`)

	return { total: pool.length }
}
