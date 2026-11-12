// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Downloads the open profile's sources into `$MAILWOMAN_CACHE_ROOT/sources/registry/`
 *   and checks them against `data/manifests/sources.lock.json`.
 *
 *   Usage: `node packages/registry/sdk/fetch.run.ts [--repin]`
 *
 *   `--repin` rewrites the lock from the downloaded bytes.
 *   Without it, a changed publication fails the run.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { retrieveRegistrySources } from "#sdk/fetch"

const { values } = parseArguments({ options: { repin: { type: "boolean", default: false } } })

const lock = await retrieveRegistrySources({ repin: values.repin })

for (const [id, entry] of Object.entries(lock.sources)) {
	console.log(`${id}\t${entry.bytes} bytes\tsha256 ${entry.sha256}\tpublication ${entry.publication}`)
}
