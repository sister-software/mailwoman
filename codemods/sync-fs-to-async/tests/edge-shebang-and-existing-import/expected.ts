#!/usr/bin/env node
/**
 * @copyright Sister Software
 */

import { makeDirectories, makeDirectoryExclusive, removePath } from "@mailwoman/core/fs/writers"


export async function claim(lock: string, out: string): Promise<void> {
	await makeDirectories(out)
	await makeDirectoryExclusive(lock)
	await removePath(lock)
}
