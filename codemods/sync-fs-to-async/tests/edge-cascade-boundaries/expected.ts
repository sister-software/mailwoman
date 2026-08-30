import { readDirectory } from "@mailwoman/core/fs/readers"

import { readFileSync } from "@mailwoman/platform/fs"

interface Engine {
	read(): string
}

const STDIN = 0

// A recursive walk: the recursive call needs the await too.
async function walk(dir: string): Promise<string[]> {
	const out: string[] = []

	for (const entry of await readDirectory(dir)) {
		out.push(...(await walk(`${dir}/${entry}`)))
	}

	return out
}

// An annotated binding states a synchronous contract this codemod does not own.
const read: Engine["read"] = () => readFileSync("a", "utf8")

// A file DESCRIPTOR, not a path. No helper takes one.
export async function fromStdin(): Promise<string> {
	return readFileSync(0, "utf8") + String(STDIN)
}

export async function run(dir: string): Promise<number> {
	return (await walk(dir)).length + read().length
}
