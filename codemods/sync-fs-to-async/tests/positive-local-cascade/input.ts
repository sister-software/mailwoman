/// <reference types="node" />

import { readFileSync } from "node:fs"

function readConfig(path: string): string {
	return readFileSync(path, "utf8")
}

function describeConfig(path: string): number {
	return readConfig(path).length
}

export async function report(path: string): Promise<number> {
	return describeConfig(path)
}
