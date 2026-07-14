/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parity-corpus rescue (#1093, spec §Parity-corpus rescue): convert the extracted v1 parity
 *   assertions (`parity-inputs.jsonl`, legacy-Classification-keyed) into ComponentTag-keyed eval
 *   fixtures for `mailwoman eval parity`. Top-solution gold only (`expected[0]` — the positional
 *   alternatives were rules-ranking artifacts); cases whose gold carries an unmapped legacy tag
 *   (given_name, surname, personal_title, …) or no expectation at all become TOMBSTONES — kept in
 *   the fixture file with a `dropped` reason so provenance survives, skipped by the runner.
 *   Run from the repo root: `node mailwoman/dev-tools/convert-parity-fixtures.run.ts`
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import type { Classification } from "@mailwoman/core"
import { legacyClassificationToComponentTag } from "@mailwoman/core/types"
import { readJSONL, writeJSONL } from "@mailwoman/core/utils"

import { type ParityCase } from "./parity-extract.ts"

const IN_PATH = "mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"
const OUT_PATH = "mailwoman/eval-harness/fixtures/parity-corpus.jsonl"

/** Parity test file basename token → ISO-3166 alpha-2. Files without a country token score as ZZ. */
const FILE_COUNTRY: Record<string, string> = {
	aus: "AU",
	bra: "BR",
	cze: "CZ",
	deu: "DE",
	esp: "ES",
	fra: "FR",
	gbr: "GB",
	hrv: "HR",
	ind: "IN",
	nld: "NL",
	nor: "NO",
	nzd: "NZ",
	pol: "PL",
	prt: "PT",
	rom: "RO",
	svk: "SK",
	swe: "SE",
	usa: "US",
}

function countryFor(file: string): string {
	const base = file.split("/").pop() ?? ""

	for (const [token, iso] of Object.entries(FILE_COUNTRY)) {
		if (base.includes(`.${token}.`)) return iso
	}

	return "ZZ"
}

export interface ParityFixture {
	/** Stable id: `v1-<basename>-<index-within-file>`. */
	id: string
	input: string
	country: string
	/** Provenance: the v1 parity file this assertion came from. */
	source: string
	/** ComponentTag-keyed gold (top rules solution's hand-written expectation). Absent on tombstones. */
	expect?: Record<string, string[]>
	/** Tombstone reason; the runner skips these rows but the provenance survives. */
	dropped?: string
	/** Count of positional alternative records the v1 assertion carried beyond the gold. */
	alternatives?: number
	/** Legacy tags in the gold that have no ComponentTag equivalent — dropped from `expect`, recorded here. */
	droppedTags?: string[]
}

const cases = readJSONL<ParityCase>(IN_PATH)
const fixtures: ParityFixture[] = []
const droppedTagCounts = new Map<string, number>()
const perFileIndex = new Map<string, number>()

for (const parityCase of cases) {
	const base = (parityCase.file.split("/").pop() ?? parityCase.file).replace(/\.test\.ts$/, "")
	const index = (perFileIndex.get(base) ?? 0) + 1
	perFileIndex.set(base, index)

	const fixture: ParityFixture = {
		id: `v1-${base}-${index}`,
		input: parityCase.input,
		country: countryFor(parityCase.file),
		source: `v1-parity:${parityCase.file}`,
	}

	const gold = parityCase.expected[0]

	if (gold === undefined) {
		fixtures.push({ ...fixture, dropped: "rules-era no-solution assertion (nothing to expect)" })

		continue
	}

	if (typeof gold !== "object" || gold === null || Array.isArray(gold)) {
		fixtures.push({ ...fixture, dropped: `non-record gold expectation: ${JSON.stringify(gold).slice(0, 80)}` })

		continue
	}

	const expect: Record<string, string[]> = {}
	const unmapped: string[] = []

	for (const [legacyTag, values] of Object.entries(gold as Record<string, unknown>)) {
		const componentTag = legacyClassificationToComponentTag(legacyTag as Classification)

		if (componentTag === null) {
			unmapped.push(legacyTag)
			droppedTagCounts.set(legacyTag, (droppedTagCounts.get(legacyTag) ?? 0) + 1)

			continue
		}

		expect[componentTag] = Array.isArray(values) ? values.map(String) : [String(values)]
	}

	// A case whose gold is ENTIRELY unmappable tombstones; a partially-mappable one keeps its
	// mapped gold (dropping e.g. `unit_designator` must not discard the case's house_number/street
	// expectations — the AU unit patterns are campaign targets).
	if (Object.keys(expect).length === 0) {
		fixtures.push({ ...fixture, dropped: `unmapped legacy tags: ${unmapped.join(", ")}` })

		continue
	}

	const alternatives = parityCase.expected.length - 1
	const out: ParityFixture = { ...fixture, expect }

	if (alternatives > 0) {
		out.alternatives = alternatives
	}

	if (unmapped.length > 0) {
		out.droppedTags = unmapped
	}

	fixtures.push(out)
}

mkdirSync(dirname(OUT_PATH), { recursive: true })
const written = writeJSONL(OUT_PATH, fixtures)
const dropped = fixtures.filter((f) => f.dropped).length

console.error(`converted ${written} fixtures (${written - dropped} live, ${dropped} tombstones)`)

for (const [tag, count] of [...droppedTagCounts.entries()].sort((a, b) => b[1] - a[1])) {
	console.error(`  dropped tag ${tag}: ${count} case(s)`)
}
