/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compares each regression-board row's written form against the form this repository's own layout
 *   would produce from that row's expected components.
 *
 *   Training rows are built by an adapter or a recipe that renders a line through a codex layout. Board
 *   rows carry a `source` naming an operator sweep or an issue, so a person wrote them. Those are two
 *   different written surfaces, and a decoder fitted on the first is graded on the second.
 *
 *   This reports how far apart they are, per country, without a parser and without a GPU. A row whose
 *   `input` matches its rendered twin sits inside the surface the training rows teach. A row that
 *   differs is a form no adapter or recipe emits.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/corpus/board-surface-gap.run.ts [--country GB] [--show 15] [--json <out>]
 */

import { formatAddressRow } from "@mailwoman/codex/address-format"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { loadRegressionCases } from "#eval-harness/gauntlet/cases/load"

const { values } = parseArguments({
	options: {
		country: { type: "string", description: "Restrict to one ISO country code" },
		show: { type: "string", description: "How many differing rows to print (default 15)" },
		json: { type: "string", description: "Write the per-row verdicts to this path" },
	},
})

const show = Number(values.show ?? 15)

if (!Number.isFinite(show) || show < 0) throw new Error(`--show must be a non-negative number, read ${values.show}`)

const cases = await loadRegressionCases()
const country = values.country?.toUpperCase()

interface Verdict {
	id: string
	country: string
	input: string
	rendered: string | null
	match: boolean
}

const verdicts: Verdict[] = []
let noComponents = 0
let noRender = 0

for (const seed of cases) {
	if (country && seed.country?.toUpperCase() !== country) continue

	const components = seed.expectComponents

	// A row with no expected components states no structure to render from,
	// so it is counted and excluded rather than scored as a mismatch.
	if (!components || !Object.keys(components).length) {
		noComponents++

		continue
	}

	const rendered = formatAddressRow({ ...components }, seed.country ?? "", { singleLine: true })

	if (!rendered) {
		noRender++
		verdicts.push({ id: seed.id, country: seed.country ?? "", input: seed.input, rendered: null, match: false })

		continue
	}

	verdicts.push({
		id: seed.id,
		country: seed.country ?? "",
		input: seed.input,
		rendered: rendered.raw,
		match: rendered.raw === seed.input,
	})
}

const comparable = verdicts.filter((verdict) => verdict.rendered !== null)
const matched = comparable.filter((verdict) => verdict.match)

console.log(`board rows considered: ${cases.length}`)
console.log(`  no expected components, excluded: ${noComponents}`)
console.log(`  components present but the layout rendered no line: ${noRender}`)
console.log(`  comparable: ${comparable.length}`)
console.log(
	`  input identical to its rendered twin: ${matched.length}` +
		(comparable.length ? `  (${((matched.length / comparable.length) * 100).toFixed(1)}%)` : "")
)

const byCountry = new Map<string, { comparable: number; matched: number }>()

for (const verdict of comparable) {
	const entry = byCountry.get(verdict.country) ?? { comparable: 0, matched: 0 }

	entry.comparable++

	if (verdict.match) {
		entry.matched++
	}

	byCountry.set(verdict.country, entry)
}

console.log(`\nper country, rows whose written form our layout reproduces:`)

for (const [code, entry] of [...byCountry].toSorted((a, b) => b[1].comparable - a[1].comparable).slice(0, 15)) {
	console.log(
		`  ${code}  ${entry.matched} of ${entry.comparable}  ${((entry.matched / entry.comparable) * 100).toFixed(1)}%`
	)
}

const differing = comparable.filter((verdict) => !verdict.match)

console.log(`\nfirst ${Math.min(show, differing.length)} of ${differing.length} differing rows:`)

for (const verdict of differing.slice(0, show)) {
	console.log(`\n  ${verdict.id} (${verdict.country})`)
	console.log(`    board:    ${verdict.input}`)
	console.log(`    rendered: ${verdict.rendered}`)
}

if (values.json) {
	await writeLocalJSONFile(
		{
			rowsConsidered: cases.length,
			noComponents,
			noRender,
			comparable: comparable.length,
			matched: matched.length,
			byCountry: [...byCountry].map(([code, entry]) => ({ country: code, ...entry })),
			verdicts,
		},
		values.json
	)

	console.log(`\nwrote ${values.json}`)
}
