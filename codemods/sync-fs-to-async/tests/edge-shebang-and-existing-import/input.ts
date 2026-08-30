#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { mkdirSync, rmSync } from "@mailwoman/platform/fs"

export async function claim(lock: string, out: string): Promise<void> {
	await makeDirectories(out)
	mkdirSync(lock)
	rmSync(lock, { recursive: true })
}
