export async function newestConfig(dir: string): Promise<string | undefined> {
	const { existsSync, readdirSync, statSync } = await import("@mailwoman/platform/fs")

	if (!existsSync(dir)) return undefined

	return readdirSync(dir)
		.map((name) => ({ name, at: statSync(`${dir}/${name}`).mtimeMs }))
		.toSorted((a, b) => b.at - a.at)
		.at(0)?.name
}
