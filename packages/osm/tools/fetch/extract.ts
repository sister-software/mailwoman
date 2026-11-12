// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Download Geofabrik extracts as dated snapshots and write a receipt beside each.
 *
 *   The vintage is the UTC date of the server's `Last-Modified` header, and each
 *   region keeps its own vintages: `europe/germany` served on 2026-10-17 lands at
 *   `$MAILWOMAN_DATA_ROOT/snapshots/geofabrik/europe/germany/2026-10-17/germany.osm.pbf`,
 *   with `germany.osm.pbf.receipt.json` beside it.
 *   The download goes to a staging directory beside the vintage.
 *
 *   The staging directory moves into place once the file and its receipt are written.
 *
 *   A vintage on disk is kept, and the region is skipped before any transfer.
 *   To replace one, state it with `--vintage` and pass `--force`.
 *
 *   A `--vintage` that differs from the date Geofabrik serves is refused,
 *   because the file would be misdated.
 *
 *   `--out-root` replaces the snapshot root, so a vintage lands
 *   at `<out-root>/geofabrik/<region>/<vintage>/`.
 *
 *   Usage:
 *     node packages/osm/tools/fetch/extract.ts --region russia --region asia/china
 */

import { assertVintage, snapshotSourcesRoot } from "@mailwoman/core/data-root"
import { SnapshotExistsError, assertSnapshotWritable, writeSnapshot } from "@mailwoman/core/fs/snapshot"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder } from "path-ts"

import { geofabrikExtractFileName, geofabrikExtractPath, geofabrikSnapshotDirectory } from "#paths"
import { extractReceiptPath } from "#sdk/extract/receipt"
import { downloadExtract, geofabrikURL } from "#sdk/fetch"
import { geofabrikVintage } from "#sdk/geofabrik/snapshot"

const { values } = parseArguments({
	options: {
		region: { type: "string", multiple: true },
		"out-root": { type: "string" },
		vintage: { type: "string" },
		force: { type: "boolean" },
	},
})

const regions = values.region ?? []

if (!regions.length) {
	throw new Error(
		"usage: fetch-extract --region <geofabrik/path> [--region …] [--out-root <dir>] [--vintage <YYYY-MM-DD> --force]"
	)
}

const stated = values.vintage || null

if (stated != null) {
	assertVintage(stated)
}

const snapshotRoot = values["out-root"] ? PathBuilder.from(values["out-root"]) : snapshotSourcesRoot()
const writeOptions = { vintageFromCaller: stated != null, force: values.force ?? false }

for (const region of regions) {
	const head = await fetch(geofabrikURL(region), { method: "HEAD" })

	if (!head.ok) throw new Error(`Geofabrik HEAD failed (${head.status}) for ${region}`)

	const modified = head.headers.get("last-modified")

	if (!modified) throw new Error(`Geofabrik sent no Last-Modified for ${region}; the file cannot be dated`)

	const vintage = geofabrikVintage(modified)

	if (stated != null && stated !== vintage) {
		throw new Error(`${region}: Geofabrik serves vintage ${vintage} (${modified}), not the --vintage ${stated} given`)
	}

	const destination = geofabrikExtractPath(region, vintage, snapshotRoot)
	const vintageDirectory = geofabrikSnapshotDirectory(region, snapshotRoot)(vintage)

	try {
		// Checked before the transfer, so a kept vintage costs no download.
		await assertSnapshotWritable(vintageDirectory, writeOptions)
	} catch (error) {
		if (!(error instanceof SnapshotExistsError)) throw error

		console.log(`[osm] ${region} vintage ${vintage} is on disk at ${vintageDirectory}; kept`)

		continue
	}

	console.log(`[osm] ${region} → ${destination} (${head.headers.get("content-length")} bytes, ${modified})`)

	await writeSnapshot(vintageDirectory, writeOptions, async (staging) => {
		const staged = PathBuilder.from(staging)(geofabrikExtractFileName(region))
		const receipt = await downloadExtract(region, staged.toString())

		// Geofabrik can publish a new file between the HEAD and the download.
		if (receipt.last_modified && geofabrikVintage(receipt.last_modified) !== vintage) {
			throw new Error(
				`${region}: the download is dated ${receipt.last_modified}, and the HEAD dated it ${modified}; fetch again`
			)
		}

		await writeLocalJSONFile(receipt, extractReceiptPath(staged))

		console.log(`[osm] ${destination}: ${receipt.bytes} bytes, sha256 ${receipt.sha256}`)
	})
}
