/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Parity-campaign probe: where does the kind-classifier route fragment-class inputs? Classes are
 *   derived from the parity fixtures own gold tags (no synthesis bias). Run from the repo root:
 *   `node mailwoman/dev-tools/router-kind-probe.run.ts`
 */
import { readFileSync } from "node:fs"

import { classifyKind } from "@mailwoman/kind-classifier"
import { normalize } from "@mailwoman/normalize"
import { computeQueryShape } from "@mailwoman/query-shape"

interface Fixture {
	id: string
	input: string
	country: string
	expect?: Record<string, string[]>
	dropped?: string
}

const fixtures: Fixture[] = readFileSync("mailwoman/eval-harness/fixtures/parity-corpus.jsonl", "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.filter((f: Fixture) => !f.dropped && f.expect)

function classOf(expect: Record<string, string[]>): string {
	const tags = Object.keys(expect)
	const has = (t: string) => tags.includes(t)

	if (tags.length === 1 && has("street")) return "bare_street"
	if (tags.length === 2 && has("street") && has("house_number")) return "street_number"
	if (tags.length === 1 && has("locality")) return "bare_locality"
	if (has("locality") || has("postcode") || has("region") || has("country")) return "structured"

	return "other"
}

const table = new Map<string, Map<string, number>>()

for (const fixture of fixtures) {
	const cls = classOf(fixture.expect!)
	const normalized = normalize(fixture.input)
	const shape = computeQueryShape(normalized)
	const result = await classifyKind(normalized, shape, undefined)
	const row = table.get(cls) ?? new Map<string, number>()

	row.set(result.kind, (row.get(result.kind) ?? 0) + 1)
	table.set(cls, row)
}

for (const [cls, kinds] of [...table.entries()].sort()) {
	const total = [...kinds.values()].reduce((a, b) => a + b, 0)
	const parts = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`)

	console.log(`${cls.padEnd(14)} n=${String(total).padStart(3)}  ${parts.join("  ")}`)
}
