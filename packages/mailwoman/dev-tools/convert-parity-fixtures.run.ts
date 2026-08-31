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
 *   Run from the repo root: `node packages/mailwoman/dev-tools/convert-parity-fixtures.run.ts`
 */

import type { Classification } from "@mailwoman/core"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { legacyClassificationToComponentTag } from "@mailwoman/core/types"
import { dirname } from "path-ts"
import { createNewlineWriter, JSONSpliterator } from "spliterator"

import type { ParityCase } from "#dev-tools/parity-extract"
import { PARITY_FIXTURES_V1_PATH, type ParityFixture } from "#eval-harness/parity-corpus"

const IN_PATH = "packages/mailwoman/test-fixtures/legacy-golden/parity-inputs.jsonl"

/**
 * Parity test file basename token → ISO-3166 alpha-2. Files without a country token score as ZZ.
 */
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

const cases = await Array.fromAsync(JSONSpliterator.fromAsync<ParityCase>(IN_PATH))
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
	if (!Object.keys(expect).length) {
		fixtures.push({ ...fixture, dropped: `unmapped legacy tags: ${unmapped.join(", ")}` })

		continue
	}

	const alternatives = parityCase.expected.length - 1
	const out: ParityFixture = { ...fixture, expect }

	if (alternatives > 0) {
		out.alternatives = alternatives
	}

	if (unmapped.length) {
		out.droppedTags = unmapped
	}

	fixtures.push(out)
}

await makeDirectories(dirname(PARITY_FIXTURES_V1_PATH))

{
	await using out = createNewlineWriter(PARITY_FIXTURES_V1_PATH)

	for (const fixture of fixtures) {
		await out.write(JSON.stringify(fixture))
	}
}

const written = fixtures.length
const dropped = fixtures.filter((f) => f.dropped).length

console.error(`converted ${written} fixtures (${written - dropped} live, ${dropped} tombstones)`)

for (const [tag, count] of [...droppedTagCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
	console.error(`  dropped tag ${tag}: ${count} case(s)`)
}
