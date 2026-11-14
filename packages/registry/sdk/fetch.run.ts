// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Downloads the open profile's sources into `$MAILWOMAN_CACHE_ROOT/sources/registry/`
 *   and checks them against `data/manifests/sources.lock.json`.
 *
 *   Usage: `node packages/registry/sdk/fetch.run.ts [--repin] [--only <source-id>]...`
 *
 *   `--repin` rewrites the lock from the downloaded bytes.
 *   Without it, a changed publication fails the run.
 *
 *   `--only` downloads the sources whose ids it lists and leaves every other locked entry unchanged.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { retrieveRegistrySources } from "#sdk/fetch"
import { SOURCE_IDS, type SourceID } from "#sdk/sources"

const { values } = parseArguments({
	options: {
		repin: { type: "boolean", default: false },
		only: { type: "string", multiple: true },
	},
})

const only = values.only?.map((id): SourceID => {
	if (!(SOURCE_IDS as readonly string[]).includes(id)) {
		throw new Error(`--only ${id}: not a source id; the ids are ${SOURCE_IDS.join(", ")}`)
	}

	return id as SourceID
})

const lock = await retrieveRegistrySources({ repin: values.repin, only })

for (const [id, entry] of Object.entries(lock.sources)) {
	console.log(`${id}\t${entry.bytes} bytes\tsha256 ${entry.sha256}\tpublication ${entry.publication}`)
}
