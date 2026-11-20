// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The license and source links of a collection, read from the manifests of its layers.
 *
 *   Each identifier in a layer's license expression whose text has a known URL becomes a
 *   `license` link (RFC 4946: "Refers to a license associated with this context").
 *   Each source the manifest records with a known location becomes a `via` link
 *   (the RFC 4287 relation for the source of the information in the link's context).
 *
 *   A source that matches another opened layer, as the candidate gazetteer's manifest
 *   records the admin gazetteer, resolves to that layer's own sources.
 *   A license that requires credit adds an `attribution`, the member OGC API Common Part
 *   2 gives a collection for "a short attribution for data being visualized".
 *
 *   A manifest field without a value, and a value without a known URL,
 *   adds a sentence to the description rather than a link.
 */

import { LicenseObligation, licenseIdentifiers, summarizeLicense } from "@mailwoman/core/license/obligations"
import { licenseTextURL } from "@mailwoman/core/license/text-url"
import { isPresent } from "@mailwoman/core/objects"
import { gazetteerSourceLocation, manifestSourceNames } from "@mailwoman/resolver-wof-sqlite/sources"

import type { OGCLayerTerms, OGCServedCollection } from "#engine"
import { OGCLinkRelation, OGCMediaType, type OGCLink } from "#schema"

/**
 * The links, attribution and description sentences a collection's layers contribute.
 */
export interface OGCCollectionTerms {
	links: OGCLink[]
	/**
	 * The credit a client shows beside the data, present when a layer's license requires attribution.
	 */
	attribution?: string
	/**
	 * Sentences for the description, each one stating a manifest field the links couldn't come from.
	 */
	notes: string[]
}

/**
 * The license and source links of `served`, from its own layers' manifests.
 *
 * @param knownLayers Every layer the engine opened, so a source that matches a
 * layer resolves to that layer's sources.
 */
export function collectionTerms(
	served: OGCServedCollection,
	knownLayers: readonly OGCLayerTerms[]
): OGCCollectionTerms {
	if (!served.layers) {
		return {
			links: [],
			notes: ["The server read no layer manifest for this collection, so it links no license or source."],
		}
	}

	const links: OGCLink[] = []
	const notes: string[] = []
	const credits: string[] = []
	const hrefs = new Set<string>()
	let attributionRequired = false

	const push = (link: OGCLink) => {
		if (hrefs.has(`${link.rel} ${link.href}`)) return

		hrefs.add(`${link.rel} ${link.href}`)
		links.push(link)
	}

	const addSources = (layer: OGCLayerTerms, visited: Set<string>) => {
		if (!layer.source) {
			notes.push(`The ${layer.name} layer records no source.`)

			return
		}

		for (const name of manifestSourceNames(layer.source)) {
			const location = gazetteerSourceLocation(name)
			const upstream = knownLayers.find((known) => known.name === name)

			if (location) {
				push({ href: location.url, rel: OGCLinkRelation.Via, type: OGCMediaType.HTML, title: location.title })

				if (!credits.includes(location.title)) {
					credits.push(location.title)
				}
			} else if (upstream && !visited.has(upstream.name)) {
				visited.add(upstream.name)
				addSources(upstream, visited)
			} else {
				notes.push(`The ${layer.name} layer records the source ${name}, whose location the server doesn't know.`)
			}
		}
	}

	for (const layer of served.layers) {
		if (!layer.license) {
			notes.push(`The ${layer.name} layer records no license.`)
		} else {
			if (summarizeLicense(layer.license).obligations.includes(LicenseObligation.Attribution)) {
				attributionRequired = true
			}

			for (const identifier of licenseIdentifiers(layer.license)) {
				const href = licenseTextURL(identifier)

				if (href) {
					push({ href, rel: OGCLinkRelation.License, type: OGCMediaType.HTML, title: identifier })
				} else {
					notes.push(`The ${layer.name} layer's license ${identifier} has no published text the server links.`)
				}
			}
		}

		addSources(layer, new Set([layer.name]))
	}

	if (!attributionRequired) return { links, notes }

	// A layer whose sources have no known location contributes its own recorded credit.
	const credit = credits.length
		? credits.join(", ")
		: served.layers
				.map(({ attribution }) => attribution)
				.filter(isPresent)
				.join("; ")

	return credit ? { links, notes, attribution: credit } : { links, notes }
}
