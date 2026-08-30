import { pathExists, readLocalTextFile, statPath } from "@mailwoman/core/fs/readers"
import { makeDirectories, makeDirectoryExclusive, removePathIfPresent, writeLocalFile, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"

export async function build(root: string, bytes: Uint8Array): Promise<number> {
	if (!(await pathExists(root))) await makeDirectories(root)

	await makeDirectoryExclusive(`${root}/lock`)
	await writeLocalTextFile("hello", `${root}/name.txt`)
	await writeLocalFile(bytes, `${root}/blob.bin`)
	await writeLocalJSONFile({ ok: true }, `${root}/meta.json`)
	await removePathIfPresent(`${root}/stale`)

	const text = await readLocalTextFile(`${root}/name.txt`)

	return text.length + (await statPath(root)).size
}
