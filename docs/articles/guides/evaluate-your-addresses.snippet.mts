import { readFile } from "node:fs/promises"

import { createParser, flattenTreeNodes } from "mailwoman"

interface Component {
	tag: string
	value: string
}

interface LabeledAddress {
	id: string
	input: string
	expected: { kind: string; components: Component[] }
}

const rows: LabeledAddress[] = JSON.parse(await readFile("addresses.json", "utf8"))

if (!Array.isArray(rows) || !rows.length) throw new Error("addresses.json needs at least one labeled row")

let exact = 0
const failures: Array<{ id: string; input: string; expected: unknown; observed: unknown }> = []

function sortComponents(components: Component[]): Component[] {
	return components.toSorted((a, b) => a.tag.localeCompare(b.tag) || a.value.localeCompare(b.value))
}

await using parser = await createParser()

for (const row of rows) {
	const result = await parser.parse(row.input)

	const observed = {
		kind: result.kind.kind,
		components: flattenTreeNodes(result.tree).map(({ tag, value }) => ({ tag, value })),
	}

	const expected = row.expected
	const expectedComponents = sortComponents(expected.components)
	const observedComponents = sortComponents(observed.components)

	const matches =
		result.faults.length === 0 &&
		observed.kind === expected.kind &&
		JSON.stringify(observedComponents) === JSON.stringify(expectedComponents)

	if (matches) {
		exact++
	} else {
		failures.push({ id: row.id, input: row.input, expected, observed: { ...observed, faults: result.faults } })
	}
}

console.log(`Exact labeled rows: ${exact}/${rows.length}`)
console.log(`Different or faulted rows: ${failures.length}/${rows.length}`)

for (const failure of failures) {
	console.log(JSON.stringify(failure))
}
