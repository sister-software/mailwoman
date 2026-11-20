// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   HTML encodings of the OGC API resources.
 *
 *   OGC API Common's HTML class asks that an HTML response include everything the
 *   JSON response includes and render every link as an `<a>` element.
 *   Each page here renders from the same value the JSON route serves, so the two encodings can't disagree.
 */

import type { OpenAPIHono } from "@hono/zod-openapi"
import { escapeHTML } from "@mailwoman/core/strings/escape"

import type { OGCServedCollection } from "#engine"
import {
	collectionVersionParameter,
	type OGCCollection,
	type OGCCollections,
	OGC_COLLECTION_VERSION,
	type OGCConformance,
	type OGCLandingPage,
	type OGCLink,
	type OGCSearchFeature,
	type OGCSearchResponse,
} from "#schema"

/**
 * The OpenAPI 3.0 document the generator emits.
 */
export type OpenAPI30Document = ReturnType<OpenAPIHono["getOpenAPIDocument"]>

const STYLE = `:root { color-scheme: light dark }
body { font: 16px/1.6 system-ui, -apple-system, sans-serif; max-width: 48rem; margin: 3rem auto; padding: 0 1.25rem }
h1 { font-size: 1.3rem; margin: 0 0 .5rem }
h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
ul { padding-left: 1.2rem }
li { margin: .3rem 0 }
a { color: #2563eb }
.meta { opacity: .75; font-size: .9rem }`

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${body}
</body>
</html>
`
}

function linkItem(link: OGCLink): string {
	const label = escapeHTML(link.title ?? link.href)
	const meta = [link.rel, link.type].filter((part): part is string => typeof part === "string").map(escapeHTML)

	return `<li><a href="${escapeHTML(link.href)}" rel="${escapeHTML(link.rel)}">${label}</a> <span class="meta">${meta.join(" &middot; ")}</span></li>`
}

function linkList(links: readonly OGCLink[]): string {
	return `<ul>\n${links.map(linkItem).join("\n")}\n</ul>`
}

/**
 * The landing page as HTML.
 */
export function landingPageHTML(landing: OGCLandingPage): string {
	return page(
		landing.title,
		`<h1>${escapeHTML(landing.title)}</h1>
<p>${escapeHTML(landing.description)}</p>
<h2>Links</h2>
${linkList(landing.links)}`
	)
}

/**
 * The conformance declaration as HTML.
 */
export function conformanceHTML(conformance: OGCConformance, links: readonly OGCLink[]): string {
	const classes = conformance.conformsTo.map(
		(uri) => `<li><a href="${escapeHTML(uri)}"><code>${escapeHTML(uri)}</code></a></li>`
	)

	return page(
		"Conformance",
		`<h1>Conformance</h1>
<p>The API conforms to these conformance classes.</p>
<ul>
${classes.join("\n")}
</ul>
<h2>Links</h2>
${linkList(links)}`
	)
}

function collectionSection(collection: OGCCollection, heading: "h1" | "h2"): string {
	return `<${heading}>${escapeHTML(collection.title)} <code>${escapeHTML(collection.id)}</code></${heading}>
<p>${escapeHTML(collection.description)}</p>
<p class="meta">Point features, version ${collection.version}</p>
${linkList(collection.links)}`
}

/**
 * The collections list as HTML.
 */
export function collectionsHTML(body: OGCCollections): string {
	return page(
		"Collections",
		`<h1>Collections</h1>
${linkList(body.links)}
${body.collections.map((collection) => collectionSection(collection, "h2")).join("\n")}`
	)
}

/**
 * One collection description as HTML.
 */
export function collectionHTML(collection: OGCCollection): string {
	return page(collection.title, collectionSection(collection, "h1"))
}

function searchFeatureItem(feature: OGCSearchFeature): string {
	const [lon, lat] = feature.geometry.coordinates
	const { display_name, score, score_unmeasured, collection_id, place_id, placetype } = feature.properties
	const scoreText = score == null ? `score null (${score_unmeasured ?? "unmeasured"})` : `score ${score}`
	const identity = [placetype, place_id].filter((part): part is string => typeof part === "string")

	const meta = [collection_id, ...identity, `${lat}, ${lon}`, scoreText].map(escapeHTML).join(" &middot; ")

	return `<li>${escapeHTML(display_name)} <span class="meta">${meta}</span></li>`
}

/**
 * The search form, with the results of a search when `body` holds one.
 *
 * @param collections The collections a checkbox can restrict the search to.
 */
export function searchHTML(
	body: OGCSearchResponse | null,
	links: readonly OGCLink[],
	collections: readonly OGCServedCollection[],
	q = ""
): string {
	const boxes = collections.map(
		({ id }) =>
			`<label><input type="checkbox" name="${escapeHTML(collectionVersionParameter(id))}" value="${OGC_COLLECTION_VERSION}"> ${escapeHTML(id)}</label>`
	)

	const results = body
		? `<h2>Results</h2>
<p class="meta">${body.numberReturned} returned at ${escapeHTML(body.timeStamp)}</p>
<ol>
${body.features.map(searchFeatureItem).join("\n")}
</ol>`
		: ""

	return page(
		"Search",
		`<h1>Search</h1>
<p>Forward geocoding. Leave every collection unchecked to search them all.</p>
<form method="get" action="search">
<input type="hidden" name="f" value="html">
<p><input type="search" name="q" value="${escapeHTML(q)}" required size="48" aria-label="Address or place"> <button type="submit">Search</button></p>
<p>${boxes.join(" ")}</p>
</form>
${results}
<h2>Links</h2>
${linkList(links)}`
	)
}

interface OperationLike {
	summary?: string
	description?: string
	parameters?: Array<{ name?: string; in?: string; description?: string; required?: boolean }>
	responses?: Record<string, { description?: string; content?: Record<string, unknown> }>
}

function operationHTML(method: string, path: string, operation: OperationLike): string {
	const parameters = (operation.parameters ?? []).map((parameter) => {
		const required = parameter.required ? " (required)" : ""
		const description = parameter.description ? `: ${escapeHTML(parameter.description)}` : ""

		return `<li><code>${escapeHTML(parameter.name ?? "")}</code> in ${escapeHTML(parameter.in ?? "")}${required}${description}</li>`
	})

	const responses = Object.entries(operation.responses ?? {}).map(([status, response]) => {
		const mediaTypes = Object.keys(response.content ?? {}).map((type) => `<code>${escapeHTML(type)}</code>`)

		return `<li><code>${escapeHTML(status)}</code> ${escapeHTML(response.description ?? "")} ${mediaTypes.join(", ")}</li>`
	})

	return `<h2><code>${escapeHTML(method.toUpperCase())} ${escapeHTML(path)}</code></h2>
<p>${escapeHTML(operation.summary ?? "")}</p>
${operation.description ? `<p>${escapeHTML(operation.description)}</p>` : ""}
<p>Parameters:</p>
<ul>
${parameters.join("\n")}
</ul>
<p>Responses:</p>
<ul>
${responses.join("\n")}
</ul>`
}

/**
 * The API definition as HTML: each operation with its parameters and responses,
 * read from the OpenAPI 3.0 document the JSON encoding serves.
 */
export function apiDefinitionHTML(document: OpenAPI30Document, links: readonly OGCLink[]): string {
	const operations: string[] = []

	for (const [path, item] of Object.entries(document.paths ?? {})) {
		for (const [method, operation] of Object.entries(item as Record<string, OperationLike>)) {
			operations.push(operationHTML(method, path, operation))
		}
	}

	return page(
		`${document.info.title} API definition`,
		`<h1>${escapeHTML(document.info.title)} API definition</h1>
<p>${escapeHTML(document.info.description ?? "")}</p>
<p class="meta">OpenAPI ${escapeHTML(document.openapi)}, version ${escapeHTML(document.info.version)}</p>
${linkList(links)}
${operations.join("\n")}`
	)
}
