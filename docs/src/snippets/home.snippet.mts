import { createParser, decodeAsOutline } from "mailwoman"

await using parser = await createParser()

const result = await parser.parse("apt 4b 350 5th ave new york ny 10118")

console.log("normalized:", result.tree.raw)
console.log(decodeAsOutline(result.tree))
