import { pathExists, readDirectory } from "@mailwoman/core/fs/readers"

export async function newestConfig(dir: string): Promise<string | undefined> {
	const { statSync } = await import("node:fs")

	if (!(await pathExists(dir))) return undefined

	return (await readDirectory(dir))
		.map((name) => ({ name, at: statSync(`${dir}/${name}`).mtimeMs }))
		.toSorted((a, b) => b.at - a.at)
		.at(0)?.name
}
