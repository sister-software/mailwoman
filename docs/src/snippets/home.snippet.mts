import { decodeAsOutline, parse } from "mailwoman"

const result = await parse("apt 4b 350 5th ave new york ny 10118")

console.log("normalized:", result.tree.raw)
console.log(decodeAsOutline(result.tree))
