/**
 * Quick CLI for querying the FST. Run with:
 *   npx tsx scripts/fst-query.ts "New York"
 *   npx tsx scripts/fst-query.ts --db /path/to/wof.db "Portland"
 *   npx tsx scripts/fst-query.ts --show-continuations "New"
 */

import { buildFstFromWof } from "../resolver-wof-sqlite/fst-builder.js"

const args = process.argv.slice(2)
let dbPath = "/mnt/playpen/mailwoman-data/wof/whosonfirst-data-admin-us-latest.db"
let showContinuations = false
let maxResults = 10
const queries: string[] = []

for (let i = 0; i < args.length; i++) {
	const arg = args[i]!
	if (arg === "--db" && args[i + 1]) {
		dbPath = args[++i]!
	} else if (arg === "--show-continuations") {
		showContinuations = true
	} else if (arg === "--max" && args[i + 1]) {
		maxResults = parseInt(args[++i]!, 10)
	} else {
		queries.push(arg)
	}
}

if (queries.length === 0) {
	console.error("Usage: npx tsx scripts/fst-query.ts [--db path] [--show-continuations] <query>")
	process.exit(1)
}

console.error(`Building FST from ${dbPath}...`)
const start = performance.now()
const { matcher, result } = buildFstFromWof({
	dbPath,
	countries: ["US"],
	placetypes: ["country", "region", "county", "locality"],
	languages: ["eng", ""],
})
const elapsed = ((performance.now() - start) / 1000).toFixed(1)
console.error(`Built: ${result.stateCount} states, ${result.placeCount} places, ${result.edgeCount} edges (${elapsed}s)\n`)

for (const query of queries) {
	const q = matcher.query(query)

	console.log(`"${query}" → path: [${q.path.map((t) => `"${t}"`).join(", ")}]`)
	console.log(`  State: ${q.stateId}, Accepting: ${q.accepting.length} interpretations`)

	if (q.accepting.length > 0) {
		const sorted = [...q.accepting].sort((a, b) => b.population - a.population)
		const shown = sorted.slice(0, maxResults)
		console.log(`  Top by population:`)
		for (const p of shown) {
			const pop = p.population > 0 ? ` pop ${p.population.toLocaleString()}` : ""
			const chain = p.parentChain.length > 0 ? ` chain=[${p.parentChain.join("→")}]` : ""
			console.log(`    ${p.placetype.padEnd(12)} ${p.name.padEnd(20)}${pop}${chain}  wof:${p.wofId}`)
		}
		if (sorted.length > maxResults) {
			console.log(`    ... and ${sorted.length - maxResults} more`)
		}
	}

	if (showContinuations && q.continuations.length > 0) {
		const shown = q.continuations
			.sort((a, b) => b.acceptingCount - a.acceptingCount)
			.slice(0, 15)
		console.log(`  Continuations (${q.continuations.length} total):`)
		for (const c of shown) {
			const acc = c.acceptingCount > 0 ? ` → ${c.acceptingCount} places` : ""
			console.log(`    "${c.token}"${acc}`)
		}
	}

	console.log()
}
