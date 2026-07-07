/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #493 unknown-span report — the self-reporting corpus-gap detector. Runs the parser over the golden
 *   eval set (a stand-in for demo traffic until the traffic aggregation lands), computes {@link unknownSpans}
 *   for every parse, and aggregates the all-O runs the model left unclassified into a ranked "shopping list"
 *   of what the model systematically fails to tag. Grounded, CPU-only, no eval-gate: it MEASURES the gap,
 *   it doesn't change a contract.
 *
 *   Run with --expose-gc (the onnxruntime batch leak SIGKILLs a few hundred parses otherwise):
 *     node --expose-gc scripts/eval/unknown-span-report.ts [--files us.jsonl,adversarial.jsonl,fr.jsonl] [--out report.md]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { unknownSpans } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const argv = process.argv.slice(2)
const arg = (name: string, dflt: string): string => {
	const i = argv.indexOf(`--${name}`)

	return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt
}
const GOLDEN_DIR = arg("golden-dir", "data/eval/golden/v0.1.2")
const FILES = arg("files", "us.jsonl,fr.jsonl,adversarial.jsonl")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
const OUT = arg("out", "")

interface GoldenRow {
	raw: string
	country?: string
}

/** Fold an unknown-span value to a frequency key: lowercase, collapse digits to `#`, trim punctuation. */
function gapKey(value: string): string {
	const t = value.trim().toLowerCase().replace(/\d+/g, "#")

	return t.replace(/^[\s,.;:/-]+|[\s,.;:/-]+$/g, "")
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })

let total = 0
let withContentGap = 0
let contentGapChars = 0
let wsGapChars = 0
let totalChars = 0
const gapFreq = new Map<string, number>()
const pos = { leading: 0, trailing: 0, interior: 0, whole: 0 }
const perLocale = new Map<string, { n: number; withContentGap: number }>()

/** A gap is trivial (a delimiter) if it's only whitespace + punctuation — the expected inter-token run. */
const isTrivialGap = (value: string): boolean => gapKey(value) === "" && /^[\s\p{P}]*$/u.test(value)

for (const file of FILES) {
	const path = resolve(GOLDEN_DIR, file)
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean)

	for (const line of lines) {
		let row: GoldenRow

		try {
			row = JSON.parse(line) as GoldenRow
		} catch {
			continue
		}

		if (!row.raw) continue
		const loc = row.country ?? file.replace(".jsonl", "")
		const lstat = perLocale.get(loc) ?? { n: 0, withContentGap: 0 }
		total += 1
		lstat.n += 1
		totalChars += row.raw.length

		const tree = await classifier.parse(row.raw)
		const gaps = unknownSpans(tree)

		let rowHasContent = false

		for (const g of gaps) {
			if (isTrivialGap(g.value)) {
				wsGapChars += g.end - g.start

				continue
			}
			rowHasContent = true
			contentGapChars += g.end - g.start
			const key = gapKey(g.value)

			if (key) {
				gapFreq.set(key, (gapFreq.get(key) ?? 0) + 1)
			}

			const atStart = g.start === 0
			const atEnd = g.end === tree.raw.length

			if (atStart && atEnd) {
				pos.whole += 1
			} else if (atStart) {
				pos.leading += 1
			} else if (atEnd) {
				pos.trailing += 1
			} else {
				pos.interior += 1
			}
		}

		if (rowHasContent) {
			withContentGap += 1
			lstat.withContentGap += 1
		}

		perLocale.set(loc, lstat)

		if (total % 200 === 0) {
			globalThis.gc?.()
			process.stderr.write(`\r[unknown-span] ${total} parsed…`)
		}
	}
}
process.stderr.write("\n")

const topGaps = [...gapFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
const L: string[] = []
L.push(`# #493 unknown-span report — corpus-gap detector\n`)
L.push(`_Parser over the golden eval set (${FILES.join(", ")}); "unknown" = an all-O run no node covers._\n`)
L.push(
	`**Trivial (delimiter) gaps are separated out** — inter-token whitespace/punctuation is all-O by design and not a corpus gap. The numbers below count only CONTENT gaps (an untagged run with a letter/digit/CJK char).\n`
)
L.push(
	`- Inputs: **${total}** · with ≥1 **content** gap: **${withContentGap}** (${((100 * withContentGap) / total).toFixed(1)}%)`
)
L.push(
	`- Content-gap chars: **${contentGapChars}** (${((100 * contentGapChars) / totalChars).toFixed(2)}% of input) · delimiter-gap chars (ignored): ${wsGapChars}`
)
L.push(
	`- Content-gap position: leading ${pos.leading} · trailing ${pos.trailing} · interior ${pos.interior} · whole-input ${pos.whole}`
)
L.push(`\n## By locale (content gaps)\n`)
L.push(`| Locale | inputs | with-content-gap | % |`)
L.push(`| --- | ---: | ---: | ---: |`)

for (const [loc, s] of [...perLocale.entries()].sort((a, b) => b[1].withContentGap - a[1].withContentGap)) {
	L.push(`| ${loc} | ${s.n} | ${s.withContentGap} | ${((100 * s.withContentGap) / s.n).toFixed(1)}% |`)
}
L.push(`\n## Top content gaps — the shopping list (digits folded to \`#\`)\n`)
L.push(`| Gap text | count |`)
L.push(`| --- | ---: |`)

for (const [key, n] of topGaps) {
	L.push(`| \`${key}\` | ${n} |`)
}

const report = L.join("\n")
console.log(report)

if (OUT) {
	writeFileSync(OUT, report)
	process.stderr.write(`[unknown-span] wrote ${OUT}\n`)
}
process.exit(0)
