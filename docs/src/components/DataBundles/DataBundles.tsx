/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The published-bundle tables on `/docs/product/data-products`, rendered from the `runtime-assets` plugin's global
 *   data rather than typed into the page. The first table is the registry's own figures, with each size summed from
 *   the bundle's artifacts. The second is the committed snapshot of what the bucket serves, dated, so a reader can
 *   see how old the measurement is. `BundleSize` and `BundleFileCount` render one bundle's figure inline for the prose
 *   around the tables.
 *
 *   A page that asks for a bundle absent from the registry fails the build here rather than rendering a blank.
 *
 *   Usage in MDX:
 *
 *   ```mdx
 *   import { BundleFileCount, BundleSize, DataBundlesTable, ServedBundlesTable } from "#components/DataBundles/DataBundles"
 *
 *   <DataBundlesTable />
 *   ```
 */

import { usePluginData } from "@docusaurus/useGlobalData"
import type { PublishedBundleSummary, RuntimeAssetsGlobalData } from "@site/plugins/runtime-assets/bundles.ts"
import type React from "react"

const PLUGIN_NAME = "runtime-assets"

function useRuntimeAssets(): RuntimeAssetsGlobalData {
	return usePluginData(PLUGIN_NAME) as RuntimeAssetsGlobalData
}

function findBundle(data: RuntimeAssetsGlobalData, name: string): PublishedBundleSummary {
	const bundle = data.bundles.find((candidate) => candidate.name === name)

	if (!bundle) {
		const known = data.bundles.map((candidate) => candidate.name).join(", ")

		throw new Error(`No bundle named ${name} in BUNDLES. The registry holds: ${known}`)
	}

	return bundle
}

/**
 * The registry table: name, size summed from the artifacts, file count and the registry's description.
 */
export const DataBundlesTable: React.FC = () => {
	const data = useRuntimeAssets()

	return (
		<table>
			<thead>
				<tr>
					<th>Bundle</th>
					<th>Size</th>
					<th>Files</th>
					<th>What it covers</th>
				</tr>
			</thead>
			<tbody>
				{data.bundles.map((bundle) => (
					<tr key={bundle.name}>
						<td>
							<code>{bundle.name}</code>
						</td>
						<td>{bundle.totalSize}</td>
						<td>{bundle.artifactCount}</td>
						<td>{bundle.description}</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

function servedCell(bundle: PublishedBundleSummary): string {
	if (!bundle.served) return "not in the snapshot"

	if (bundle.served.servedSize === null) {
		return `unmeasured for ${bundle.served.sizesUnmeasured} of ${bundle.artifactCount} files`
	}

	return bundle.served.servedSize
}

function manifestCell(bundle: PublishedBundleSummary, values: string[]): string {
	if (!bundle.served) return "not in the snapshot"

	if (bundle.served.manifestsMeasured === 0) {
		return `unmeasured for ${bundle.served.manifestsUnmeasured} of ${bundle.artifactCount} files`
	}

	const measured = values.length ? values.join(", ") : "none recorded"

	return bundle.served.manifestsUnmeasured
		? `${measured} (${bundle.served.manifestsUnmeasured} of ${bundle.artifactCount} files unmeasured)`
		: measured
}

function databaseLicenseCell(bundle: PublishedBundleSummary): string {
	if (!bundle.served) return "not in the snapshot"

	return bundle.served.databaseLicense ?? "unmeasured"
}

/**
 * The snapshot table: what the bucket served on the date the writer ran, per bundle.
 *
 * Tier and expression come from each artifact's own `layer_manifest`, which only a host holding the
 * published file can read, so a bundle no snapshot host held reads as unmeasured rather than as a tier.
 */
export const ServedBundlesTable: React.FC = () => {
	const data = useRuntimeAssets()
	const date = data.measuredAt.slice(0, 10)

	return (
		<>
			<table>
				<thead>
					<tr>
						<th>Bundle</th>
						<th>Served</th>
						<th>Tier</th>
						<th>Database license</th>
						<th>Artifact's own expression</th>
					</tr>
				</thead>
				<tbody>
					{data.bundles.map((bundle) => (
						<tr key={bundle.name}>
							<td>
								<code>{bundle.name}</code>
							</td>
							<td>{servedCell(bundle)}</td>
							<td>{manifestCell(bundle, bundle.served?.tiers ?? [])}</td>
							<td>{databaseLicenseCell(bundle)}</td>
							<td>{manifestCell(bundle, bundle.served?.expressions ?? [])}</td>
						</tr>
					))}
				</tbody>
			</table>
			<p>
				Measured <time dateTime={data.measuredAt}>{date}</time> against <code>{data.bucket}</code>. Served is the{" "}
				<code>content-length</code> the bucket reported. Tier and expression are read from each artifact&apos;s own{" "}
				<code>layer_manifest</code> on a host holding the published file, and unmeasured means no such host ran the
				snapshot. The database license is the license on the database as a whole, which ODbL grants separately from
				rights in the contents, and it is unmeasured until an artifact records one.
			</p>
		</>
	)
}

/**
 * The rights table on `/license`: who published each bundle's rows, the SPDX expression
 * this repository records for it, along with the terms each publisher uses.
 *
 * The page previously included these three columns as hand-typed markdown.
 * The registry is the source for each publisher and license expression.
 *
 * `mailwoman data bom` serializes that record for each artifact.
 */
export const BundleRightsTable: React.FC = () => {
	const data = useRuntimeAssets()

	return (
		<table>
			<thead>
				<tr>
					<th>Bundle</th>
					<th>Published by</th>
					<th>Expression</th>
					<th>Terms as the publisher names them</th>
				</tr>
			</thead>
			<tbody>
				{data.bundles.map((bundle) => (
					<tr key={bundle.name}>
						<td>
							<code>{bundle.name}</code>
						</td>
						<td>{bundle.rights.publishers.join("; ")}</td>
						<td>
							<code>{bundle.rights.expression}</code>
						</td>
						<td>{bundle.rights.terms.join(" ")}</td>
					</tr>
				))}
			</tbody>
		</table>
	)
}

/**
 * The obligations each bundle places on an operator and any obligation without an assessment.
 *
 * `mailwoman data pull` prints the same two lists before any bytes move.
 */
export const BundleObligationsList: React.FC = () => {
	const data = useRuntimeAssets()

	return (
		<>
			{data.bundles.map((bundle) => (
				<div key={bundle.name}>
					<h4>
						<code>{bundle.name}</code>
					</h4>
					<p>You must:</p>
					<ul>
						{bundle.rights.conditions.map((condition) => (
							<li key={condition}>{condition}</li>
						))}
					</ul>
					<p>Unresolved:</p>
					<ul>
						{bundle.rights.unresolved.map((question) => (
							<li key={question}>{question}</li>
						))}
					</ul>
				</div>
			))}
		</>
	)
}

/**
 * One bundle's summed size, inline.
 */
export const BundleSize: React.FC<{ name: string }> = ({ name }) => {
	const bundle = findBundle(useRuntimeAssets(), name)

	return <>{bundle.totalSize}</>
}

/**
 * One bundle's file count, inline.
 */
export const BundleFileCount: React.FC<{ name: string }> = ({ name }) => {
	const bundle = findBundle(useRuntimeAssets(), name)

	return <>{bundle.artifactCount}</>
}
