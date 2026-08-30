#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { makeDirectories, makeDirectoryExclusive, removePath } from "@mailwoman/core/fs/writers"


export async function claim(lock: string, out: string): Promise<void> {
	await makeDirectories(out)
	await makeDirectoryExclusive(lock)
	await removePath(lock)
}
