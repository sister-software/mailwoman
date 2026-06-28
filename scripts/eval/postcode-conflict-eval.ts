import { readFileSync, writeFileSync } from "node:fs"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode/city CONFLICT falsehoods eval (#276). The differentiator a retrieval/BM25 geocoder can't
 *   offer: when the address's postcode and its parsed city name point to geographically different
 *   places (a transposed / wrong-for-the-city postcode), the coordinate-first resolver returns the
 *   named city but raises `postcode_city_mismatch`. This eval feeds the resolver a set of CONFLICT
 *   rows (must flag) and CONTROL rows (correct or abutting — must NOT flag) and scores the flag.
 *
 *   We build the AddressTree directly from each row's components (locality + postcode siblings) so
 *   the eval isolates the RESOLVER's conflict detection, independent of the parser.
 *
 *   Run: node --experimental-strip-types scripts/eval/postcode-conflict-eval.ts\
 *   --eval data/eval/falsehoods/postcode-city-conflicts.jsonl [--out-md <path>] (`--wof` defaults to
 *   admin-global-priority.db + postcode-locality-intl.db — coord-first on.)
 */
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { dataRootPath } from "@mailwoman/core/utils"
import { createWofResolver } from "@mailwoman/resolver"

function arg(name: string, fallback = ""): string {
	const i = process.argv.indexOf(`--${name}`)

	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback
}

interface Row {
	input: string
	locale?: string
	components: { locality?: string; postcode?: string }
	falsehood: string
	conflict: boolean
	expect_flag: boolean
}

function node(tag: string, value: string): AddressNode {
	return { tag, value, children: [] } as unknown as AddressNode
}

/** Did the resolved locality node carry the conflict flag? */
function flagged(tree: AddressTree): boolean {
	let hit = false
	const walk = (n: AddressNode): void => {
		const meta = n.metadata as Record<string, unknown> | undefined

		if (meta?.["postcode_city_mismatch"] === true) hit = true

		for (const c of n.children) walk(c)
	}

	for (const r of tree.roots) walk(r)

	return hit
}

const rows: Row[] = readFileSync(arg("eval", "data/eval/falsehoods/postcode-city-conflicts.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))

const wofPaths = arg(
	"wof",
	`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
).split(",")
const { WofSqlitePlaceLookup } = await import("@mailwoman/resolver-wof-sqlite")
const backend = new WofSqlitePlaceLookup({ databasePath: wofPaths.length === 1 ? wofPaths[0]! : wofPaths })
const resolver = createWofResolver(backend as never)

const results: Array<{ row: Row; flag: boolean; ok: boolean }> = []

for (const row of rows) {
	const roots: AddressNode[] = []

	if (row.components.locality) roots.push(node("locality", row.components.locality))

	if (row.components.postcode) roots.push(node("postcode", row.components.postcode))
	// Country from the row's locale tag ("de-DE" → "DE") so the test set can mix locales.
	const defaultCountry = (row.locale?.split("-")[1] ?? "").toUpperCase() || undefined
	const resolved = await resolver.resolveTree({ raw: row.input, roots }, { defaultCountry })
	const flag = flagged(resolved)
	results.push({ row, flag, ok: flag === row.expect_flag })
}

const conflicts = results.filter((r) => r.row.conflict)
const controls = results.filter((r) => !r.row.conflict)
const recall = conflicts.filter((r) => r.flag).length / (conflicts.length || 1)
const specificity = controls.filter((r) => !r.flag).length / (controls.length || 1)

const lines: string[] = []
lines.push(`# Postcode/city conflict falsehoods (#276)\n`)
lines.push(
	`Conflict recall (flagged the wrong-postcode): **${(100 * recall).toFixed(0)}%** (${conflicts.filter((r) => r.flag).length}/${conflicts.length})`
)
lines.push(
	`Control specificity (did NOT false-flag correct/abutting): **${(100 * specificity).toFixed(0)}%** (${controls.filter((r) => !r.flag).length}/${controls.length})\n`
)
lines.push(`| input | kind | expect flag | got flag | ok |`)
lines.push(`|---|---|:--:|:--:|:--:|`)

for (const r of results) {
	lines.push(
		`| ${r.row.input} | ${r.row.conflict ? "conflict" : "control"} | ${r.row.expect_flag} | ${r.flag} | ${r.ok ? "✅" : "❌"} |`
	)
}
const report = lines.join("\n")
console.log(report)

if (arg("out-md")) {
	writeFileSync(arg("out-md"), report + "\n")
	console.error(`wrote markdown → ${arg("out-md")}`)
}
backend.close?.()
process.exit(results.every((r) => r.ok) ? 0 : 1)
