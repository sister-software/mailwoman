import { readLocalTextFile } from "@mailwoman/core/fs/readers"

async function readConfig(path: string): Promise<string> {
	return await readLocalTextFile(path)
}

async function describeConfig(path: string): Promise<number> {
	return (await readConfig(path)).length
}

export async function report(path: string): Promise<number> {
	return await describeConfig(path)
}
