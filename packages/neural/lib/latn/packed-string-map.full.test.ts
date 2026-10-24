/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares the packed table with a `Map` over the Latin family's locality-surface lexicon, both by key and through the
 *   painter.
 *
 *   The file is the one `mwops release copy-weights` stages into `@mailwoman/neural-weights-en-us`, the Latin family's
 *   graph package. Its v7 build covers US, FR and DE places of the WOF placetypes `locality`, `localadmin` and
 *   `neighbourhood`. A pass here covers that lexicon only. A lexicon in another script needs its own parity test.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { describe, expect, test } from "vitest"

import { gazetteerCharPaint, parseGazetteerLexicon } from "#gazetteer-inference"
import { PackedStringMap } from "#latn/packed-string-map"

const LATIN_GRAPH_PACKAGE = "@mailwoman/neural-weights-en-us"
const LEXICON_PATH = resolvePackagePath(LATIN_GRAPH_PACKAGE, "locality-surface-lexicon-v7.json")

describe.skipIf(!(await pathExists(LEXICON_PATH)))(
	"PackedStringMap over the Latin family's locality-surface lexicon (v7)",
	() => {
		test("answers every key, and paints every probe, as a Map does", async () => {
			const raw = await readLocalJSONFile<Parameters<typeof parseGazetteerLexicon>[0]>(LEXICON_PATH)
			const lexicon = parseGazetteerLexicon(raw)
			const reference = new Map(Object.entries(raw.entries))
			const keys = [...reference.keys()]

			const packed = PackedStringMap.from(raw.entries)

			expect(packed.size).toBe(reference.size)

			for (const key of keys) {
				expect(lexicon.entries.get(key)).toBe(reference.get(key))
			}

			for (const key of keys.slice(0, 5000)) {
				expect(lexicon.entries.get(`${key}x`)).toBe(reference.get(`${key}x`))
			}

			// The reference lexicon holds the same entries in Maps.
			const mapLexicon = { ...lexicon, entries: reference, codeEntries: new Map(Object.entries(raw.code_entries)) }

			for (let index = 0; index < keys.length; index += 97) {
				const probe = `12 Main St, ${keys[index]} ${keys[(index * 7) % keys.length]}, 10115`

				expect(gazetteerCharPaint(probe, lexicon)).toEqual(gazetteerCharPaint(probe, mapLexicon))
			}
		}, 600_000)
	}
)
