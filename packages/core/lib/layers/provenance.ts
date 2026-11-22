// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The license links, source links and credit that a set of layer manifests records.
 *
 *   Each identifier in a layer's license expression whose text has a known URL becomes a
 *   license link. Each source the manifest records with a known location becomes a source link.
 *
 *   A source that matches another known layer, as the candidate gazetteer's manifest records
 *   the admin gazetteer, contributes that layer as a whole: its license links, its sources and
 *   its credit, so a reader that credits a source links its license too.
 *
 *   The OGC adapter turns the result into collection links, and `mailwoman data inventory`
 *   prints it for each database under a data root. Both read it from this one function.
 */

import { LicenseObligation, licenseIdentifiers, summarizeLicense } from "@mailwoman/license/obligations"

import { manifestSourceNames } from "#layers/manifest"
import { licenseTextURL } from "#license/text-url"
import type { SourceLocation } from "#resolver/region-database-provider"

/**
 * The terms one layer records in its `layer_manifest`.
 */
export interface LayerTerms {
	/**
	 * The layer's name as its manifest records it, such as `admin-global-priority`.
	 */
	name: string
	/**
	 * The SPDX expression the manifest records, or null when it records none.
	 */
	license: string | null
	/**
	 * The manifest's `attribution`, or null when it records none.
	 */
	attribution: string | null
	/**
	 * The manifest's `source`, such as `whosonfirst+overture-divisions+geonames`,
	 * or null when it records none.
	 */
	source: string | null
	/**
	 * Where a user obtains each source, as the layer's provider records it.
	 *
	 * A source missing here falls back to the caller's locator.
	 */
	sourceLocations?: Readonly<Record<string, SourceLocation>>
}

/**
 * Where a user obtains a source, by the name a manifest's `source` gives it, or null when unknown.
 */
export type SourceLocator = (name: string) => SourceLocation | null

/**
 * What a provenance link points to.
 */
export const ProvenanceLinkKind = {
	/**
	 * The text of a license identifier.
	 */
	License: "license",
	/**
	 * The place a user obtains a source.
	 */
	Source: "source",
} as const

export type ProvenanceLinkKind = (typeof ProvenanceLinkKind)[keyof typeof ProvenanceLinkKind]

/**
 * One license or source link.
 */
export interface ProvenanceLink {
	kind: ProvenanceLinkKind
	href: string
	/**
	 * The license identifier, or the source's title.
	 */
	title: string
}

/**
 * One source name a layer records, and how it was resolved.
 */
export interface ResolvedLayerSource {
	/**
	 * The bare name, as {@linkcode manifestSourceNames} reads it.
	 */
	name: string
	/**
	 * Where a user obtains it, or null when neither the layer nor the locator knows.
	 */
	location: SourceLocation | null
	/**
	 * The known layer the name matched, when it has no location of its own.
	 *
	 * That layer's licenses and sources then contribute to the result.
	 */
	upstream: string | null
}

/**
 * The provenance a set of layers records.
 */
export interface LayerProvenance {
	/**
	 * Each license and source link once, in the order the layers record them.
	 */
	links: ProvenanceLink[]
	/**
	 * Each source name once, from the given layers and every upstream layer they reach.
	 */
	sources: ResolvedLayerSource[]
	/**
	 * The credit lines, each once: the manifest's own attribution for a layer of one
	 * located source or of unlocated sources, else each located source's title.
	 */
	credits: string[]
	/**
	 * Whether the obligations of any license reached include attribution.
	 */
	attributionRequired: boolean
	/**
	 * The count of layers that record no license.
	 */
	withoutLicense: number
	/**
	 * The count of layers that record no source.
	 */
	withoutSource: number
	/**
	 * License identifiers without a known text URL.
	 */
	unlinkedLicenses: string[]
	/**
	 * Source names with neither a location nor a matching known layer.
	 */
	unlocatedSources: string[]
}

/**
 * The license and source links that `layers` record.
 *
 * @param options.knownLayers Every layer the caller read, so a source that
 * matches a layer resolves to that layer.
 * @param options.locate Where a source missing from a layer's own `sourceLocations` is obtained.
 */
export function resolveLayerTerms(
	layers: readonly LayerTerms[],
	options: { knownLayers?: readonly LayerTerms[]; locate?: SourceLocator } = {}
): LayerProvenance {
	const knownLayers = options.knownLayers ?? layers
	const locate = options.locate ?? (() => null)
	const links: ProvenanceLink[] = []
	const sources = new Map<string, ResolvedLayerSource>()
	const credits: string[] = []
	const hrefs = new Set<string>()
	const unlinkedLicenses = new Set<string>()
	const unlocatedSources = new Set<string>()
	let withoutLicense = 0
	let withoutSource = 0
	let attributionRequired = false

	const push = (link: ProvenanceLink) => {
		if (hrefs.has(`${link.kind} ${link.href}`)) return

		hrefs.add(`${link.kind} ${link.href}`)
		links.push(link)
	}

	const credit = (text: string | null) => {
		if (text && !credits.includes(text)) {
			credits.push(text)
		}
	}

	const addLayer = (layer: LayerTerms, visited: Set<string>) => {
		if (!layer.license) {
			withoutLicense++
		} else {
			if (summarizeLicense(layer.license).obligations.includes(LicenseObligation.Attribution)) {
				attributionRequired = true
			}

			for (const identifier of licenseIdentifiers(layer.license)) {
				const href = licenseTextURL(identifier)

				if (href) {
					push({ kind: ProvenanceLinkKind.License, href, title: identifier })
				} else {
					unlinkedLicenses.add(identifier)
				}
			}
		}

		if (!layer.source) {
			withoutSource++
			credit(layer.attribution)

			return
		}

		const names = manifestSourceNames(layer.source)

		for (const name of names) {
			const location = layer.sourceLocations?.[name] ?? locate(name)
			const upstream = knownLayers.find((known) => known.name === name)

			if (!sources.has(name)) {
				sources.set(name, { name, location, upstream: !location && upstream ? upstream.name : null })
			}

			if (location) {
				push({ kind: ProvenanceLinkKind.Source, href: location.url, title: location.title })
				// A layer of one source records that source's own credit line, so it's credited in the publisher's words.
				credit(names.length === 1 && layer.attribution ? layer.attribution : location.title)
			} else if (upstream && !visited.has(upstream.name)) {
				visited.add(upstream.name)
				addLayer(upstream, visited)
			} else if (!upstream) {
				unlocatedSources.add(name)
				// A source without a location is credited through the layer's own recorded attribution.
				credit(layer.attribution)
			}
		}
	}

	for (const layer of layers) {
		addLayer(layer, new Set([layer.name]))
	}

	return {
		links,
		sources: [...sources.values()],
		credits,
		attributionRequired,
		withoutLicense,
		withoutSource,
		unlinkedLicenses: [...unlinkedLicenses],
		unlocatedSources: [...unlocatedSources],
	}
}
