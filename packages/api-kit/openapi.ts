/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAPI emit helpers. The document is always derived from the route table — never
 *   handwritten. 3.1 is the published flavor; 3.0 exists solely for client generators that lag
 *   (progenitor), replacing the old hand-downgrade step.
 */

import type { OpenAPIHono } from "@hono/zod-openapi"
import { makeDirectoriesSync, writeLocalTextFileSync } from "@mailwoman/core/fs/writers-sync"
import { dirname } from "@mailwoman/platform/path"

type OpenAPISecurityRequirements = Parameters<OpenAPIHono["getOpenAPI31Document"]>[0]["security"]

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
	security?: OpenAPISecurityRequirements
}

/**
 * Split an `OpenAPIDocInfo` into the document's `info` block and its top-level sibling fields.
 */
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

/**
 * Mount the OpenAPI 3.1 document endpoint on `app` (default `/openapi.json`).
 */
export function attachOpenAPIDocs(app: OpenAPIHono, info: OpenAPIDocInfo, path = "/openapi.json"): void {
	const config: Parameters<OpenAPIHono["doc31"]>[1] = { openapi: "3.1.0", ...toDocumentConfig(info) }

	app.doc31(path, config)
}

/**
 * Emit both document flavors programmatically (build artifacts, parity tests, client generation).
 */
export function emitOpenAPIDocuments(app: OpenAPIHono, info: OpenAPIDocInfo): { v31: object; v30: object } {
	const v31Config: Parameters<OpenAPIHono["getOpenAPI31Document"]>[0] = {
		openapi: "3.1.0",
		...toDocumentConfig(info),
	}

	const v30Config: Parameters<OpenAPIHono["getOpenAPIDocument"]>[0] = {
		openapi: "3.0.3",
		...toDocumentConfig(info),
	}

	return {
		v31: app.getOpenAPI31Document(v31Config),
		v30: app.getOpenAPIDocument(v30Config),
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
		makeDirectoriesSync(dirname(opts.out))
		writeLocalTextFileSync(`${json}\n`, opts.out)
	} else {
		console.log(json)
	}
}

/**
 * An OpenAPI error-response descriptor: a description plus a JSON body of `schema`.
 *
 * Takes the schema rather than owning one, because each drop-in's error envelope reproduces the wire shape of the
 * project it replaces — Nominatim's differs from libpostal's, and both are recorded decisions rather than drift. What
 * repeats between them is this four-line descriptor, not the shape it wraps.
 */
export function errorContent<S>(description: string, schema: S) {
	return {
		description,
		content: { "application/json": { schema } },
	}
}
