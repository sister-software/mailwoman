/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Outlier-exposure data for the #244 coarse-placer's explicit "OTHER" (off-map) class — milestone
 *   2. The closed-set model is confidently wrong on scripts it never saw (Cyrillic→DE@0.71). The
 *   fix is to TRAIN an "off my loaded map" class on those scripts. Source: the WOF `names` table,
 *   which carries native-script alternate names in dozens of languages
 *   (rus/ukr/ara/ell/heb/hin/tha/kat/hye/…) — i.e. exactly the off-map scripts we want the model to
 *   learn to abstain on. Balanced per-language for script diversity, filtered to a genuinely
 *   off-map dominant script (not Latin, not CJK — those are the in-map countries), then APPENDED to
 *   the train/val/test splits as `country: "OTHER"`.
 *
 *   Run AFTER build-dataset. Run: `mailwoman placer build-dataset --outliers exposure [--per-lang
 *   2500]`
 */

import { appendFileSync } from "node:fs"
import * as path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "../../utils/data-root.ts"
import { repoRootPath } from "../../utils/repo.ts"
import { hashFNV1a } from "./fnv-hash.ts"

/** Options for {@linkcode buildOutlierExposure}. */
export interface BuildOutlierExposureOptions {
	/** Names sampled per off-map language. Default 2500. */
	perLang?: number
	/** WOF admin SQLite path. Default `$MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db`. */
	wof?: string
	/** Dataset dir the OTHER rows append to. Default `<repo>/data/coarse-placer`. */
	data?: string
}

/** Result of {@linkcode buildOutlierExposure}. */
export interface BuildOutlierExposureResult {
	/** Total OTHER pool size (names + address-shaped variants). */
	total: number
}

// Off-map languages whose `names` are written in a NON-Latin, NON-CJK script (CJK = the in-map CN/JP/KR/TW).
const OFF_MAP_LANGS = [
	"rus",
	"ukr",
	"bel",
	"bul",
	"srp",
	"mkd", // Cyrillic
	"ell", // Greek
	"ara",
	"fas",
	"urd",
	"snd",
	"pus", // Arabic-script
	"heb",
	"yid", // Hebrew
	"hin",
	"mar",
	"nep",
	"san", // Devanagari
	"ben",
	"tam",
	"tel",
	"kan",
	"mal",
	"sin", // Brahmic
	"tha",
	"lao",
	"khm",
	"mya", // SE-Asian
	"kat",
	"hye",
	"amh", // Georgian / Armenian / Ethiopic
]

/** Dominant script must be off-map: has chars in a non-Latin, non-CJK, non-digit block. */
function isOffMapScript(s: string): boolean {
	let off = 0
	let total = 0

	for (const ch of s) {
		const cp = ch.codePointAt(0)!

		if (cp <= 0x40 || (cp >= 0x5b && cp <= 0x60) || cp === 0x20) continue // punct/space/digits
		total++
		const latin = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)
		const cjk =
			(cp >= 0x3040 && cp <= 0x30ff) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xac00 && cp <= 0xd7af) ||
			(cp >= 0x3400 && cp <= 0x4dbf)

		if (!latin && !cjk && cp > 0x2ff) {
			off++
		}
	}

	return total > 0 && off / total > 0.6
}

// Mimic a real off-map ADDRESS: a pure-script place name isn't what we see at inference (those carry
// Latin digits + structure, e.g. "ул. Тверская, д. 1"). For each name we also emit an address-shaped
// variant — name + a house number, deterministically — so the model learns "off-map script + digits =
// still OTHER" and doesn't get pulled to a country by the numeric/punctuation n-grams.
function addressVariant(name: string, h: number): string {
	const n = (h % 4) + 1 // 1–4 digit house number
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

/** Coarse-placer non-Latin outlier-exposure builder — see the module doc. */
export async function buildOutlierExposure(
	options: BuildOutlierExposureOptions = {},
	report?: (line: string) => void
): Promise<BuildOutlierExposureResult> {
	const PER = options.perLang ?? 2500
	const wofPath = options.wof || dataRootPath("wof", "admin-global-priority.db")
	const dataDir = options.data || repoRootPath("data", "coarse-placer")

	const db = new DatabaseSync(wofPath, { readOnly: true })
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
			pool.push(addressVariant(name, hashFNV1a(name))) // address-shaped sibling
			kept++
		}
		report?.(`  ${lang}: ${kept}`)
	}
	db.close()

	// Deterministic shuffle (FNV hash sort) + split 80/10/10, append as OTHER.
	pool.sort((a, b) => hashFNV1a(a) - hashFNV1a(b))
	const nVal = Math.floor(pool.length * 0.1)
	const nTest = Math.floor(pool.length * 0.1)
	const splits: Record<string, string[]> = {
		val: pool.slice(0, nVal),
		test: pool.slice(nVal, nVal + nTest),
		train: pool.slice(nVal + nTest),
	}

	for (const [split, names] of Object.entries(splits)) {
		const lines = names.map((raw) => JSON.stringify({ raw, country: "OTHER" })).join("\n") + "\n"
		appendFileSync(path.join(dataDir, `${split}.jsonl`), lines)
		report?.(`appended ${names.length} OTHER → ${split}.jsonl`)
	}
	report?.(`total OTHER pool: ${pool.length}`)

	return { total: pool.length }
}
