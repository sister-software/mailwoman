/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAPI emit helpers. The document is always derived from the route table — never
 *   handwritten. 3.1 is the published flavor; 3.0 exists solely for client generators that lag
 *   (progenitor), replacing the old hand-downgrade step.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import type { OpenAPIHono } from "@hono/zod-openapi"

/**
 * The document config stamped into emitted documents: `title`/`version`/`description`/`summary`/`license`/`contact`
 * land under the document's `info` block; `externalDocs`/`servers`/`tags`/`security` are top-level document fields. All
 * fields beyond `title`/`version` are optional — existing callers that only pass those two are unaffected.
 */
export interface OpenAPIDocInfo {
	title: string
	version: string
	description?: string
	summary?: string
	license?: { name: string; identifier?: string }
	contact?: { name?: string; url?: string }
	externalDocs?: { description?: string; url: string }
	servers?: Array<{
		url: string
		description?: string
		variables?: Record<string, { default: string; description?: string }>
	}>
	tags?: Array<{ name: string; description?: string }>
	security?: unknown[]
}

/** Split an `OpenAPIDocInfo` into the document's `info` block and its top-level sibling fields. */
function toDocumentConfig(info: OpenAPIDocInfo) {
	const { title, version, description, summary, license, contact, externalDocs, servers, tags, security } = info

	return {
		info: { title, version, description, summary, license, contact },
		externalDocs,
		servers,
		tags,
		security,
	}
}

/** Mount the OpenAPI 3.1 document endpoint on `app` (default `/openapi.json`). */
export function attachOpenAPIDocs(app: OpenAPIHono, info: OpenAPIDocInfo, path = "/openapi.json"): void {
	// openapi3-ts's InfoObject/OpenAPIObject carry an `x-${string}` extension index signature that
	// a plain interface can't satisfy — cast at the boundary rather than widening the public type.
	app.doc31(path, { openapi: "3.1.0", ...toDocumentConfig(info) } as never)
}

/** Emit both document flavors programmatically (build artifacts, parity tests, client generation). */
export function emitOpenAPIDocuments(app: OpenAPIHono, info: OpenAPIDocInfo): { v31: object; v30: object } {
	return {
		v31: app.getOpenAPI31Document({ openapi: "3.1.0", ...toDocumentConfig(info) } as never),
		v30: app.getOpenAPIDocument({ openapi: "3.0.3", ...toDocumentConfig(info) } as never),
	}
}

/**
 * The shared body of every surface's `openapi` CLI subcommand (the three drop-ins + `mailwoman openapi`): pick the
 * flavor `emitOpenAPIDocuments` produces (`--flavor 3.0` → the 3.0.3 diet client generators like progenitor want;
 * default 3.1.0), then either print it to stdout or write it to `out`. Always compact (single-line) JSON — never
 * pretty-printed — so the stdout form is a stable `startsWith('{"openapi":"3.1.0"')` smoke check, matching what a live
 * `/openapi.json` response looks like. `out`'s parent directory is created if missing (the docs build writes into a
 * gitignored, not-yet-existing `docs/static/openapi/`). One place owns this so the four emitters can't drift out of
 * lockstep with each other.
 */
export function printOpenAPIDocument(
	app: OpenAPIHono,
	info: OpenAPIDocInfo,
	opts: { flavor?: string; out?: string } = {}
): void {
	const { v31, v30 } = emitOpenAPIDocuments(app, info)
	const json = JSON.stringify(opts.flavor === "3.0" ? v30 : v31)

	if (opts.out) {
		mkdirSync(dirname(opts.out), { recursive: true })
		writeFileSync(opts.out, `${json}\n`)
	} else {
		console.log(json)
	}
}
