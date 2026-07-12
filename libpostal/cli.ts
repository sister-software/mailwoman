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

import { printOpenAPIDocument, serveNode } from "@mailwoman/api-kit"
import { expandAbbreviations, normalize } from "@mailwoman/normalize"
import { createAddressParser } from "mailwoman"

import { createLibpostalApp, LIBPOSTAL_DOC_INFO, type LibpostalEngine, type ParseMatch } from "./index.ts"

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

	const app = createLibpostalApp(engine, { cors: values.cors })

	serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: () => {
			console.error(`[@mailwoman/libpostal] listening on http://${host}:${port}`)
			console.error(`  cors: ${values.cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`)
			console.error(`  endpoints: POST/GET /parse  POST/GET /expand  GET /openapi.json`)
		},
	})
}

/**
 * `openapi` — print (or `--out`-write) the emitted OpenAPI document for this surface. Builds the app around a stub
 * engine (`parse` is the one required {@link LibpostalEngine} method — a no-op is enough) so this NEVER boots the real
 * neural parser: pure route-table introspection, fast regardless of data-root state. `--flavor 3.0` prints the 3.0.3
 * diet instead of the default 3.1.0.
 */
function openapi(): void {
	const { values } = parseArgs({
		options: {
			flavor: { type: "string", default: "3.1" },
			out: { type: "string" },
		},
		allowPositionals: true,
	})

	if (values.flavor !== "3.1" && values.flavor !== "3.0") {
		console.error(`✗ --flavor must be "3.1" or "3.0" (got "${values.flavor}")`)
		console.error("Usage: mailwoman-libpostal openapi [--flavor 3.1|3.0] [--out <path>]")
		process.exit(1)
	}

	const stubEngine: LibpostalEngine = { parse: async () => [] }
	const app = createLibpostalApp(stubEngine)

	printOpenAPIDocument(app, LIBPOSTAL_DOC_INFO, values)
}

// Subcommand dispatch via parseArgs (strict:false — the per-command parsers own their flags).
const command = parseArgs({ strict: false, allowPositionals: true }).positionals[0]

switch (command) {
	case "serve":
		serve()
		break
	case "openapi":
		openapi()
		break
	default:
		console.error(
			[
				"Usage: mailwoman-libpostal <command>",
				"  serve [--port 8081] [--host 0.0.0.0] [--no-cors]",
				"  openapi [--flavor 3.1|3.0] [--out <path>]",
			].join("\n")
		)
		process.exit(command ? 1 : 0)
}
