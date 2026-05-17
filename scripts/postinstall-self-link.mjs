// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const nodeModules = resolve(repoRoot, "node_modules")
const link = resolve(nodeModules, "mailwoman")

if (!existsSync(nodeModules)) mkdirSync(nodeModules, { recursive: true })

if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
	const stat = lstatSync(link)
	if (stat.isSymbolicLink() && resolve(nodeModules, readlinkSync(link)) === repoRoot) {
		process.exit(0)
	}
	rmSync(link, { recursive: true, force: true })
}

symlinkSync("..", link, "dir")
