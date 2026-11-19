import { type AddressNode, parse } from "mailwoman"

const result = await parse("apt 4b 350 5th ave new york ny 10118")

console.log("input:", result.input)
console.log("tree.raw:", result.tree.raw)
console.log("locale:", result.locale.locale)
console.log("kind:", result.kind.kind)

function printNode(node: AddressNode, depth = 0): void {
	const indent = "  ".repeat(depth)

	console.log(`${indent}${node.tag} [${node.start}, ${node.end}): ${JSON.stringify(node.value)}`)

	for (const child of node.children) {
		printNode(child, depth + 1)
	}
}

for (const root of result.tree.roots) {
	printNode(root)
}
