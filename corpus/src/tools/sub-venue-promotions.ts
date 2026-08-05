/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The sub-venue curation ledger (#35 wave 2) — every decision taken about whether a designator
 *   surface may be used for parsing IN A GIVEN LOCALE, with the census that backs it.
 *
 *   This file is HAND-AUTHORED. `sub-venue-lexicon.ts` is a pure function of its sources; nothing in it
 *   can decide that Spanish `terminal` is safe and British `hall` is not, because that judgement is
 *   about the confounds a token has in a language, and a confound is a fact about the world rather than
 *   about the data. What the builder does is APPLY these decisions — {@link SUBVENUE_PROMOTIONS} is the
 *   only thing that ever sets `curated: true` on a machine-derived surface.
 *
 *   ── Why every decision is per-LOCALE ─────────────────────────────────────────────────────────────
 *   Wave 1 measured `hall` at 3,274 hits in the Great Britain extract and stopped there, which reads as
 *   a verdict on the word. It is not. Re-censused per region 2026-08-05, the same token is a British
 *   disaster and a German designator, and no single global flag can express that. The rule this file
 *   enforces: a promotion names a designator, a phrase, AND a locale, and it is earned by a count taken
 *   in that locale's own data.
 *
 *   ── What "real" and "confound" mean in the numbers below ─────────────────────────────────────────
 *   Each census counts the surface's occurrences in one region's extract and splits them two ways:
 *
 *   - **real** — the phrase sits in a name that is genuinely venue-interior structure, judged by the
 *     rule designator of the feature carrying it (`terminal`, `gate`, `campus`) and by the name taking a
 *     `<designator> <identifier>` or `<modifier> <designator>` shape.
 *   - **confound** — everything else, and the `confoundNote` says WHAT it is. A count with no note is
 *     not a census; "3,274 hits" told nobody that 3,205 of them were bus stops named after a village
 *     hall.
 *
 *   The instrument is `context` on {@link SubVenueSurface} plus the name-shape split; both are
 *   reproducible from the committed extracts, and `PROVENANCE.md` records the commands.
 *
 *   ── A rejection is a deliverable ─────────────────────────────────────────────────────────────────
 *   Rejections stay in this table forever. They are what stops the next contributor re-proposing
 *   `hall` for en-GB from the same Wikidata concept that proposed it the first time.
 */

/**
 * One curation decision.
 */
export interface SubVenuePromotion {
	/**
	 * The {@link SubVenueDesignator.id} the phrase is a surface of.
	 */
	designatorID: string
	/**
	 * The exact normalized surface being decided on — `halle`, not `hall`, when the German form is at issue.
	 */
	phrase: string
	/**
	 * BCP-47-ish `<lang>-<REGION>`. The region half is matched against a surface's `region` and the language half against
	 * its `lang`, so `de-DE` reaches both a German Wikidata label (region-free) and a German extract's untagged name.
	 */
	locale: string
	decision: "promote" | "reject"
	/**
	 * Occurrences judged genuine venue-interior structure in that locale's census.
	 */
	real: number
	/**
	 * Occurrences judged confound.
	 */
	confound: number
	/**
	 * What the confound half IS. Required prose — a bare number is not a board.
	 */
	confoundNote: string
	/**
	 * Which extract or dataset the census was taken over, and when.
	 */
	census: string
}

/**
 * The ledger. Sorted by designator, then locale, then phrase in the emitted artifact; source order here is grouped by
 * designator for reading.
 *
 * ── A rejection of a SHIPPED designator is ADVISORY ──────────────────────────────────────────────
 * `neural/venue-structure.ts` ships `wing`, `terminal`, `concourse` and six more as a FLAT English vocabulary with no
 * locale gate. Nothing in this table can un-ship them: the `wing` / en-US rejection below tells a shard author which
 * locale to exclude from a generated line, and does not stop the span proposer from firing on "Red Wing". Giving the
 * shipped vocabulary a per-locale gate is the largest thing the shard will want that does not exist yet.
 */
export const SUBVENUE_PROMOTIONS: readonly SubVenuePromotion[] = [
	// ── wing ────────────────────────────────────────────────────────────────────────────────────────
	// The designator the corpus task's board rests on (`West Wing` is the one modifier case that
	// already parses), and the cleanest per-locale split in the whole exercise.
	{
		designatorID: "wing",
		phrase: "wing",
		locale: "en-GB",
		decision: "promote",
		real: 23,
		confound: 6,
		confoundNote:
			"Wing Close, Wing Road and Wing Tollgate House — the Buckinghamshire village of Wing — plus Cambian Wing " +
			"College. All six are the <wing> <word> shape; every real hit is a hospital wing (Bexley Wing, Sorby Wing, " +
			"Maternity Wing, West Wing, Bedford Hospital North Wing). CAVEAT, and it limits how far this generalizes: " +
			"24 of the 29 hits sit on a public_transport=platform, because British bus stops are named after the " +
			"hospital wing they serve. The extractor maps no building wings at all — `aile` in France is 0 hits, `ala` " +
			"in Spain 0, `flügel` in Germany 0 — so this evidence is a property of British stop naming, not of a source " +
			"that has wings in it.",
		census: "great-britain.jsonl 2026-08-05, 29 name hits across name + name:<lang>",
	},
	{
		designatorID: "wing",
		phrase: "wing",
		locale: "en-US",
		decision: "reject",
		real: 4,
		confound: 3354,
		confoundNote:
			"Red Wing, the boot brand, is 676 shoe_store rows; chicken wings are another 759 " +
			"(chicken_wings_restaurant 394, chicken_restaurant 365) plus 166 general restaurants. The four real hits are " +
			"campus_building rows. This is the same word as en-GB's clean 23 and it is unusable here.",
		census: "poi.db 2026-05-20.0, full 13,681,698-row scan 2026-08-05",
	},
	{
		designatorID: "wing",
		phrase: "wing",
		locale: "fr-FR",
		decision: "reject",
		real: 0,
		confound: 26,
		confoundNote:
			"Wing Chun and Wing Tsun martial-arts clubs, 15 of 26. Nothing in the French slice of the layer is a " +
			"building wing.",
		census: "poi.db 2026-05-20.0, full scan 2026-08-05 (FR partition, 721,352 rows)",
	},

	// ── hall ────────────────────────────────────────────────────────────────────────────────────────
	// Wave 1 flagged `hall` as per-locale poison on a GB number alone. Two locales measured; both
	// reject, and for DIFFERENT reasons, which is the part worth keeping.
	{
		designatorID: "hall",
		phrase: "hall",
		locale: "en-GB",
		decision: "reject",
		real: 0,
		confound: 3273,
		confoundNote:
			"3,204 of 3,273 hits sit on a public_transport=platform: a British bus stop named after the village hall it " +
			"stands outside. The distribution is Village Hall, Town Hall, British Legion Hall, and then Hall Lane / Hall " +
			"Road / SPEKE HALL ROAD — streets. The 52 that take a <hall> <identifier> shape are bus-stop position codes " +
			"(Village Hall (o/s), Town Hall (3)), and all 16 <modifier> <hall> hits are streets (East Hall Lane, North " +
			"Hall Road).",
		census: "great-britain.jsonl 2026-08-05, 3,273 name hits",
	},
	{
		designatorID: "hall",
		phrase: "hall",
		locale: "en-US",
		decision: "reject",
		real: 2095,
		confound: 27_081,
		confoundNote:
			"City Hall (5,066 town_hall rows), Kingdom Hall of Jehovah's Witnesses (2,312), event halls (2,622) and " +
			"dormitory halls (1,989). Every one names a whole VENUE, not interior structure, so promoting the surface " +
			"would tag them `unit`. The 2,095 real hits are US campus buildings (UAA Cuddy Hall) and they are outnumbered " +
			"13 to 1.",
		census: "poi.db 2026-05-20.0, full 13,681,698-row scan 2026-08-05",
	},
	{
		designatorID: "hall",
		phrase: "halle",
		locale: "de-DE",
		decision: "promote",
		real: 32,
		confound: 168,
		confoundNote:
			"The confound is 97 hits of the CITY Halle — Halle (Saale), population 240,000, plus Halle (Westf) — and 68 " +
			"village and event halls (PHOENIX Halle, Urexweiler Halle), which are whole venues. That is a worse " +
			"confound than wave 1 assumed when it called `Halle 2` the German counter-example to en-GB: the word is " +
			"also a locality. It is promoted anyway because the confound is SEPARABLE BY SHAPE, and that was checked " +
			"rather than assumed — dumping all 32 <halle> <identifier> hits returns numbered factory, trade-fair and " +
			"airport halls (VW Halle 42, Audi GVZ Halle G, Messe West Halle 8, Flughafen Halle 7, Speyer Halle 101) and " +
			"not one instance of the city. Never modifier-eligible and never proposed bare.",
		census: "germany.jsonl 2026-08-05 (403,863 rows), 200 hits; all 32 shape hits enumerated",
	},
	{
		designatorID: "hall",
		phrase: "hall",
		locale: "fr-FR",
		decision: "promote",
		real: 35,
		confound: 5,
		confoundNote:
			"Five: an English `Town Hall` and `Multipurpose hall` on French name:en tags, plus `Manning Hall`. French " +
			"uses `hall` as the airport designator directly — 19 hits are Charles de Gaulle (Terminal 2E - Hall K/L/M, " +
			"Terminal 1 - Hall A/B, Hall D) and 16 more are building halls (Hall des Sources, Hall du Marché, Hôpital " +
			"Hall Sud). The word that is poison in en-GB is the ordinary designator one country away.",
		census: "france.jsonl 2026-08-05 (251,260 rows), 40 hits; all 19 shape hits enumerated",
	},

	// ── gate ────────────────────────────────────────────────────────────────────────────────────────
	// The English surface ships and is deliberately NOT modifier-eligible. These decide its localized
	// forms, and the two land on opposite sides for a reason worth keeping.
	{
		designatorID: "gate",
		phrase: "flugsteig",
		locale: "de-DE",
		decision: "promote",
		real: 19,
		confound: 0,
		confoundNote:
			"None, at full-country scale. 18 of 19 hits are <flugsteig> <identifier> (Flugsteig 10, Flugsteig 9/9A, " +
			"Terminal 1 Flugsteig B) and the last is bare; context is 12 terminal features and 7 gates. The word is a " +
			"pure aviation term with no street, locality or business collision in German. Frankfurt's own name:en " +
			"renders Flugsteig J as `Pier J`, which is a second attestation of the same feature under a second " +
			"designator. A 11-of-11 read on the Hessen extract was the hypothesis; this is the count that earned it.",
		census: "germany.jsonl 2026-08-05 (403,863 rows), 19 hits across name + name:<lang>",
	},
	{
		designatorID: "gate",
		phrase: "porte",
		locale: "fr-FR",
		decision: "reject",
		real: 19,
		confound: 927,
		confoundNote:
			"946 hits, of which 894 are Paris city gates and the Métro stations named after them — Porte d'Orléans, " +
			"Porte Dauphine, Porte de Champerret, Porte de Saint-Cloud. Unlike `halle`, the confound REACHES the " +
			"designator+identifier shape: 17 of the 36 hits in that bucket are Porte Saint-Martin, Porte Saint-Denis, " +
			"Porte Notre-Dame. Shape cannot separate it, which is the same test that killed `pier` for en-US. The 19 " +
			"real hits are ferry and cruise gates (Porte 4 : Ferrys, Berliet Porte C).",
		census: "france.jsonl 2026-08-05 (251,260 rows), 946 hits; all 36 shape hits enumerated",
	},

	// ── pier ────────────────────────────────────────────────────────────────────────────────────────
	// New in wave 2, and the second clean per-locale split: promotable in en-GB, killed in en-US by a
	// furniture chain whose name is exactly the designator+identifier shape.
	{
		designatorID: "pier",
		phrase: "pier",
		locale: "en-GB",
		decision: "promote",
		real: 120,
		confound: 44,
		confoundNote:
			"Pier Road, Pier Street, Pier Avenue, Pier Terrace — 44 street names, all of them the <pier> <street-type> " +
			"shape, which the designator+identifier rule cannot reach. The real side is 98 named piers (Eastbourne Pier, " +
			"Cadogan Pier), 10 in <pier> <identifier> shape (Pier 1, Pier 2, `Terminal 3, Pier 6`), 10 bare and 2 with a " +
			"modifier. Promoted as a SURFACE only; not modifier-eligible, on the same reasoning that excludes `gate`.",
		census: "great-britain.jsonl 2026-08-05, 164 name hits",
	},
	{
		designatorID: "pier",
		phrase: "pier",
		locale: "en-US",
		decision: "reject",
		real: 278,
		confound: 2330,
		confoundNote:
			"Pier 1 Imports and its franchises are 341 home_decor_store plus 217 furniture_store rows, and they carry the " +
			"<pier> <identifier> shape EXACTLY — so unlike en-GB the confound is not separable by shape. Another 159 are " +
			"seafood restaurants and 144 are parks.",
		census: "poi.db 2026-05-20.0, full 13,681,698-row scan 2026-08-05",
	},

	// ── terminal ────────────────────────────────────────────────────────────────────────────────────
	// The English surface already ships. These promote the LOCALIZED forms, which is what a non-English
	// shard line needs and what wave 1 had none of.
	{
		designatorID: "terminal",
		phrase: "terminal",
		locale: "es-ES",
		decision: "promote",
		real: 190,
		confound: 0,
		confoundNote:
			"None. Spanish borrows the English word unchanged and uses it in every shape the task targets: Terminal A, " +
			"Terminal T1, Terminal 4S, plus named terminals (Terminal Marítima de Santander). No Spanish street type " +
			"collides with it. The Wikidata label `terminal aeroportuaria` is the encyclopaedic form and stays uncurated; " +
			"this promotes the derived head noun.",
		census: "spain.jsonl 2026-08-05, 190 hits across name + name:<lang>",
	},
	{
		designatorID: "terminal",
		phrase: "terminal",
		locale: "ca-ES",
		decision: "promote",
		real: 15,
		confound: 0,
		confoundNote:
			"None. Catalan is the same borrowing (Terminal 1, Terminal Sortides, Terminal Arribades) and needs its own " +
			"entry because a surface's language subtag is `ca`, which an es-ES decision does not reach.",
		census: "spain.jsonl 2026-08-05, 15 name:ca hits",
	},
	{
		designatorID: "terminal",
		phrase: "terminal",
		locale: "fr-FR",
		decision: "promote",
		real: 169,
		confound: 0,
		confoundNote:
			"None. 99 hits are <terminal> <identifier> (Aéroport CDG Terminal 2F, Terminal 2G, Lyon Saint-Exupéry " +
			"Terminal 1), 51 are named terminals (Terminal de Grande-Bretagne, Terminal Croisières) and 13 trail a " +
			"venue name. French borrows the word unchanged and no French street type collides with it.",
		census: "france.jsonl 2026-08-05 (251,260 rows), 169 hits across name + name:<lang>",
	},
	{
		designatorID: "terminal",
		phrase: "ターミナル",
		locale: "ja-JP",
		decision: "promote",
		real: 1213,
		confound: 2,
		confoundNote:
			"Two hits are `ターミナル前` — a bus stop named 'in front of the terminal', which is arguably still real. " +
			"Japanese has no street-name class containing the word. 246 hits take the Japanese target shape " +
			"<identifier><designator> (第2ターミナル, 羽田空港第1ターミナル); 957 are compounds naming a terminal " +
			"(バスターミナル, フェリーターミナル, 成田空港第一ターミナル); 10 are <designator> <identifier>. This is the " +
			"surface the corpus task named as missing, and it exists only because the head-noun derivation produced it " +
			"from five compound Wikidata labels first.",
		census: "japan.jsonl 2026-08-05, 1,215 hits across name + name:<lang>",
	},
]
