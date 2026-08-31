/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs"

function readBanner(path: string): string {
	return readFileSync(path, "utf8")
}

// Called at module scope. Top-level `await` is legal, but it moves the read to import time, which is a decision.
export const BANNER = readBanner("banner.txt")

function present(path: string): boolean {
	return existsSync(path)
}

// Passed as a VALUE, not called. Making it async changes what `.map` produces.
export async function survivors(paths: string[]): Promise<boolean[]> {
	return paths.map(present)
}
