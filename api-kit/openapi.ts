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

/** The `info` block stamped into emitted documents. */
export interface OpenAPIDocInfo {
	title: string
	version: string
	description?: string
}

/** Mount the OpenAPI 3.1 document endpoint on `app` (default `/openapi.json`). */
export function attachOpenAPIDocs(app: OpenAPIHono, info: OpenAPIDocInfo, path = "/openapi.json"): void {
	// openapi3-ts's InfoObject carries an `x-${string}` extension index signature that a plain
	// interface can't satisfy — cast at the boundary rather than widening the public type.
	app.doc31(path, { openapi: "3.1.0", info: info as never })
}

/** Emit both document flavors programmatically (build artifacts, parity tests, client generation). */
export function emitOpenAPIDocuments(app: OpenAPIHono, info: OpenAPIDocInfo): { v31: object; v30: object } {
	return {
		v31: app.getOpenAPI31Document({ openapi: "3.1.0", info: info as never }),
		v30: app.getOpenAPIDocument({ openapi: "3.0.3", info: info as never }),
	}
}
