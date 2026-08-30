#!/usr/bin/env node
/**
 * @copyright Sister Software
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { mkdirSync, rmSync } from "@mailwoman/platform/fs"

export async function claim(lock: string, out: string): Promise<void> {
	await makeDirectories(out)
	mkdirSync(lock)
	rmSync(lock, { recursive: true })
}
