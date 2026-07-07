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

import { parseArgs } from "node:util"

import { expandAbbreviations, normalize } from "@mailwoman/normalize"
import express from "express"
import { createAddressParser } from "mailwoman"

import { createLibpostalRouter, type LibpostalEngine, type ParseMatch } from "./index.js"

function serve(): void {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "8081" },
			host: { type: "string", default: "0.0.0.0" },
			// Permissive CORS is on by default (browser clients need it). `--no-cors` turns it off for deployments
			// where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
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
		.use(createLibpostalRouter(engine, { cors: values.cors }))
		.listen(port, host, () => {
			console.error(`[@mailwoman/libpostal] listening on http://${host}:${port}`)
			console.error(`  cors: ${values.cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`)
			console.error(`  endpoints: POST/GET /parse  POST/GET /expand`)
		})
}

// Subcommand dispatch via parseArgs (strict:false — the per-command parsers own their flags).
const command = parseArgs({ strict: false, allowPositionals: true }).positionals[0]

switch (command) {
	case "serve":
		serve()
		break
	default:
		console.error("Usage: mailwoman-libpostal serve [--port 8081] [--host 0.0.0.0] [--no-cors]")
		process.exit(command ? 1 : 0)
}
