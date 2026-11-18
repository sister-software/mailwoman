import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createRuntimePipeline } from "mailwoman"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })
const result = await parse("apt 4b 350 5th ave new york ny 10118")

type TreeNode = (typeof result)["tree"]["roots"][number]

console.log("normalized:", result.tree.raw)

function printNode(node: TreeNode, depth = 0): void {
	console.log(`${"  ".repeat(depth)}${node.tag}: ${JSON.stringify(node.value)}`)

	for (const child of node.children) {
		printNode(child, depth + 1)
	}
}

for (const root of result.tree.roots) {
	printNode(root)
}
