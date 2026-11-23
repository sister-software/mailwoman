// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Returns the directory where `gazetteer overture-ingest` stores files derived from an Overture release.
 */

import { assertVintage, dataRootPath } from "@mailwoman/core/data-root"
import type { PathBuilder } from "path-ts"

/**
 * A path under one release's derived Overture files, `$MAILWOMAN_DATA_ROOT/corpus/staging/overture/<release>/`.
 *
 * `gazetteer overture-ingest` writes the per-country corpus JSONL this package's `overture` adapter
 * reads, `overture-<cc>.corpus.jsonl`, and the fill-rate report, `fill-rates.{json,md}`, here.
 * They're computed from the release's snapshot, `snapshotSourcePath("overture", release)`,
 * which holds only the Parquet copies the ingest fetched.
 *
 * @throws When `release` isn't one path segment a vintage can take.
 */
export function overtureStagingPath(release: string, ...segments: string[]): PathBuilder {
	assertVintage(release)

	return dataRootPath("corpus", "staging", "overture", release, ...segments)
}
