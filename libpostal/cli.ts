#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-libpostal` — boot a libpostal-compatible parse/expand endpoint via the `serve`
 *   command. Usage + examples live in the package README.
 *
 *   Wires the real engine: `/parse` over Mailwoman's `createAddressParser` (the neural BIO tagger),
 *   `/expand` over `@mailwoman/normalize`. `/expand` is honest-minimal: it returns the original
 *   plus the deterministic normalized + abbreviation-expanded forms, not libpostal's probabilistic
 *   variants.
 */

import { expandAbbreviations, normalize } from "@mailwoman/normalize"
import express from "express"
import { createAddressParser } from "mailwoman"
import { parseArgs } from "node:util"
import { createLibpostalRouter, type LibpostalEngine, type ParseMatch } from "./index.js"

function serve(): void {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "8081" },
			host: { type: "string", default: "0.0.0.0" },
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 8081
	const host = values.host ?? "0.0.0.0"

	const parser = createAddressParser()

	const engine: LibpostalEngine = {
		async parse(query) {
			const result = await parser.parse(query, { verbose: true })
			const solution = result.solutions[0]
			if (!solution) return []
			const json = solution.toJSON() as { matches?: ParseMatch[] }
			return (json.matches ?? []).map((m) => ({ classification: m.classification, value: m.value }))
		},
		async expand(address) {
			const normalized = normalize(address).normalized
			const expanded = expandAbbreviations(normalized).text
			// Deterministic forms only; dedup while preserving order.
			return [...new Set([address, normalized, expanded])]
		},
	}

	express()
		.use(createLibpostalRouter(engine))
		.listen(port, host, () => {
			console.error(`[@mailwoman/libpostal] listening on http://${host}:${port}`)
			console.error(`  endpoints: POST/GET /parse  POST/GET /expand`)
		})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		serve()
		break
	default:
		console.error("Usage: mailwoman-libpostal serve [--port 8081] [--host 0.0.0.0]")
		process.exit(command ? 1 : 0)
}
