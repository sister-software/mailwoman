/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Splits corpus rows into train, val and test by holding out whole places: a random row split leaks by
 * neighborhood, because the model can memorize a street it saw in train. Rows inside a held-out place
 * go to val or test 50/50 by a hash of `source_id`; every other row goes to train.
 *
 * A holdout change takes effect at the next corpus rebuild. Each versioned corpus keeps the
 * `SPLIT_MANIFEST.json` it was built with, because adding a holdout to a built corpus would leak rows
 * the model already trained on.
 */

import { delimitedSource, preferCompressed } from "@mailwoman/core/fs/delimited"
import { openWriteStream } from "@mailwoman/core/fs/streams"
import { writeLocalJSONFile, writeLocalTextFile, makeDirectories, removePath } from "@mailwoman/core/fs/writers"
import { createHash } from "@mailwoman/core/hash"
import { spawnProcess } from "@mailwoman/core/process"
import { childEnv } from "@mailwoman/core/scripting/utils"
import { foldNFKCWhitespace } from "@mailwoman/normalize/fold"
import { type PathBuilderLike, resolvePathBuilder } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { recordIDOf } from "#adapters/record-id"
import type { CanonicalRow, LabeledRow } from "#types"

/**
 * The name of one corpus split.
 */
export type SplitName = "train" | "val" | "test"

/**
 * The three splits, in the order a build writes them.
 */
export const SPLIT_NAMES: readonly SplitName[] = ["train", "val", "test"]

/**
 * The component values that identify the places one country holds out.
 *
 * Sources represent a place in different components: `usgov-nad` and `tiger` emit `region`,
 * but BAN emits none, so a French holdout must also match on postcode.
 * A row is held out when any declared matcher fires.
 * A policy with no matchers holds out no entry.
 */
export interface HoldoutPolicy {
	regions?: readonly string[]
	/**
	 * Prefixes matched against `row.components.postcode`; use one only where it identifies
	 * a single place by itself, such as the first two digits of a French postcode.
	 */
	postcodePrefixes?: readonly string[]
	localities?: readonly string[]
}

/**
 * One country's holdout as a bare region list or a {@link HoldoutPolicy}.
 *
 * Older committed `SPLIT_MANIFEST.json` files use a bare array of region values.
 */
export type CountryHoldout = readonly string[] | HoldoutPolicy

/**
 * Options for {@link splitRows}.
 */
export interface SplitOptions {
	/**
	 * The holdout policy keyed by ISO 3166-1 alpha-2 country code.
	 */
	holdouts?: Record<string, CountryHoldout>
	/**
	 * The corpus version the manifest records.
	 *
	 * @defaultValue `""`
	 */
	corpusVersion?: string
}

/**
 * The `source_id` lists for each split.
 */
export interface SplitManifest {
	train: string[]
	val: string[]
	test: string[]
	holdouts: Record<string, CountryHoldout>
	/**
	 * The corpus version the caller named.
	 */
	corpus_version: string
	counts: { train: number; val: number; test: number; total: number }
}

/**
 * Returns the default holdouts: places below the first-level region in each country,
 * keyed only by open-vocabulary values, a postcode district or a locality.
 * A change here takes effect at the next split of the corpus.
 *
 * No entry keys on a region.
 * A region's name is a region span only in rows from that region, so holding a
 * region out removes it as a label from training, and the model then relabels it
 * (#2777: v0.8.0 train held 0 region spans for VT, ND, WY, Asturias, Kerala and Cornwall).
 *
 * Holding out places inside regions takes a small part of each region it touches
 * and leaves the test split measuring unseen places under labels the model has seen.
 *
 * A selection script chose the district and locality lists below from the v0.8.0 rows of each country:
 * - Candidates are postcode districts of a fixed length (US 3, AU 3, RO 4, LV and the French
 *   overseas jurisdictions the full postcode), or, where most rows carry no postcode,
 *   localities grouped by spelling with accents and punctuation removed.
 *   A locality whose spelling matches a region surface is not a candidate.
 *   Each candidate carries at least 1% of the country's v0.8.0 held-out rows.
 * - They are walked in the order of `hashBucket(\`${country}|${candidate}\`, 2 ** 32)`
 *   and taken while the country's held-out rows stay at or under its v0.8.0 held-out rows,
 *   because a borderline row goes to training.
 *   A country whose candidates under that bound number fewer than two takes its smallest
 *   candidates up to two, so its held-out set has groups to grade (YT, PF and NC).
 *   Taking also requires that every region with at least 100 rows loses at most
 *   `min(0.25, max(0.05, 3 × share))` of its rows, and of its rows with no postcode,
 *   where `share` is the country's v0.8.0 held-out share.
 * - A locality group is held out by every spelling the v0.8.0 rows write.
 * `held-out-spans.full.test.ts` checks a built corpus against this table.
 */
export function defaultHoldouts(): Record<string, CountryHoldout> {
	return {
		// FR, DE and GB keep the postcode areas of earlier corpora, so the held-out
		// rows already verified unseen stay unseen.
		// Their region names, Corse, Lozère, Creuse, Saarland, Mecklenburg-Vorpommern
		// and Cornwall, left the table.
		// FR: Corse 20, Creuse 23 and Lozère 48.
		// DE: area 02, Upper Lusatia in eastern Sachsen.
		// GB: Truro, Llandudno and Halifax.
		// Each prefix has two letters and none is a prefix of another.
		FR: { postcodePrefixes: ["20", "23", "48"] },
		DE: { postcodePrefixes: ["02"] },
		GB: { postcodePrefixes: ["TR", "LL", "HX"] },
		// Three-digit ZIP areas.
		US: {
			postcodePrefixes: [
				"084",
				"156",
				"171",
				"172",
				"223",
				"317",
				"364",
				"450",
				"664",
				"683",
				"716",
				"734",
				"759",
				"763",
				"808",
				"881",
			],
		},
		AU: {
			postcodePrefixes: [
				"080",
				"083",
				"203",
				"248",
				"366",
				"375",
				"379",
				"397",
				"406",
				"467",
				"470",
				"523",
				"607",
				"628",
				"631",
				"640",
				"651",
				"733",
			],
		},
		LV: {
			postcodePrefixes: [
				"LV-1004",
				"LV-1023",
				"LV-1029",
				"LV-1057",
				"LV-2011",
				"LV-2012",
				"LV-2016",
				"LV-2105",
				"LV-2111",
				"LV-2119",
				"LV-2161",
				"LV-3001",
				"LV-3007",
				"LV-3145",
				"LV-3284",
				"LV-3456",
				"LV-3708",
				"LV-3933",
				"LV-4033",
				"LV-4245",
				"LV-4630",
				"LV-4838",
				"LV-5022",
				"LV-5070",
				"LV-5120",
				"LV-5202",
				"LV-5413",
				"LV-5414",
				"LV-5417",
				"LV-5418",
				"LV-5422",
				"LV-5449",
				"LV-5473",
				"LV-5481",
				"LV-5664",
				"LV-5674",
			],
		},
		RO: {
			postcodePrefixes: [
				"0312",
				"0613",
				"0751",
				"1070",
				"1073",
				"1153",
				"1276",
				"1300",
				"1470",
				"2004",
				"2005",
				"2173",
				"2200",
				"2352",
				"2477",
				"3102",
				"3271",
				"4000",
				"4004",
				"4073",
				"4173",
				"4270",
				"4451",
				"5004",
				"5101",
				"5176",
				"5356",
				"5475",
				"5510",
				"5571",
				"6052",
				"6170",
				"6271",
				"7000",
				"7001",
				"7005",
				"7006",
				"7202",
				"7251",
				"7254",
				"7310",
				"7370",
				"7375",
				"8004",
				"9003",
				"9272",
			],
		},
		// Each French overseas jurisdiction's BAN rows carry a commune postcode, so these hold out communes.
		// Saint-Barthélemy and Saint-Martin are each one commune under one postcode,
		// and Saint-Pierre-et-Miquelon's Saint-Pierre holds 2,706 of its 3,084 rows,
		// so those three are left to the hashed holdout.
		GP: { postcodePrefixes: ["97113", "97125", "97126", "97128", "97136"] },
		MQ: { postcodePrefixes: ["97211", "97216", "97225", "97227", "97233"] },
		GF: {
			postcodePrefixes: ["97313", "97314", "97315", "97316", "97319", "97350", "97360", "97380", "97390"],
		},
		RE: { postcodePrefixes: ["97423", "97427", "97438", "97442", "97450"] },
		YT: { postcodePrefixes: ["97625", "97660"] },
		PF: { postcodePrefixes: ["98713", "98716"] },
		NC: { postcodePrefixes: ["98817", "98820", "98859"] },
		// The countries below carry a postcode on few rows (ES 13%, IT 6%, RU 20% and under 40% for the rest),
		// so their holdouts are localities.
		// ID's `<different>` and NG's `edo state` and `imo`, a placeholder and two state
		// names written as localities, were dropped from the selection.
		// One VN commune of Hàm Thuận was dropped too, because the repository spelling
		// check reads its last word as a typo.
		// CN and IN are left to the hashed holdout: their locality spans are a
		// million village and neighborhood names with a median of about ten rows,
		// so a declared list would need tens of thousands of entries.
		ES: {
			localities: [
				"adeje",
				"agaete",
				"agaetė",
				"aguimes",
				"agüimes",
				"alegría-dulantzi",
				"amurrio",
				"arafo",
				"arico",
				"arona",
				"fasnia",
				"granadilla de abona",
				"guia de isora",
				"guía de isora",
				"hermigua",
				"melgar de yuso",
				"mogan",
				"mogán",
				"san bartolome de tirajana",
				"san bartolomé de tirajana",
				"san miguel de abona",
				"san sebastián de la gomera",
				"santiago del teide",
				"tejeda",
				"valle gran rey",
				"vallehermoso",
			],
		},
		IT: {
			localities: [
				"arborea",
				"arbórea",
				"buggerru",
				"cabras",
				"domusnovas",
				"fluminimaggiore",
				"gonnesa",
				"guspini",
				"gùspini",
				"marrubiu",
				"marrùbiu",
				"perdaxius",
				"porto torres",
				"portoscuso",
				"portotorres",
				"san giovanni suergiu",
				"san nicolo d'arcidano",
				"san nicolo' d'arcidano",
				"san nicolò d'arcidano",
				"san nicolò d’arcidano",
				"sant'anna arresi",
				"sant'antioco",
				"santa giusta",
				"santantioco",
				"sant’anna arresi",
				"sant’antioco",
				"stintino",
				"terralba",
			],
		},
		ID: {
			localities: [
				"balikpapan",
				"bekasi",
				"blega",
				"bogor",
				"central jakarta",
				"depok",
				"east jakarta",
				"garut",
				"jakarta utara",
				"jimbaran",
				"kabupaten bandung",
				"karawang",
				"kel. karang pamulang",
				"kota bandung",
				"kota batam",
				"kota bekasi",
				"kota malang",
				"kota tangerang selatan",
				"kupang",
				"kuta",
				"lhokseumawe",
				"makassar",
				"mataram",
				"rancah",
				"salatiga",
				"samarinda",
				"sidoarjo",
				"sleman",
				"surakarta",
				"west jakarta",
			],
		},
		PK: {
			localities: ["faisal town", "gujrat", "multan", "اسلام آباد"],
		},
		VN: {
			localities: [
				"bien hoa",
				"biên hòa",
				"buon ma thuot",
				"buôn ma thuột",
				"dĩ an - bình dương",
				"ha giang",
				"ha long",
				"hà giang",
				"hạ long",
				"long xuyên",
				"mui ne",
				"móng cái",
				"mũi né",
				"mỹ tho",
				"phan rang - tháp chàm",
				"phan rang- tháp chàm",
				"phan rang-tháp chàm",
				"phường 13",
				"phường 15",
				"phường 16",
				"phường 2",
				"phường 22",
				"phường hiệp bình chánh",
				"phường hiệp thành",
				"phường hòa thạnh",
				"phường thới an",
				"phường tân quy",
				"phường tân quý",
				"phường đại mỗ",
				"pleiku",
				"q.cấu giấy",
				"q.cầu giấy",
				"sa pa",
				"saigon",
				"sapa",
				"sài gòn",
				"thành phố huế",
				"thành phố hải phòng",
				"thành phố phú quốc",
				"thành phố thái nguyên",
				"thành phố thủ dầu một",
				"thành phố vũng tàu",
				"tp. hcm",
				"tp.hồ chí minh",
				"tuy hoa",
				"tuy hoà",
				"tuy hòa",
				"tân an",
				"vinh",
				"việt trì",
				"vung tau",
				"vũng tàu",
				"xã lai vung",
				"đồng hới",
				"đồng xoài",
			],
		},
		NG: {
			localities: [
				"ibadan",
				"iiupeju",
				"ilorin",
				"isiozi-akah",
				"kabala",
				"korongilum",
				"kosofe",
				"lekki peninsula ii",
				"lokoja",
				"magodo",
				"makera",
				"mararaba",
				"nsukka",
				"ota",
				"oyo town",
				"suncity",
				"udu",
				"unec enugu",
				"zaria",
			],
		},
		BD: {
			localities: [
				", gazipur",
				",gazipur",
				"brahmanbaria",
				"chandpur",
				"chattogram",
				"chattogram (chittagong)",
				"chittagong",
				"chittagong.",
				"dhanmondi",
				"gazipur",
				"jamalpur",
				"jessore",
				"lalmatia",
				"magura",
				"mirpur 10",
				"mirpur-10",
				"mohammadpur area",
				"narsingdi",
				"paity",
				"patuakhali",
				"rajbari",
				"rajshahi",
				"ramganj",
				"rangamati",
				"sonargaon",
				"sreemangal",
				"terokhada khulna",
				"tongi",
				"uttara",
				"uttara.",
				"ডেমরা",
				"মোহাম্মদপুর",
			],
		},
		NZ: {
			localities: [
				"ashburton",
				"auckland central",
				"awarua plains",
				"bell block",
				"chartwell",
				"christchurch",
				"christchurch central",
				"conical hills",
				"dunedin",
				"east end",
				"east gore",
				"east tamaki",
				"eastern bush",
				"glengarry",
				"glenham",
				"gummies bush",
				"hamilton east",
				"hillsborough",
				"kaeo",
				"kaitaia",
				"levin",
				"lochiel",
				"manapouri",
				"masterton",
				"mataura",
				"mossburn",
				"new plymouth",
				"ngaruawahia",
				"niagara",
				"nightcaps",
				"otapiri gorge",
				"otautau",
				"papamoa",
				"papatoetoe",
				"pauanui",
				"queenstown",
				"riverton",
				"rolleston",
				"round hill",
				"south hillend",
				"southbridge",
				"stoke",
				"strathern",
				"taupo",
				"taupō",
				"the key",
				"tisbury",
				"tokoroa",
				"twizel",
				"waikiwi",
				"waipounamu",
				"waitara",
				"wallacetown",
				"wanaka",
				"waverley",
				"wellington",
				"wendon valley",
				"westport",
				"whitford",
				"wyndham",
			],
		},
		RU: {
			localities: ["алатырь", "архангельск", "валевая", "дубенки", "дубёнки", "лукьяновка", "таврово", "шадринск"],
		},
	}
}

/**
 * The component tags {@link splitForRow} reads.
 *
 * A reader that rebuilds components from spans needs only these.
 */
export const HOLDOUT_COMPONENT_TAGS: ReadonlySet<string> = new Set(["venue", "region", "postcode", "locality"])

/**
 * One place in this number is held out in a country without a {@link defaultHoldouts} entry.
 */
export const HASHED_PLACE_HOLDOUT_DIVISOR = 50

/**
 * The key a row is held out by under the hashed holdout: its venue, else its locality,
 * else the first two characters of its postcode, else its region.
 *
 * A venue name keys before its place because the venue recipes write one name both with a locality and bare.
 * A locality key would hold out the first form and train on the second.
 *
 * Returns null for a row with none of the four.
 * That row stays in train.
 */
export function hashedHoldoutPlace(
	components: Partial<Record<"venue" | "locality" | "postcode" | "region", string>>
): string | null {
	const venue = components.venue?.trim().toLowerCase()

	if (venue) return `venue:${venue}`

	const locality = components.locality?.trim().toLowerCase()

	if (locality) return `locality:${locality}`

	const postcode = components.postcode?.replaceAll(/\s+/g, "").toUpperCase()

	if (postcode && postcode.length >= 2) return `postcode:${postcode.slice(0, 2)}`

	const region = components.region?.trim().toLowerCase()

	return region ? `region:${region}` : null
}

/**
 * Returns the matchers for one country, reading a bare array as a region list.
 */
export function holdoutPolicyFor(holdout: CountryHoldout | null): HoldoutPolicy {
	if (!holdout) return {}

	return Array.isArray(holdout) ? { regions: holdout } : (holdout as HoldoutPolicy)
}

interface FoldedHoldoutNames {
	regions: ReadonlySet<string>
	localities: ReadonlySet<string>
}

const foldedNamesCache = new WeakMap<object, FoldedHoldoutNames>()

/**
 * A policy's region and locality names under `foldNFKCWhitespace`, computed once per policy object.
 *
 * Sources write one place in several cases and spacings (`Asturias`, `ASTURIAS`, `Balearic  Islands`).
 * An exact match held out one spelling and trained on the rest.
 */
function foldedNamesFor(declared: CountryHoldout, policy: HoldoutPolicy): FoldedHoldoutNames {
	const cached = foldedNamesCache.get(declared)

	if (cached) return cached

	const names: FoldedHoldoutNames = {
		regions: new Set((policy.regions ?? []).map(foldNFKCWhitespace)),
		localities: new Set((policy.localities ?? []).map(foldNFKCWhitespace)),
	}

	foldedNamesCache.set(declared, names)

	return names
}

type SplitInputRow = Pick<CanonicalRow, "source_id" | "country" | "components">

/**
 * Returns the split for one row.
 *
 * Both `splitRows` and the streaming `buildCorpus` loop call this, so every
 * caller assigns a row to the same split.
 */
export function splitForRow(
	row: Pick<SplitInputRow, "source_id" | "country" | "components">,
	holdouts: Record<string, CountryHoldout> = defaultHoldouts()
): SplitName {
	const declared = holdouts[row.country]
	const { region, postcode, locality } = row.components
	let isHeldOut: boolean

	if (declared) {
		const policy = holdoutPolicyFor(declared)
		const folded = foldedNamesFor(declared, policy)

		isHeldOut = Boolean(
			(region && folded.regions.has(foldNFKCWhitespace(region))) ||
			(postcode && (policy.postcodePrefixes?.some((prefix) => postcode.startsWith(prefix)) ?? false)) ||
			(locality && folded.localities.has(foldNFKCWhitespace(locality)))
		)
	} else {
		// A country without a declared holdout holds out whole places chosen by hash,
		// so every country in the corpus reaches val and test.
		const place = hashedHoldoutPlace(row.components)

		isHeldOut = place !== null && hashBucket(`${row.country}|${place}`, HASHED_PLACE_HOLDOUT_DIVISOR) === 0
	}

	if (!isHeldOut) return "train"

	// The bucket is the record's, so the rendered rows of one record stay together in val or test.
	return hashBucket(recordIDOf(row.source_id), 2) === 0 ? "val" : "test"
}

/**
 * Builds a `SplitManifest` in memory from labeled or canonical rows.
 *
 * Tests and small fixtures use this, while `buildCorpus` uses `splitForRow`
 * and `writeSplitManifestsFromLabeledFiles` so it never holds every row's split in memory.
 */
export function splitRows(rows: Iterable<SplitInputRow>, opts: SplitOptions = {}): SplitManifest {
	const holdouts = opts.holdouts ?? defaultHoldouts()
	const train: string[] = []
	const val: string[] = []
	const test: string[] = []

	for (const row of rows) {
		const split = splitForRow(row, holdouts)

		if (split === "train") {
			train.push(row.source_id)
		} else if (split === "val") {
			val.push(row.source_id)
		} else {
			test.push(row.source_id)
		}
	}

	const total = train.length + val.length + test.length

	return {
		train,
		val,
		test,
		holdouts,
		corpus_version: opts.corpusVersion ?? "",
		counts: { train: train.length, val: val.length, test: test.length, total },
	}
}

/**
 * Returns a deterministic bucket in `0..n-1` for an id, from the first four bytes
 * of the SHA-256 digest read as a big-endian uint32.
 */
export function hashBucket(id: string, n: number): number {
	const digest = createHash("sha256").update(id).digest()
	const u = digest[0]! * 0x01_00_00_00 + digest[1]! * 0x01_00_00 + digest[2]! * 0x01_00 + digest[3]!

	return u % n
}

/**
 * Writes a `SplitManifest` to `<outputDir>/{train,val,test}.txt` (sorted `source_id` values, one per line)
 * and `SPLIT_MANIFEST.json` (the corpus version, holdouts and counts).
 */
export async function writeSplitManifests(manifest: SplitManifest, outputDir: PathBuilderLike): Promise<void> {
	await makeDirectories(outputDir)

	for (const name of ["train", "val", "test"] as const) {
		const sorted = [...manifest[name]].toSorted()

		await writeLocalTextFile(sorted, outputDir, `${name}.txt`)
	}

	const summary = {
		corpus_version: manifest.corpus_version,
		holdouts: manifest.holdouts,
		counts: manifest.counts,
	}

	await writeLocalJSONFile(summary, outputDir, "SPLIT_MANIFEST.json")
}

/**
 * The `LabeledRow` fields that the split functions read.
 */
export type SplitInputLabeledRow = Pick<LabeledRow, "source_id" | "country" | "components">

/**
 * Writes the same files as `writeSplitManifests` from the rows' `source_id` values.
 *
 * `buildCorpus` calls this after its align loop partitions rows with `splitForRow`.
 * The caller passes the counts to avoid rescanning the files.
 * `sort(1)` spills to disk, so memory stays constant.
 *
 * Each split's ids come from the first of these the caller supplies:
 *
 * - `sortedSourceIDPaths`: lists already sorted by byte, merged by `sort -m`.
 *   A build that aligned its sources apart passes each source's sorted list.
 * - `sourceIDPaths`: one id per line in the order align wrote them, read by `sort` directly.
 * - `labeledPaths`, the labeled JSONL itself, parsed for each row's `source_id`.
 *   An align phase resumed from a checkpoint written before align recorded ids leaves only this.
 *
 * The three write the same bytes from the same rows, because each feeds `sort` the same multiset of ids.
 */
export async function writeSplitManifestsFromLabeledFiles(opts: {
	labeledPaths: Record<SplitName, PathBuilderLike>
	sourceIDPaths?: Record<SplitName, PathBuilderLike> | null
	sortedSourceIDPaths?: Record<SplitName, readonly PathBuilderLike[]> | null
	outputDir: PathBuilderLike
	corpusVersion: string
	counts: Record<SplitName, number>
	holdouts?: Record<string, CountryHoldout>
}): Promise<SplitManifest["counts"]> {
	await makeDirectories(opts.outputDir)
	const holdouts = opts.holdouts ?? defaultHoldouts()

	for (const split of ["train", "val", "test"] as const) {
		const outPath = resolvePathBuilder(opts.outputDir, `${split}.txt`)
		const sorted = opts.sortedSourceIDPaths?.[split]
		const ids = opts.sourceIDPaths?.[split]

		if (sorted) {
			await sortLines(sorted, outPath, { merge: true })
		} else if (ids) {
			await sortLines([ids], outPath)
		} else {
			await streamSortedSourceIDs(opts.labeledPaths[split], outPath)
		}
	}

	const total = opts.counts.train + opts.counts.val + opts.counts.test

	const summary = {
		corpus_version: opts.corpusVersion,
		holdouts,
		counts: { ...opts.counts, total },
	}

	await writeLocalJSONFile(summary, opts.outputDir, "SPLIT_MANIFEST.json")

	return summary.counts
}

/**
 * Writes the sorted `source_id` values from a labeled JSONL file to `outPath`;
 * an empty input still produces an empty output file.
 */
async function streamSortedSourceIDs(labeledJsonlPath: PathBuilderLike, outPath: PathBuilderLike): Promise<void> {
	const unsortedPath = `${outPath}.unsorted`
	const out = openWriteStream(unsortedPath, { encoding: "utf8" })

	const outClosed = new Promise<void>((resolve, reject) => {
		out.on("close", () => resolve())
		out.on("error", reject)
	})

	// A malformed row throws out of the loop.
	// The `finally` block still closes the write stream.
	try {
		for await (const obj of JSONSpliterator.fromAsync<{ source_id?: string }>(
			delimitedSource(await preferCompressed(labeledJsonlPath))
		)) {
			if (typeof obj.source_id === "string") {
				out.write(`${obj.source_id}\n`)
			}
		}
	} finally {
		out.end()
	}

	await outClosed

	await sortLines([unsortedPath], outPath)

	await removePath(unsortedPath).catch(() => {})
}

/**
 * Sort the lines of `inputs` by byte into `outPath` with `sort(1)`, which spills to disk.
 *
 * With `merge`, each input must already be sorted by byte, and `sort -m` merges them without sorting again.
 * Duplicate lines are kept either way, and zero inputs write an empty file.
 */
export async function sortLines(
	inputs: readonly PathBuilderLike[],
	outPath: PathBuilderLike,
	options: { merge?: boolean } = {}
): Promise<void> {
	if (!inputs.length) {
		await writeLocalTextFile("", outPath)

		return
	}

	const args = [...(options.merge ? ["-m"] : []), ...inputs.map((input) => input.toString()), "-o", outPath.toString()]

	await new Promise<void>((resolve, reject) => {
		// `LC_ALL=C` sorts by byte, so the order is the same on every host.
		const proc = spawnProcess("sort", args, { env: childEnv({ LC_ALL: "C" }) })
		proc.on("error", reject)

		proc.on("exit", (code) => {
			if (code === 0) {
				resolve()
			} else {
				reject(new Error(`sort ${args.join(" ")} exited with code ${code}`))
			}
		})
	})
}
