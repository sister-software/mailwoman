import { decodeAsOutline, parse } from "mailwoman"

const result = await parse("apt 4b 350 5th ave new york ny 10118")

console.log("input:", result.input)
console.log("tree.raw:", result.tree.raw)
console.log("locale:", result.locale.locale)
console.log("kind:", result.kind.kind)
console.log(decodeAsOutline(result.tree))
