#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman-ogc` boots the OGC API surface through the `serve` command
 *   and prints its API definition through the `openapi` command.
 *
 *   The OGC API Common resources this stage serves read no gazetteer,
 *   so `serve` starts without a data root.
 */

import { serveNode } from "@mailwoman/api-kit"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { corsBannerLine, openAPICommand, runDropInCLI } from "mailwoman/cli/kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli/kit/engine-stamp"

import { createOGCApp, OGC_DEFAULT_PORT, OGC_DOC_INFO } from "#index"

const BINARY_NAME = "mailwoman-ogc"

async function serve(engineStamp: ResolvedEngineStamp): Promise<void> {
	const { values } = parseArguments({
		options: {
			port: { type: "string", default: String(OGC_DEFAULT_PORT) },
			host: { type: "string", default: "0.0.0.0" },
			// The public base URL that link hrefs resolve against, for a deployment behind a reverse proxy.
			"base-url": { type: "string" },
			// Permissive CORS is on by default because OGC API clients run in browsers too.
			// `--no-cors` turns it off where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
		allowPositionals: true,
	})

	const port = Number(values.port) || OGC_DEFAULT_PORT
	const host = values.host ?? "0.0.0.0"
	const baseURL = values["base-url"]

	const app = createOGCApp({ cors: values.cors, engine: engineStamp.stamp, baseURL })

	await serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: () => {
			console.error(`[@mailwoman/ogc] listening on http://${host}:${port}`)
			console.error(`  base URL: ${baseURL ?? "(the request's own origin)"}`)
			console.error(corsBannerLine(values.cors))
			console.error(`  endpoints: GET /  GET /conformance  GET /api  GET /openapi.json`)
		},
	})
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi: openAPICommand(BINARY_NAME, () => createOGCApp(), OGC_DOC_INFO, null),
	serve,
	usage: [
		"  serve [--port 8090] [--host 0.0.0.0] [--base-url <url>] [--no-cors]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
