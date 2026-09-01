# Country-coverage candidates — proposed gauntlet seed cases

> **STATUS: EXECUTED 2026-08-05. This file is now the PROVENANCE RECORD for the
> `operator:country-sweep-2026-08-05` batch, not a to-do list.** The body below is preserved as authored —
> including the entries the sweep proved wrong — because what a draft PREDICTED is the only thing that makes
> the measurement mean anything. Read `batch-notes.md`'s `operator:country-sweep-2026-08-05` section for
> what happened to each row.
>
> **Result, in one paragraph.** All 400 candidates went through the Google oracle
> (`@mailwoman/geocode-oracle`, country-restricted, `language=en`): 400/400 resolved, zero `ZERO_RESULTS`,
> so every address in this file exists as written. Seven came back `partial_match` — the drafted string is
> not the string Google answered about — and were parked, not promoted. The remaining 393 went through the
> production pipeline (the gauntlet harness with no options, per-country weights overlay): **114 FAILED and
> are promoted** to `cases/<cc>/regression.jsonl` as `improvement_target`, **279 PASSED** and are parked in
> `cases/generalization/country-sweep-2026-08-05-passes.jsonl` (the loader walks two-letter dirs only, so
> that file is inert). The corpus went 192 → 306 rows and 29 → 121 country dirs.
>
> **The class hypothesis below was half right.** Bare-capital/namesake produced the most bugs in absolute
> terms (71 of 114), as predicted. But the highest per-row failure rate was class 3, the
> country-distinctive addressing structures: 13 of 31 failed outright (42%) and 6 of the 7 oracle-suspect
> rows were class-3 too. Exonym/renamed/script was the SAFEST class (30 of 137, 22%) — the fold work
> already shipped mostly holds.
>
> **The sharpest finding is not in any class.** 29 of the 114 failures share one measured cause: the
> shipped `candidate.db` and `admin-global-priority.db` disagree about what a synthetic place id means, so
> `geocode "Gaborone"` returns Gaborone's WOF id carrying the name and coordinate of a hamlet in Austrian
> Styria. See the batch note for the counts and the receipt.
>
> ---
>
> **Original header, as drafted (unverified against the live pipeline; NOT a commit target).**
> Proposed 2026-08-05. ~160 countries have zero coverage in `regression.ts` (29 countries) and the
> parity corpus (~20, US/NL/NZ/AU/DE/FR-heavy). This sweep closes the gap **by failure-mode class**,
> not by thoroughness — per the corpus rule ("never pad; every entry pins a failure").
>
> **Triage protocol (measure, don't reason):** run each entry through the pipeline before promoting.
> Entries that FAIL are real bugs → promote to `regression.ts` as `improvement_target` (or `pass`
> once fixed). Entries that PASS are generalization evidence → they belong in the held-out runner
> (`holdout.ts`), NOT in the regression leg. Coordinates are deliberately NOT asserted here; assert
> components first, coordinates only after the resolver is measured on the entry.
>
> `source: "operator:country-sweep-2026-08-05"`, `status: "improvement_target"` for all entries.
> `confidence` marks MY knowledge confidence about the address string (HIGH = canonical, well-known;
> MED = verify the street/name before committing). Kind names follow the existing `address_kind`
> taxonomy style.

## The three failure-mode classes this sweep targets

1. **Bare-capital / namesake collisions** — the class that already produced real bugs (#267 Tbilisi→US
   Georgia, #833 Portland ME→Messina, #905 Paris→Paris Township OH, Dublin→Dublin OH, Vancouver→WA).
   ~190 countries × namesake-prone capitals = the largest unguarded real-bug surface.
2. **Exonym / renamed / script variants** — "Kyiv" vs "Kiev", "Yangon" vs "Rangoon", "Hagåtña" vs
   "Agana", "Rīga" vs "Riga", "Chișinău" vs "Chisinau". The gazetteer carries one spelling; the input
   carries another. Cheap to assert (components/coords only).
3. **Country-distinctive addressing structures** — chōme/ban (JP), block+street+house (KW), sector
   (PK), 6-digit-postal (SG), supermanzana (MX, present), pluscode (NI, present), townland (IE,
   present), freguesia (PT), soi (TH).

---

## Africa

### EG — Egypt

- [ ] `Cairo` — `bare_city_global` — HIGH — namesake class: Cairo IL/GA/NY/NE/WV/OH all exist; unscoped must win EG (2.2M-pop + governorate).
- [ ] `Alexandria` — `bare_city_global` — HIGH — namesake class: Alexandria VA/LA/MN/IN… 20+ US towns; the #905 family.
- [ ] `1 Tahrir Square, Downtown, Cairo` — `eg_venue_square` — MED — square-led form; Tahrir is a square not a street, pins square/toponym parsing.

### DZ — Algeria

- [ ] `Algiers` — `bare_city_exonym` — HIGH — "Algiers"/"Alger"/"الجزائر" triple; exonym fold.
- [ ] `Oran` — `bare_city_global` — MED — namesake: Oran, Missouri.

### MA — Morocco

- [ ] `Casablanca` — `bare_city_global` — HIGH — namesake: Casablanca, Chile; also "Dar el-Beida" alias.
- [ ] `Marrakesh` — `spelling_variant` — HIGH — "Marrakesh" vs "Marrakech" both common.

### TN — Tunisia

- [ ] `Tunis` — `bare_city_global` — MED — namesake: Tunis, Ontario.
- [ ] `Sousse` — `spelling_variant` — MED — "Sousse" vs "Susa" (Italian exonym).

### LY — Libya

- [ ] `Tripoli` — `bare_city_namesake` — HIGH — THE triple-Tripoli class: Libya / Lebanon / Greece share the exact string; unscoped must win the capital (1.2M) over the port town.
- [ ] `Benghazi` — `bare_city_global` — MED — also spelled "Bengasi"/"Banghazi".

### SD — Sudan

- [ ] `Khartoum` — `bare_city_same_admin` — MED — city vs "Khartoum State" same-name; also "Khartum" spelling.
- [ ] `Omdurman` — `bare_city_global` — MED — the cross-river twin; distinct city, no postcode.

### SS — South Sudan

- [ ] `Juba` — `bare_city_global` — MED — new capital; gazetteer may carry none/state-level only.

### ET — Ethiopia

- [ ] `Addis Ababa` — `spelling_variant` — HIGH — "Addis Ababa" vs "Addis Abeba"; chartered city = region, same-name admin.
- [ ] `Dire Dawa` — `bare_city_global` — MED — hyphenated two-word; also a chartered city (same-name region).

### ER — Eritrea

- [ ] `Asmara` — `bare_city_global` — MED — also "Asmera"; no street system in Western sense.

### DJ — Djibouti

- [ ] `Djibouti` — `city_country_same` — HIGH — capital and country are the same string; must resolve to the city.

### SO — Somalia

- [ ] `Mogadishu` — `spelling_variant` — MED — "Mogadishu" vs "Muqdisho"/"Xamar"; country data thin.
- [ ] `Hargeisa` — `bare_city_global` — MED — de facto capital of Somaliland; recognition-churn admin.

### KE — Kenya

- [ ] `Nairobi` — `bare_city_same_admin` — HIGH — city vs "Nairobi County" same-name.
- [ ] `Mombasa` — `bare_city_global` — HIGH — namesake: Mombasa, Tanzania (border town).

### UG — Uganda

- [ ] `Kampala` — `bare_city_same_admin` — MED — city vs "Kampala District" same-name.
- [ ] `Entebbe` — `bare_city_global` — MED — the airport town; city/district churn.

### TZ — Tanzania

- [ ] `Dar es Salaam` — `bare_city_same_admin` — HIGH — city vs "Dar es Salaam Region"; also "Dodoma" is the official capital — two-capital country, the BO class.
- [ ] `Zanzibar City` — `intl_city_region` — MED — "Zanzibar City" vs "Zanzibar" island/region/archipelago; three-way same-name.

### RW — Rwanda

- [ ] `Kigali` — `bare_city_same_admin` — MED — city vs "Kigali Province" (merged 2006).
- [ ] `Butare` — `bare_city_global` — MED — renamed "Huye" (2006); old name still in use — renamed-class.

### BI — Burundi

- [ ] `Bujumbura` — `admin_churn` — MED — 2019 split into Bujumbura Mairie + Bujumbura Rural provinces, then re-merged (2024 churn); city may dangle under either.

### CD — DR Congo

- [ ] `Kinshasa` — `bare_city_same_admin` — HIGH — city-province same-name; namesake: Kinshasa, Ohio (no — VERIFY; US township risk).
- [ ] `Lubumbashi` — `bare_city_global` — MED — ex-Elisabethville (renamed 1966).

### CG — Congo

- [ ] `Brazzaville` — `bare_city_global` — MED — the river twin of Kinshasa; cross-country pair.
- [ ] `Pointe-Noire` — `bare_city_global` — MED — hyphenated; also a department.

### GA — Gabon

- [ ] `Libreville` — `bare_city_global` — MED.

### CM — Cameroon

- [ ] `Yaoundé` — `spelling_variant` — HIGH — "Yaoundé" vs "Yaounde" diacritic drop; also "Yaounde" region same-name.
- [ ] `Douala` — `bare_city_global` — MED — also "Duala"; economic capital.

### NE — Niger

- [ ] `Niamey` — `bare_city_global` — MED.

### ML — Mali

- [ ] `Bamako` — `bare_city_same_admin` — MED — city vs "Bamako District" same-name.
- [ ] `Timbuktu` — `spelling_variant` — MED — "Timbuktu" vs "Tombouctou" (FR official).

### SN — Senegal

- [ ] `Dakar` — `bare_city_same_admin` — MED — city vs "Dakar Region" same-name.
- [ ] `Saint-Louis` — `bare_city_namesake` — HIGH — namesake: Saint-Louis, MO (the #833/Portland class); also "Saint Louis" un-hyphenated.

### MR — Mauritania

- [ ] `Nouakchott` — `bare_city_global` — MED — 2014 split into Nouakchott-Nord/Sud/Ouest; city may dangle.

### GW — Guinea-Bissau

- [ ] `Bissau` — `bare_city_same_admin` — MED — city vs "Bissau" sector same-name.

### GN — Guinea

- [ ] `Conakry` — `bare_city_same_admin` — MED — city vs "Conakry Region" same-name.

### SL — Sierra Leone

- [ ] `Freetown` — `bare_city_global` — MED — also "Western Area Urban".

### LR — Liberia

- [ ] `Monrovia` — `bare_city_global` — MED — named after US president; namesake: Monrovia, Indiana/California.

### CI — Côte d'Ivoire

- [ ] `Abidjan` — `bare_city_same_admin` — MED — city vs "Abidjan District"/"Abidjan Region"; "Abidjan" also a comune.
- [ ] `Yamoussoukro` — `bare_city_global` — MED — the official capital (since 1983), population ~200k — the capital-vs-economic-city disambiguation.

### GH — Ghana

- [ ] `Accra` — `bare_city_same_admin` — MED — city vs "Greater Accra Region".
- [ ] `Kumasi` — `bare_city_global` — MED — also spelled "Coomassie" (historical).

### TG — Togo

- [ ] `Lomé` — `spelling_variant` — MED — "Lomé" vs "Lome" diacritic drop.

### BJ — Benin

- [ ] `Cotonou` — `bare_city_global` — MED — economic capital (Porto-Novo is official) — two-capital class.
- [ ] `Porto-Novo` — `bare_city_namesake` — MED — namesake: Porto Novo, Brazil; hyphenated.

### BF — Burkina Faso

- [ ] `Ouagadougou` — `bare_city_global` — MED — ex-upper-Volta-era "Ouagadougou" vs "Ouaga" informal.

### TD — Chad

- [ ] `N'Djamena` — `apostrophe_trap` — HIGH — "N'Djamena" vs "Ndjamena" apostrophe-dropped; the td twin of ye_sanaa.

### CF — Central African Republic

- [ ] `Bangui` — `bare_city_global` — MED.

### AO — Angola

- [ ] `Luanda` — `bare_city_same_admin` — MED — city vs "Luanda Province" same-name.
- [ ] `Huambo` — `spelling_variant` — MED — ex-" Nova Lisboa" (renamed 1975); old name still in gazetteers.

### ZM — Zambia

- [ ] `Lusaka` — `bare_city_same_admin` — MED — city vs "Lusaka Province" same-name.
- [ ] `Livingstone` — `bare_city_global` — MED — namesake: Livingstone, NJ/CA… (the Victoria Falls town).

### MW — Malawi

- [ ] `Lilongwe` — `bare_city_same_admin` — MED — city vs "Lilongwe District" same-name.
- [ ] `Blantyre` — `bare_city_global` — MED — namesake: Blantyre, Scotland (Livingstone's birthplace) — genuine cross-country pair.

### MZ — Mozambique

- [ ] `Maputo` — `bare_city_same_admin` — MED — city vs "Maputo Province"; ex-"Lourenço Marques" (renamed 1976).
- [ ] `Beira` — `bare_city_global` — MED.

### ZW — Zimbabwe

- [ ] `Harare` — `bare_city_same_admin` — MED — city vs "Harare Province"; ex-Salisbury (renamed 1982).
- [ ] `Bulawayo` — `bare_city_global` — MED — province-level city.

### NA — Namibia

- [ ] `Windhoek` — `bare_city_global` — MED — also "Windhuk" (German-era spelling).
- [ ] `Swakopmund` — `bare_city_global` — MED — the German colonial town.

### BW — Botswana

- [ ] `Gaborone` — `bare_city_global` — MED — also "Gaborones" (colonial).
- [ ] `Francistown` — `bare_city_global` — MED.

### ZA — South Africa

- [ ] `Pretoria` — `renamed_metro` — HIGH — ex-Pretoria now part of "Tshwane" metro; "Pretoria" still the common input — renamed-admin class.
- [ ] `Durban` — `renamed_metro` — HIGH — now "eThekwini" metro; "Durban" still the common input.
- [ ] `Bloemfontein` — `renamed_metro` — MED — "Mangaung" metro; also the judicial capital — three-capitals country.
- [ ] `14 Long St, Green Point, Cape Town, 8001` — `za_suburb_postal` — MED — suburb+postal-town structure; postal town ≠ municipality.

### LS — Lesotho

- [ ] `Maseru` — `bare_city_same_admin` — MED — city vs "Maseru District" same-name.

### SZ — Eswatini

- [ ] `Mbabane` — `bare_city_global` — MED — also spelled "Mbabane" vs "Mbabane District"; ex-"Swaziland" country rename churn (2018).
- [ ] `Manzini` — `bare_city_same_admin` — MED — city vs "Manzini Region".

### KM — Comoros

- [ ] `Moroni` — `bare_city_global` — MED — also "Moroni" vs "Moroni, Utah" (VERIFY) — namesake risk.

### MG — Madagascar

- [ ] `Antananarivo` — `bare_city_global` — MED — also "Tananarive" (French-era spelling).
- [ ] `Toamasina` — `spelling_variant` — MED — "Toamasina" vs "Tamatave".

### MU — Mauritius

- [ ] `Port Louis` — `bare_city_global` — MED — namesake: Port-Louis, Guadeloupe; un-hyphenated form.
- [ ] `Curepipe` — `bare_city_global` — MED — single-word town, no street in the Western sense for some districts.

### SC — Seychelles

- [ ] `Victoria` — `bare_city_namesake` — HIGH — THE mega-namesake: Victoria BC/TX/AU/NZ/HK…; must win the ~26k-pop capital (or at least stay in SC).

### RE — Réunion

- [ ] `Saint-Denis` — `bare_city_namesake` — HIGH — namesake: Saint-Denis, FR (Seine-Saint-Denis, 110k) — the island/continent pair; also "Saint Denis" un-hyphenated.

### YT — Mayotte

- [ ] `Mamoudzou` — `bare_city_global` — MED.

### SH — Saint Helena, Ascension, Tristan da Cunha

- [ ] `Jamestown` — `bare_city_namesake` — MED — namesake: Jamestown VA/NY/RI…; 700-pop capital.
- [ ] `Edinburgh of the Seven Seas` — `venue_toponym_trap` — MED — the Tristan da Cunha settlement; THE definitive "of the..." compound.

### CV — Cabo Verde

- [ ] `Praia` — `bare_city_global` — MED — namesake: Praia da Vitória, Azores (Portugal).
- [ ] `Mindelo` — `bare_city_global` — MED.

### ST — São Tomé and Príncipe

- [ ] `São Tomé` — `city_country_same` — MED — capital and country same string; also "Sao Tome" diacritic drop.
- [ ] `Santo António` — `bare_city_global` — MED — the Príncipe town; diacritics.

### GM — Gambia

- [ ] `Banjul` — `bare_city_global` — MED — also "Banjul District" same-name.
- [ ] `Serekunda` — `bare_city_global` — MED — the largest city (≠ capital) — capital-vs-largest class.

### GQ — Equatorial Guinea

- [ ] `Malabo` — `bare_city_global` — MED — also "Malabo" vs "Santa Isabel" (colonial); new capital "Ciudad de la Paz" (Oyala, 2017) — two-capital churn.
- [ ] `Bata` — `bare_city_global` — MED.

### IO — British Indian Ocean Territory

- [ ] `Diego Garcia` — `bare_city_global` — MED — no civilian addressing; pins the "no data → admin-only" path.

### EH — Western Sahara

- [ ] `Laayoune` — `spelling_variant` — MED — "Laayoune"/"El Aaiún"/"Laâyoune" — contested-admin spelling.

---

## Asia

### TR — Türkiye

- [ ] `İzmir` — `diacritic_script` — HIGH — "İzmir" (dotted İ) vs "Izmir" vs "Smyrna"; province/city same-name.
- [ ] `Atatürk Caddesi No 12, Beşiktaş, İstanbul` — `tr_street_mahalle` — MED — cadde/sokak + mahalle structure; "İstanbul" dotted capital.
- [ ] `Konya` — `bare_city_global` — MED — also "Konia" (Greek-era).

### IL — Israel

- [ ] `Tel Aviv-Yafo` — `compound_city` — HIGH — "Tel Aviv-Yafo" vs "Tel Aviv" vs "תל אביב"; compound + script.
- [ ] `Jerusalem` — `bare_city_namesake` — HIGH — namesake: Jerusalem, Ohio (and Jerusalem, NZ) — the #905 family.
- [ ] `Ben Yehuda St 12, Tel Aviv` — `il_street_he` — MED — "St" vs "Street" abbrev; Hebrew-script street names.

### IQ — Iraq

- [ ] `Erbil` — `spelling_variant` — HIGH — "Erbil" vs "Arbil" vs "Irbil" — the definitive Kurdish spelling tangle.
- [ ] `Baghdad` — `bare_city_global` — MED — "Baghdad" vs "Bagdad"; also governorate same-name.

### SY — Syria

- [ ] `Aleppo` — `exonym_script` — MED — "Aleppo" vs "Halab"/"حلب".
- [ ] `Damascus` — `exonym_script` — MED — "Damascus" vs "Dimashq"/"دمشق"; governorate same-name.

### YE — Yemen

- [ ] `Sana'a` — `apostrophe_trap` — HIGH — "Sana'a" vs "Sanaa" vs "Sana" — the definitive apostrophe case (with td N'Djamena).
- [ ] `Aden` — `bare_city_global` — MED — also "Adan"; governorate same-name.

### OM — Oman

- [ ] `Muscat` — `spelling_variant` — MED — "Muscat" vs "Masqat"/"Maskat"; governorate same-name.
- [ ] `Salalah` — `bare_city_global` — MED.

### PS — Palestine

- [ ] `Gaza` — `bare_city_namesake` — HIGH — namesake: Gaza, Pennsylvania (the #833 class); also "Ghazzah".
- [ ] `Ramallah` — `bare_city_global` — MED — also "Ramallah and al-Bireh" governorate.

### BH — Bahrain

- [ ] `Manama` — `bare_city_same_admin` — MED — city vs "Manama Governorate" same-name.

### KW — Kuwait

- [ ] `House 12, Street 102, Block 5, Salmiya` — `kw_block_street_house` — HIGH — the block/street/house addressing system; structurally unlike anything covered.
- [ ] `Hawalli` — `bare_city_global` — MED — governorate/city same-name.

### QA — Qatar

- [ ] `Doha` — `bare_city_global` — MED — also "Ad-Dawhah"; namesake: Doha, Jordan (village).
- [ ] `The Pearl, Doha` — `venue_led` — MED — district-led ("The Pearl-Qatar"); "The " article-led toponym.

### AE — UAE

- [ ] `Dubai` — `bare_city_same_admin` — HIGH — city vs "Dubai" emirate same-name (already-proven class in this corpus's home: Dubai vs Dubai, #?).
- [ ] `Abu Dhabi` — `bare_city_same_admin` — HIGH — city vs emirate; also the country's capital.
- [ ] `PO Box 12345, Dubai` — `ae_po_box` — MED — PO-box-heavy addressing; PO box + no street.

### SA — Saudi Arabia

- [ ] `Riyadh` — `bare_city_same_admin` — MED — city vs "Riyadh Province"/"Riyadh Region".
- [ ] `Jeddah` — `spelling_variant` — MED — "Jeddah" vs "Jiddah"/"Jidda" — the definitive transliteration tangle.

### JO — Jordan

- [ ] `Amman` — `bare_city_global` — MED — also "Amman Governorate" same-name; "Amman" vs "Ammān" diacritic.
- [ ] `Jabal Amman, Amman` — `jo_district_circle` — MED — district-led; the "1st Circle" reference system.

### CY — Cyprus

- [ ] `Nicosia` — `exonym_script` — HIGH — "Nicosia"/"Lefkosia"/"Lefkoşa" — the divided-capital triple (GR/TR scripts).
- [ ] `Larnaca` — `spelling_variant` — MED — "Larnaca" vs "Larnaka".

### KZ — Kazakhstan

- [ ] `Astana` — `renamed_city` — HIGH — "Astana" → "Nur-Sultan" (2019) → back to "Astana" (2022) — the rename-return trap; gazetteer may carry either.
- [ ] `Almaty` — `spelling_variant` — HIGH — "Almaty" vs "Alma-Ata" (Soviet); also "Алматы" Cyrillic.

### UZ — Uzbekistan

- [ ] `Tashkent` — `spelling_variant` — MED — "Tashkent"/"Toshkent"/"Ташкент" triple.
- [ ] `Samarkand` — `spelling_variant` — MED — "Samarkand"/"Samarqand".

### TM — Turkmenistan

- [ ] `Ashgabat` — `spelling_variant` — MED — "Ashgabat"/"Ashgabad"/"Aşgabat" — four-spelling case.
- [ ] `Turkmenabat` — `spelling_variant` — MED — ex-"Chardzhou" (renamed 1999); old name persists.

### KG — Kyrgyzstan

- [ ] `Bishkek` — `renamed_city` — MED — ex-"Frunze" (1926–1991); old name in old gazetteers; "Бишкек" Cyrillic.

### TJ — Tajikistan

- [ ] `Dushanbe` — `spelling_variant` — MED — "Dushanbe" vs "Dushanbé" diacritic; ex-"Stalinabad".

### AF — Afghanistan

- [ ] `Kabul` — `spelling_variant` — MED — "Kabul"/"Kābol"/"کابل"; province same-name.
- [ ] `Kandahar` — `spelling_variant` — MED — "Kandahar"/"Qandahar".

### PK — Pakistan

- [ ] `Islamabad` — `bare_city_global` — HIGH — also "Islamabad Capital Territory" same-name.
- [ ] `House 4, Street 25, F-7/2, Islamabad` — `pk_sector` — HIGH — the sector/sub-sector structure (F-7/2); uniquely Pakistani.
- [ ] `Lahore` — `bare_city_global` — MED — also "Lahaur"; namesake: Lahore, Virginia (VERIFY).

### IN — India (covered 3 — upgrades)

- [ ] `Mumbai` — `renamed_city` — HIGH — ex-"Bombay" (1995); both names still in circulation — renamed-class.
- [ ] `Bengaluru` — `renamed_city` — HIGH — ex-"Bangalore" (2014); the rename-return is still settling.
- [ ] `Chennai` — `renamed_city` — HIGH — ex-"Madras" (1996).

### BD — Bangladesh (covered 2 — upgrade)

- [ ] `Chittagong` — `renamed_city` — HIGH — officially "Chattogram" (2018); "Chittagong" still the common input — the exact za_metro class.

### LK — Sri Lanka

- [ ] `Colombo` — `bare_city_global` — MED — namesake: Colombo, Brazil (Paraná).
- [ ] `No 12, Galle Road, Colombo 03` — `lk_number_city` — MED — the "No <n>, <street>, <city> <number>" form; Colombo 03 postal-district numbering.

### NP — Nepal

- [ ] `Kathmandu` — `bare_city_same_admin` — MED — city vs "Kathmandu District"/"Kathmandu Valley" same-name.
- [ ] `Biratnagar` — `bare_city_global` — MED.

### BT — Bhutan

- [ ] `Thimphu` — `bare_city_same_admin` — MED — city vs "Thimphu District" same-name.
- [ ] `Paro` — `bare_city_global` — MED — town vs "Paro District" same-name.

### MV — Maldives

- [ ] `Malé` — `diacritic_script` — HIGH — "Malé" vs "Male" diacritic-drop; also "Malé" city vs "Malé" (Kaafu) atoll — same-name pair.

### MM — Myanmar

- [ ] `Yangon` — `renamed_city` — HIGH — ex-"Rangoon" (1989); the definitive SE-Asia rename; region same-name.
- [ ] `Naypyidaw` — `spelling_variant` — MED — "Naypyidaw"/"Nay Pyi Taw"/"Naypidaw" — the new-capital spelling tangle.

### TH — Thailand (covered 1 — upgrade)

- [ ] `Chiang Mai` — `bare_city_same_admin` — HIGH — city vs "Chiang Mai Province"; also "Chiangmai" unspaced.
- [ ] `Sukhumvit Soi 11, Bangkok` — `th_soi` — MED — the soi/sublane structure; "Sukhumvit" is the road, Soi 11 the branch.

### LA — Laos

- [ ] `Vientiane` — `exonym_script` — MED — "Vientiane"/"Viangchan"/"ວຽງຈັນ".
- [ ] `Luang Prabang` — `bare_city_global` — MED — two-word; also "Louangphabang".

### KH — Cambodia

- [ ] `Phnom Penh` — `bare_city_same_admin` — MED — city vs "Phnom Penh Municipality" same-name; also "Phnum Pénh".
- [ ] `Sangkat Boeung Keng Kang, Khan Chamkarmon, Phnom Penh` — `kh_sangkat_khan` — MED — the sangkat/khan admin structure.

### VN — Vietnam

- [ ] `Ho Chi Minh City` — `renamed_city` — HIGH — ex-"Saigon" (1976); both names common — renamed-class.
- [ ] `Hanoi` — `diacritic_script` — MED — "Hanoi" vs "Hà Nội"; also "Ha Noi".
- [ ] `12 Lý Thái Tổ, Hoàn Kiếm, Hà Nội` — `vn_street_ward` — MED — ward/district structure; diacritics in street.

### MY — Malaysia

- [ ] `Kuala Lumpur` — `bare_city_global` — MED — also "KL" abbrev-trap; Federal Territory same-name.
- [ ] `George Town` — `spelling_variant` — HIGH — "George Town" (Penang) vs "Georgetown" — the spelling pair (also KY, GY, CA).
- [ ] `Petaling Jaya` — `bare_city_global` — MED — city vs "Petaling District"; "PJ" abbrev.

### SG — Singapore

- [ ] `Blk 12 Kallang Ave #03-04, Singapore 123456` — `sg_block_postal` — HIGH — the 6-digit-postal-IS-the-address form; block + unit + unique postal.
- [ ] `Singapore` — `city_country_same` — HIGH — city/state/country same string — the definitive case.

### ID — Indonesia

- [ ] `Jakarta` — `bare_city_same_admin` — MED — city vs "Jakarta Special Capital Region" (DKI); "Jakarta" vs "Djakarta" colonial.
- [ ] `Jl. Jendral Sudirman No. 1, Jakarta` — `id_jalan` — MED — "Jl." abbrev + "Jendral"/"Jenderal" spelling wobble.
- [ ] `Yogyakarta` — `spelling_variant` — MED — "Yogyakarta"/"Jogjakarta"/"Jogja" — three spellings.

### PH — Philippines

- [ ] `Manila` — `bare_city_global` — MED — namesake: Manila, Arkansas; also "Maynila".
- [ ] `Quezon City` — `bare_city_same_admin` — MED — city vs "Quezon" province (different entity — the old-capital class).
- [ ] `Barangay San Antonio, Makati` — `ph_barangay` — MED — the barangay-first form.

### BN — Brunei

- [ ] `Bandar Seri Begawan` — `bare_city_global` — MED — also "BSB" abbrev-trap; the longest single capital name.
- [ ] `Kuala Belait` — `bare_city_global` — MED.

### TL — Timor-Leste

- [ ] `Dili` — `diacritic_script` — MED — "Dili" vs "Díli" diacritic; also "Dilly" (colonial).
- [ ] `Baucau` — `bare_city_global` — MED — the second city.

### JP — Japan (covered 1 — upgrade)

- [ ] `1-2-3 Ginza, Chuo-ku, Tokyo` — `jp_bancho` — HIGH — the chōme/ban/gō block system — no street names; "Ginza" is the chōme.
- [ ] `Shibuya, Tokyo` — `jp_ward_locality` — HIGH — ward vs station-area ambiguity: "Shibuya" is the ward AND the famous area.
- [ ] `Kyoto` — `bare_city_same_admin` — MED — city vs "Kyoto Prefecture" same-name (like the tr "İzmir" class).

### KR — South Korea

- [ ] `Seoul` — `bare_city_global` — MED — "Seoul" vs "Sŏul" romanization; special-city same-name.
- [ ] `Gangnam-gu, Seoul` — `kr_gu` — MED — the gu structure; "Gangnam-gu" vs "Gangnam" bare.
- [ ] `Busan` — `spelling_variant` — MED — "Busan" vs "Pusan" (old romanization) — the MR/revised-romanization pair.

### KP — North Korea

- [ ] `Pyongyang` — `spelling_variant` — MED — "Pyongyang"/"P'yŏngyang"/"평양" — romanization tangle; admin data thin.

### TW — Taiwan

- [ ] `Taipei` — `spelling_variant` — MED — "Taipei" vs "Taibei" vs "臺北".
- [ ] `New Taipei` — `renamed_city` — MED — ex-"Taipei County" (2010) → "New Taipei City" — the split/rename class; "New Taipei" vs "Taipei" adjacency trap.

### MN — Mongolia

- [ ] `Ulaanbaatar` — `spelling_variant` — MED — "Ulaanbaatar"/"Ulan Bator"/"Улаанбаатар" — three-spelling case.

### CN — China

- [ ] `Beijing` — `spelling_variant` — MED — "Beijing" vs "Peking" (old romanization, still in some gazetteers).
- [ ] `Shanghai` — `bare_city_same_admin` — MED — city vs "Shanghai Municipality" same-name.
- [ ] `Nanjing Road, Huangpu, Shanghai` — `cn_road_district` — MED — road+district structure; "Nanjing" vs "Nanking" romanization.

### HK — Hong Kong

- [ ] `Central, Hong Kong` — `hk_district` — MED — district-led; "Central" vs "Central and Western District".
- [ ] `New Territories, Hong Kong` — `hk_region` — MED — the region same-name; also "NT" abbrev.

### MO — Macau

- [ ] `Macau` — `spelling_variant` — MED — "Macau" vs "Macao" — the definitive spelling pair.
- [ ] `Taipa` — `bare_city_global` — MED — namesake: Taipa, New Zealand (Northland).

### GE — Georgia (covered 2 — skip; covered)

---

## Europe

### IS — Iceland (covered 1 — upgrade)

- [ ] `Reykjavík` — `diacritic_script` — HIGH — "Reykjavík" vs "Reykjavik" diacritic-drop; "Reykjavíkurborg" municipality.
- [ ] `Akureyri` — `bare_city_global` — MED.

### FO — Faroe Islands (covered 1 — upgrade)

- [ ] `Tórshavn` — `diacritic_script` — MED — "Tórshavn" vs "Thorshavn" (Danish-era spelling).

### DK — Denmark

- [ ] `Aarhus` — `spelling_variant` — HIGH — "Aarhus" vs "Århus" — the definitive Å/aa respelling (2011 official revert).
- [ ] `Copenhagen` — `exonym_script` — HIGH — "Copenhagen" vs "København"; also "København V" postal-district forms.

### SE — Sweden

- [ ] `Gothenburg` — `exonym_script` — HIGH — "Gothenburg" vs "Göteborg" vs "Götheborg".
- [ ] `Stockholm` — `bare_city_same_admin` — MED — city vs "Stockholm County" same-name.
- [ ] `Malmö` — `diacritic_script` — MED — "Malmö" vs "Malmo" drop.

### NO — Norway

- [ ] `Oslo` — `bare_city_global` — HIGH — namesake: Oslo, Minnesota.
- [ ] `Bergen` — `bare_city_namesake` — HIGH — namesake: Bergen NY/NL/DE (the #833 class).
- [ ] `Førde` — `bare_city_global` — MED — the fjord-town diacritics; "Forde" drop.

### FI — Finland (covered 1 — upgrade)

- [ ] `Helsinki` — `exonym_script` — HIGH — "Helsinki" vs "Helsingfors" (bilingual Finland).
- [ ] `Tampere` — `exonym_script` — MED — "Tampere" vs "Tammerfors".

### EE — Estonia

- [ ] `Tallinn` — `bare_city_global` — MED — also "Reval" (historical); "Tallin" misspelling common.
- [ ] `Tartu` — `bare_city_global` — MED — also "Dorpat" (historical).

### LV — Latvia

- [ ] `Rīga` — `diacritic_script` — HIGH — "Rīga" vs "Riga" — the definitive macron case.

### LT — Lithuania

- [ ] `Vilnius` — `bare_city_global` — MED — also "Vilna" (historical); county same-name.
- [ ] `Kaunas` — `bare_city_global` — MED — also "Kovno" (historical).

### PL — Poland

- [ ] `Warszawa` — `exonym_script` — HIGH — "Warszawa" vs "Warsaw"; also "Warszawa" vs "Warszawa-Okęcie" airport-name ambiguity.
- [ ] `Kraków` — `exonym_script` — HIGH — "Kraków" vs "Krakow" (drop) vs "Cracow" (historical English).
- [ ] `ul. Marszałkowska 4, Warszawa` — `pl_ulica` — MED — "ul." abbrev + diacritics.

### CZ — Czechia

- [ ] `Praha` — `exonym_script` — HIGH — "Praha" vs "Prague"; also "Praha 1" district forms.
- [ ] `České Budějovice` — `exonym_script` — MED — vs "Budweis" (German); vs "České Budějovice" vs "Č. Budějovice" abbrev.

### SK — Slovakia

- [ ] `Bratislava` — `exonym_script` — MED — vs "Pressburg"/"Pozsony" (historical trilingual city).
- [ ] `Košice` — `bare_city_global` — MED — diacritics; vs "Kaschau" (historical).

### HU — Hungary

- [ ] `Budapest` — `bare_city_global` — HIGH — also "Budapest XIII" district forms; namesake: Budapest, Hungary only (VERIFY US).
- [ ] `Győr` — `diacritic_script` — MED — "Győr" vs "Gyor" drop; vs "Raab" (German).

### RO — Romania

- [ ] `București` — `exonym_script` — HIGH — "București" vs "Bucharest"; diacritic-dropped "Bucuresti" also common.
- [ ] `Cluj-Napoca` — `renamed_city` — MED — hyphenated compound; "Cluj" alone still common; "Kolozsvár" historical.

### BG — Bulgaria

- [ ] `София` — `script_variant` — HIGH — Cyrillic "София" vs Latin "Sofia" — the script-pair case.
- [ ] `Пловдив` — `script_variant` — MED — vs "Plovdiv"; also "Philippopolis" historical.

### RS — Serbia

- [ ] `Beograd` — `exonym_script` — MED — "Beograd" vs "Belgrade"; also "Београд" Cyrillic.
- [ ] `Нови Сад` — `script_variant` — MED — Cyrillic "Нови Сад" vs Latin "Novi Sad" — official dual-script.

### HR — Croatia

- [ ] `Zagreb` — `bare_city_global` — MED — also "Agram" (historical German).
- [ ] `Rijeka` — `exonym_script` — MED — vs "Fiume" (Italian historical); county same-name.

### BA — Bosnia and Herzegovina

- [ ] `Sarajevo` — `bare_city_global` — MED — also "Сарајево" Cyrillic (official dual script).
- [ ] `Mostar` — `bare_city_global` — MED.

### ME — Montenegro

- [ ] `Podgorica` — `renamed_city` — MED — ex-"Titograd" (1946–1992); old name persists in old data.
- [ ] `Cetinje` — `bare_city_global` — MED — the historical royal capital — two-capital class.

### MK — North Macedonia

- [ ] `Skopje` — `script_variant` — MED — "Скопје" vs "Skopje"; "Scupi" historical; country rename "Macedonia"→"North Macedonia" (2019) churn.
- [ ] `Ohrid` — `bare_city_global` — MED — also "Ohrid" vs "Охрид".

### AL — Albania

- [ ] `Tirana` — `spelling_variant` — MED — "Tirana" vs "Tiranë" (definite form); "Tirane" drop.
- [ ] `Durrës` — `spelling_variant` — MED — "Durrës" vs "Durres" vs "Durazzo" (Italian).

### GR — Greece

- [ ] `Athens` — `exonym_script` — HIGH — "Athens" vs "Αθήνα" vs "Athina" (transliteration) — the triple.
- [ ] `Thessaloniki` — `exonym_script` — MED — vs "Θεσσαλονίκη" vs "Salonica" (historical).
- [ ] `Piraeus` — `exonym_script` — MED — "Piraeus" vs "Πειραιάς" vs "Peiraias".

### MT — Malta

- [ ] `Valletta` — `bare_city_global` — MED — also "Il-Belt Valletta" (Maltese); "Valleta" misspelling.
- [ ] `Triq ir-Repubblika, Valletta` — `mt_triq` — MED — the "Triq" street prefix; Maltese street names.

### AD — Andorra

- [ ] `Andorra la Vella` — `city_country_same` — MED — capital vs country prefix; "Andorra" bare must not collapse to the country.
- [ ] `Les Escaldes` — `bare_city_global` — MED — "Escaldes-Engordany" parish; "Les Escaldes" alone common.

### LI — Liechtenstein

- [ ] `Vaduz` — `bare_city_global` — MED — no-street-in-part town; also "Vaduz" vs "Vaduz" municipality.
- [ ] `Schaan` — `bare_city_global` — MED — the largest municipality (≠ capital).

### LU — Luxembourg

- [ ] `Luxembourg` — `city_country_same` — HIGH — capital and country same string — the definitive case; must resolve to the city.
- [ ] `Esch-sur-Alzette` — `bare_city_global` — MED — hyphenated compound; "Esch" alone is common shorthand.

### MC — Monaco

- [ ] `Monaco` — `city_country_same` — HIGH — city-state; also "Monte Carlo" vs "Monte-Carlo" hyphen variant.
- [ ] `Monte-Carlo` — `spelling_variant` — MED — the quarter; "Monte Carlo" un-hyphenated is the common input.

### SM — San Marino

- [ ] `San Marino` — `city_country_same` — HIGH — capital and country same string.
- [ ] `Serravalle` — `bare_city_global` — MED — namesake: Serravalle, Italy (many) — the largest municipality (≠ capital).

### VA — Vatican

- [ ] `Vatican City` — `city_country_same` — MED — "Vatican City" vs "Città del Vaticano" vs "Vaticano".

### CH — Switzerland (covered 1 — upgrades)

- [ ] `Zürich` — `diacritic_script` — HIGH — "Zürich" vs "Zurich" drop (already guards the exonym fold — extend to canton same-name).
- [ ] `Basel` — `exonym_script` — MED — "Basel" vs "Bâle" (FR) vs "Basle" (old EN).
- [ ] `Bürgenstock` — `no_street_locality` — MED — the hotel-resort locality with NO street — locality-only resolution.

### AT — Austria (covered 1 — upgrades)

- [ ] `Wien` — `exonym_script` — HIGH — "Wien" vs "Vienna"; state same-name.
- [ ] `Linz` — `bare_city_global` — MED — namesake: Linz, Germany (Rhineland-Palatinate).

### DE — Germany (covered 2 — upgrades)

- [ ] `Frankfurt` — `bare_city_namesake` — HIGH — "Frankfurt" bare vs "Frankfurt am Main" (750k) vs "Frankfurt (Oder)" (58k) — the definitive German namesake pair.
- [ ] `München` — `exonym_script` — HIGH — "München" vs "Munich"; "Munchen" drop common.

### NL — Netherlands

- [ ] `Den Haag` — `exonym_script` — HIGH — "Den Haag"/"'s-Gravenhage"/"The Hague" — the definitive triple.
- [ ] `Rotterdam` — `bare_city_namesake` — HIGH — namesake: Rotterdam, NY (the #833 class).

### BE — Belgium

- [ ] `Antwerpen` — `exonym_script` — HIGH — "Antwerpen"/"Anvers"/"Antwerp" — bilingual-country triple.
- [ ] `Brussel` — `exonym_script` — HIGH — "Brussel"/"Bruxelles"/"Brussels" — the definitive bilingual-capital case.

### FR — France (covered 36 — skip; the corpus owns FR)

### GB — UK (covered 54 — upgrades)

- [ ] `Derry` — `renamed_city` — HIGH — "Derry" vs "Londonderry" — the naming-dispute pair (official = Londonderry, common = Derry).
- [ ] `Londonderry` — `renamed_city` — HIGH — the mirror entry; must resolve to the SAME place as "Derry".

### IE — Ireland (covered 11 — upgrade)

- [ ] `Cork` — `bare_city_global` — MED — "Cork" vs "Corcaigh" (Irish); county/city same-name.

### ES — Spain (covered 7 — upgrades)

- [ ] `Donostia` — `exonym_script` — HIGH — "Donostia" vs "San Sebastián" (Basque/Spanish bilingual).
- [ ] `Girona` — `spelling_variant` — MED — "Girona" vs "Gerona" (Catalan/Spanish spelling pair).
- [ ] `A Coruña` — `spelling_variant` — MED — "A Coruña"/"La Coruña"/"Corunna" — three-spelling case.

### PT — Portugal

- [ ] `Lisboa` — `exonym_script` — HIGH — "Lisboa" vs "Lisbon".
- [ ] `Porto` — `exonym_script` — HIGH — "Porto" vs "Oporto" (historical English "the Oporto" mis-split).
- [ ] `Braga` — `bare_city_global` — MED — also "Bracara Augusta" historical.

### IT — Italy (covered 1 — upgrades)

- [ ] `Venezia` — `exonym_script` — HIGH — "Venezia" vs "Venice"; also "Veneto" region confusion.
- [ ] `Via Roma, Torino` — `street_name_homonym` — HIGH — "Via Roma" exists in EVERY Italian town — the definitive street-homonym class (the fr street_name_homonym sibling).
- [ ] `Milano` — `exonym_script` — HIGH — "Milano" vs "Milan".

### UA — Ukraine

- [ ] `Kyiv` — `renamed_city` — HIGH — "Kyiv"/"Kiev"/"Київ" — THE post-2022 spelling case; gazetteer may carry "Kiev".
- [ ] `Lviv` — `spelling_variant` — MED — "Lviv"/"Lwów"/"Lvov" — the trilingual spelling.
- [ ] `Kharkiv` — `spelling_variant` — MED — "Kharkiv"/"Kharkov" (Russian transliteration).

### BY — Belarus

- [ ] `Minsk` — `script_variant` — MED — "Мінск" (Belarusian) vs "Minsk" vs "Минск" (Russian).
- [ ] `Brest` — `bare_city_namesake` — HIGH — namesake: Brest, France (Brittany) — the definitive cross-country pair.

### MD — Moldova

- [ ] `Chișinău` — `diacritic_script` — HIGH — "Chișinău"/"Chisinau"/"Kishinev" — diacritic-drop class.

### RU — Russia

- [ ] `Saint Petersburg` — `renamed_city` — HIGH — "Saint Petersburg"/"St. Petersburg"/"Leningrad"/"Петербург" — the quadruple; also "Petersburg" abbrev.
- [ ] `Moscow` — `exonym_script` — HIGH — "Moscow"/"Moskva"/"Москва"; also "Moskau".

### XK — Kosovo

- [ ] `Pristina` — `spelling_variant` — MED — "Pristina"/"Priština"/"Prishtinë" — four-spelling case; recognition-churn admin.
- [ ] `Prizren` — `bare_city_global` — MED.

### GL — Greenland

- [ ] `Nuuk` — `renamed_city` — MED — ex-"Godthåb" (1979); both in gazetteers.
- [ ] `Sisimiut` — `bare_city_global` — MED — ex-"Holsteinsborg".

---

## Americas

### CA — Canada (covered 4 — upgrades)

- [ ] `Montréal` — `diacritic_script` — HIGH — "Montréal" vs "Montreal" drop — the definitive Canadian diacritic case.
- [ ] `Québec` — `diacritic_script` — HIGH — "Québec" vs "Quebec"; city vs province same-name; also "Québec City".
- [ ] `Toronto` — `renamed_city` — HIGH — ex-"York" (1834) — renamed-class.

### US — US (covered 33 — skip; owned)

### MX — Mexico (covered 5 — upgrades)

- [ ] `Ciudad de México` — `renamed_city` — HIGH — "Ciudad de México"/"Mexico City"/"CDMX" — the renamed-federal-district (2016) triple.

### GT — Guatemala

- [ ] `Guatemala City` — `bare_city_same_admin` — MED — "Guatemala City" vs "Guatemala" department/country — same-name chain.
- [ ] `Antigua Guatemala` — `spelling_variant` — MED — "Antigua Guatemala" vs "Antigua" (shorthand) — the short-form trap.

### BZ — Belize

- [ ] `Belize City` — `city_country_same` — HIGH — "Belize City" vs "Belize" country/district — the definitive triple-same-name; former capital.
- [ ] `Belmopan` — `bare_city_global` — MED — the actual capital since 1970 — capital-vs-largest class.

### SV — El Salvador

- [ ] `San Salvador` — `bare_city_same_admin` — MED — city vs "San Salvador Department" same-name.
- [ ] `Santa Ana` — `bare_city_namesake` — HIGH — namesake: Santa Ana, CA (the #833 class).

### HN — Honduras (covered 2 — upgrades)

- [ ] `San Pedro Sula` — `bare_city_global` — MED — two-word; the largest city (≠ capital Tegucigalpa).

### NI — Nicaragua (covered 2 — skip)

### CR — Costa Rica (covered 2 — upgrades)

- [ ] `San José` — `bare_city_same_admin` — HIGH — city vs "San José Province"; namesake: San Jose, CA — the double-trap.

### PA — Panama

- [ ] `Panama City` — `city_country_same` — HIGH — "Panama City"/"Panamá"/"Panama" — country/city/province same-name; also "Panama City" FL namesake.
- [ ] `Colón` — `bare_city_same_admin` — MED — "Colón" city vs "Colón Province" same-name; diacritic.

### CU — Cuba

- [ ] `La Habana` — `exonym_script` — MED — "La Habana" vs "Havana"; also "Habana" alone.
- [ ] `Santiago de Cuba` — `bare_city_namesake` — HIGH — "Santiago" short-form vs Santiago, Chile/Dominican Republic — the santiago_class.

### JM — Jamaica

- [ ] `Kingston` — `bare_city_same_admin` — HIGH — parish/city same-name; namesake: Kingston NY/ON/UK — the triple.
- [ ] `Montego Bay` — `bare_city_global` — MED — "MoBay" abbrev-trap; two-word.

### HT — Haiti

- [ ] `Port-au-Prince` — `bare_city_global` — MED — hyphenated compound; also "Pòtoprens" (Haitian Creole).
- [ ] `Cap-Haïtien` — `diacritic_script` — MED — diacritics; also "Cap Haitien" / "Le Cap".

### DO — Dominican Republic

- [ ] `Santiago` — `bare_city_namesake` — HIGH — short-form of "Santiago de los Caballeros" vs Santiago, Chile/Cuba — the santiago_class.
- [ ] `Santo Domingo` — `bare_city_same_admin` — MED — city vs "Santo Domingo" province; also "Santo Domingo Este" suburb (the split).

### TT — Trinidad and Tobago

- [ ] `Port of Spain` — `spelling_variant` — MED — "Port of Spain" vs "Port-of-Spain" hyphen — the definitive pair.
- [ ] `San Fernando` — `bare_city_namesake` — MED — namesake: San Fernando, CA (the #833 class).

### AG — Antigua and Barbuda

- [ ] `St. John's` — `abbrev_trap` — HIGH — "St. John's"/"Saint John's"/"St Johns" — abbrev-expansion + namesake: St. John's, NL (Canada) — the definitive pair.

### BS — Bahamas

- [ ] `Nassau` — `bare_city_namesake` — HIGH — namesake: Nassau, NY (and Nassau County NY) — the definitive pair.
- [ ] `Freeport` — `bare_city_namesake` — MED — namesake: Freeport NY/TX/IL/ME — generic-name class.

### BB — Barbados

- [ ] `Bridgetown` — `bare_city_global` — MED — also "The City" (local); parish-level forms.

### BM — Bermuda (covered 1 — upgrade)

- [ ] `Hamilton` — `bare_city_namesake` — HIGH — namesake: Hamilton ON/NZ/UK… — the definitive Bermuda case; also "Hamilton Parish" vs "City of Hamilton".

### GD — Grenada

- [ ] `St. George's` — `abbrev_trap` — MED — "St. George's" vs "Saint George's" vs "St George" — abbrev class; also the Bermuda "St. George's" namesake.

### GU — Guam

- [ ] `Hagåtña` — `renamed_city` — HIGH — ex-"Agana" (1998); "Agana" still everywhere — the definitive rename.

### VI — US Virgin Islands (covered 3 — skip)

### VG — British Virgin Islands (covered 1 — skip)

### PR — Puerto Rico (covered 4 — skip)

### AW — Aruba

- [ ] `Oranjestad` — `bare_city_namesake` — HIGH — namesake: Oranjestad, Sint Eustatius — the definitive twin; also "Orange Town".

### CW — Curaçao

- [ ] `Willemstad` — `bare_city_global` — MED — also "Willemstad, North Brabant" (Netherlands) namesake.

### SX — Sint Maarten

- [ ] `Philipsburg` — `bare_city_namesake` — HIGH — namesake: Philipsburg, Montana/PA — the #833 class.
- [ ] `Sint Maarten` vs `Saint Martin` — `split_island` — MED — the island is half-Dutch/half-French; same-name pair.

### BQ — Bonaire, Sint Eustatius, Saba

- [ ] `Kralendijk` — `bare_city_global` — MED — diacritic-drop "Kralendijk" vs "Kralendyk" (old).

### KY — Cayman Islands

- [ ] `George Town` — `spelling_variant` — HIGH — "George Town" vs "Georgetown" — the definitive spelling pair (shared with MY/GY/CA).

### TC — Turks and Caicos

- [ ] `Cockburn Town` — `bare_city_global` — MED — the "Cockburn" pronunciation trap (CO-burn); also "Cockburn Town" vs "Cockburn Harbour" (two towns!).

### AI — Anguilla

- [ ] `The Valley` — `article_toponym` — MED — THE definitive "The " article-led capital.

### MS — Montserrat

- [ ] `Plymouth` — `abandoned_capital` — MED — the volcano-abandoned capital (1997); "Plymouth" namesake: Plymouth UK/MA — the quadruple trap.
- [ ] `Brades` — `renamed_city` — MED — the de facto capital since 1997; no official designation.

### KN — Saint Kitts and Nevis

- [ ] `Basseterre` — `bare_city_namesake` — HIGH — namesake/spelling-twin: Basse-Terre, Guadeloupe — the definitive pair.

### LC — Saint Lucia

- [ ] `Castries` — `bare_city_global` — MED — also "Castries, Hérault" (France) namesake.

### VC — Saint Vincent and the Grenadines

- [ ] `Kingstown` — `spelling_variant` — MED — "Kingstown" vs "Kingston" — the definitive spelling pair.

### DM — Dominica

- [ ] `Roseau` — `bare_city_namesake` — MED — namesake: Roseau, Minnesota.

### GY — Guyana

- [ ] `Georgetown` — `bare_city_namesake` — HIGH — THE mega-namesake (Georgetown KY/TX/ON/Penang/Ascension…) — must win in GY.

### SR — Suriname

- [ ] `Paramaribo` — `bare_city_global` — MED — also "Paramaribo District" same-name.
- [ ] `Wanica` — `bare_city_global` — MED — district; "Lelydorp" the district capital.

### GF — French Guiana

- [ ] `Cayenne` — `bare_city_global` — MED — also "Cayenne" spice-name trap (toponym vs noun).

### VE — Venezuela

- [ ] `Caracas` — `bare_city_same_admin` — MED — city vs "Distrito Capital" same-name; also "Santiago de León de Caracas" full name.
- [ ] `Maracaibo` — `bare_city_same_admin` — MED — city vs "Zulia" state (capital-city ≠ state-name pair).

### CO — Colombia

- [ ] `Bogotá` — `spelling_variant` — HIGH — "Bogotá" vs "Bogota" drop; city vs "Bogotá D.C." — no-postal-country note.
- [ ] `Medellín` — `spelling_variant` — MED — "Medellín" vs "Medellin" drop; city vs "Antioquia" state pair.

### EC — Ecuador

- [ ] `Quito` — `bare_city_same_admin` — MED — city vs "Pichincha" province; "Quito" vs "San Francisco de Quito" full.
- [ ] `Guayaquil` — `bare_city_same_admin` — MED — city vs "Guayas" province.

### PE — Peru

- [ ] `Lima` — `bare_city_same_admin` — MED — city vs "Lima Province"/"Lima Region" — the double-same-name.
- [ ] `Cusco` — `spelling_variant` — MED — "Cusco" vs "Cuzco" — the definitive spelling pair; also "Qosqo" (Quechua).

### BO — Bolivia

- [ ] `La Paz` — `bare_city_same_admin` — MED — city vs "La Paz Department" same-name; namesake: La Paz, Mexico/Baja California Sur.
- [ ] `Sucre` — `two_capitals` — HIGH — constitutional capital (La Paz is seat of government) — the two-capital class; "Sucre" vs "Chuquisaca" department pair.

### PY — Paraguay

- [ ] `Asunción` — `diacritic_script` — MED — "Asunción" vs "Asuncion" drop; also "Nuestra Señora Santa María de la Asunción" full name.

### UY — Uruguay

- [ ] `Montevideo` — `bare_city_global` — MED — also "Montevideo Department" same-name.
- [ ] `Maldonado` — `bare_city_same_admin` — MED — city vs "Maldonado Department".

### CL — Chile

- [ ] `Santiago` — `bare_city_namesake` — HIGH — THE santiago_class: Santiago de Chile vs Santiago de Compostela (ES) vs Santiago de Cuba vs Santiago de los Caballeros (DO) — the definitive four-way.
- [ ] `Santiago de Chile` — `compound_city` — MED — the disambiguated form must also work.

### AR — Argentina

- [ ] `Buenos Aires` — `bare_city_same_admin` — HIGH — city vs "Buenos Aires Province" same-name — the definitive pair; also "Ciudad Autónoma de Buenos Aires" (CABA) full.
- [ ] `Rosario` — `bare_city_namesake` — HIGH — namesake: Rosario, California — the #833 class.

### BR — Brazil

- [ ] `São Paulo` — `bare_city_same_admin` — HIGH — city vs "São Paulo State" — the definitive same-name pair (11M vs 44M).
- [ ] `Rio de Janeiro` — `bare_city_same_admin` — HIGH — city vs state same-name (the #1023 class).
- [ ] `Rua Augusta 1000, Cerqueira César, São Paulo – SP` — `br_rua_bairro` — MED — bairro + UF suffix structure; "– SP" state abbrev.

### FK — Falkland Islands

- [ ] `Stanley` — `bare_city_namesake` — MED — namesake: Stanley, Idaho/ND/WV — the #833 class; also "Port Stanley".

### GS — South Georgia

- [ ] `King Edward Point` — `bare_city_global` — MED — the research-station capital; no civilian addressing.

### PM — Saint Pierre and Miquelon

- [ ] `Saint-Pierre` — `bare_city_namesake` — MED — namesake: Saint-Pierre, Réunion; "Saint-Pierre-et-Miquelon" country compound.

---

## Oceania

### AU — Australia (covered 2 — upgrades)

- [ ] `Canberra` — `bare_city_same_admin` — HIGH — city vs "Australian Capital Territory" — the designed-capital disambiguation; also "Canberra" vs "ACT" abbrev.
- [ ] `Geelong` — `bare_city_global` — MED — namesake: Geelong, none (VERIFY); the second-Victoria-city class.

### NZ — New Zealand

- [ ] `Wellington` — `bare_city_namesake` — HIGH — namesake: Wellington FL/OH/CO — the #833 class.
- [ ] `Christchurch` — `bare_city_namesake` — HIGH — namesake: Christchurch, Dorset (UK) — cross-country pair.
- [ ] `Auckland` — `exonym_script` — MED — "Auckland" vs "Tāmaki Makaurau" (Māori official).

### PG — Papua New Guinea

- [ ] `Port Moresby` — `bare_city_global` — MED — "Port Moresby" vs "Moresby" abbrev-trap; also "National Capital District".
- [ ] `Lae` — `bare_city_namesake` — MED — namesake: Lae, Marshall Islands.

### FJ — Fiji

- [ ] `Suva` — `bare_city_global` — MED — namesake: Suva, none (VERIFY).
- [ ] `Nadi` — `spelling_variant` — MED — "Nadi" vs "Nandi" (old spelling) — the definitive pair.

### SB — Solomon Islands

- [ ] `Honiara` — `bare_city_global` — MED.
- [ ] `Guadalcanal` — `island_province_same` — MED — island/province same-name; "Guadalcanal" also a Spanish town (Seville).

### VU — Vanuatu

- [ ] `Port Vila` — `bare_city_global` — MED — also "Vila"; "Port-Vila" hyphen variant.
- [ ] `Efate` — `island_province_same` — MED — island/province same-name (Port Vila is on Efate).

### NC — New Caledonia

- [ ] `Nouméa` — `diacritic_script` — MED — "Nouméa" vs "Noumea" drop.

### PF — French Polynesia

- [ ] `Papeete` — `apostrophe_trap` — MED — "Papeete" vs "Pape'ete" okina — the definitive okina case.

### WS — Samoa

- [ ] `Apia` — `bare_city_global` — MED — also "Apia" vs "Āpia" macron.
- [ ] `Salelologa` — `bare_city_global` — MED — the Savai'i main town.

### TO — Tonga

- [ ] `Nukuʻalofa` — `apostrophe_trap` — MED — "Nukuʻalofa" vs "Nuku'alofa" vs "Nukualofa" — okina case.

### KI — Kiribati

- [ ] `Tarawa` — `atoll_admin_same` — MED — atoll/island/council same-name; "South Tarawa" the capital vs "Tarawa" the atoll — the definitive pair.
- [ ] `Bairiki` — `bare_city_global` — MED — the islet capital on South Tarawa.

### NR — Nauru

- [ ] `Yaren` — `district_capital` — MED — the district-as-capital (no city); "Yaren" vs "Yaren District".

### TV — Tuvalu

- [ ] `Funafuti` — `atoll_admin_same` — MED — atoll/island same-name; the whole country is 9 atolls — the definitive small-state class.
- [ ] `Fongafale` — `bare_city_global` — MED — the islet that holds the capital (Vaiaku).

### MH — Marshall Islands

- [ ] `Majuro` — `atoll_admin_same` — MED — atoll/town/municipality same-name.
- [ ] `Delap-Uliga-Darrit` — `compound_capital` — MED — THE "DUD" triple-town capital — three contiguous islets as one city; structurally unique.

### FM — Micronesia

- [ ] `Palikir` — `capital_small` — MED — the ~5k-pop capital on Pohnpei; "Palikir" vs "Pohnpei" state pair.
- [ ] `Pohnpei` — `island_state_same` — MED — state/island same-name.

### PW — Palau

- [ ] `Koror` — `bare_city_global` — MED — state/town same-name; the old capital.
- [ ] `Ngerulmud` — `renamed_city` — MED — the capital since 2006 — the "nobody knows the capital" class; must not fall back to Koror.

### CK — Cook Islands

- [ ] `Rarotonga` — `island_admin_same` — MED — island/district same-name.
- [ ] `Avarua` — `bare_city_global` — MED — the capital district on Rarotonga.

### NU — Niue

- [ ] `Alofi` — `village_island_same` — MED — village/island same-name; also "Alofi North/South" split.

### TK — Tokelau

- [ ] `Fakaofo` — `atoll_admin_same` — MED — atoll/village; the "capital" (each atoll has its own).

### WF — Wallis and Futuna

- [ ] `Mata-Utu` — `diacritic_script` — MED — "Mata-Utu" vs "Matā'Utu" okina; also "Mata Utu" un-hyphenated.

### AS — American Samoa

- [ ] `Pago Pago` — `bare_city_global` — MED — the "Pango Pango" mispronunciation/misspelling pair; also "Pago Pago" vs "Pago" (village).

### MP — Northern Mariana Islands

- [ ] `Saipan` — `island_admin_same` — MED — island/municipality same-name.
- [ ] `Susupe` — `bare_city_global` — MED — the de facto admin center (≠ capital Chalan Kanoa).

---

## Covered-country gaps worth filling (single high-value entries)

- [ ] `Wellington, FL` — US — the reverse-namesake guard (US town that shadows the NZ capital) — complements the corpus's #905-class entries.
- [ ] `Georgetown, Penang` — MY — the George Town/Georgetown spelling pair, both directions.
- [ ] `Basse-Terre, Guadeloupe` — GP — the twin of kn Basseterre; also "Basse-Terre" vs "Basse-Terre Island".

---

## Summary

- **~160 new countries** proposed; **~30 already covered** (GB/FR/US/IE/ES/SI/MX/CA/PR/IN/IM/VI/GE/AU/DE/BD/BM/CR/NI/LB/AT/CH/FI/JP/IT/FO/IS/TH/VG) get **upgrade entries only** where the corpus lacks the class (renamed-city, exonym, same-name-admin).
- The three dominant proposed classes mirror the corpus's own proven bug history: bare-capital/namesake (~35%), exonym/renamed/script (~40%), structural dialect (~25%).
- **Every entry requires pipeline verification before promotion** — promote failures to `regression.ts` as `improvement_target`; route passes to `holdout.ts` (generalization evidence). Coordinates stay unasserted until the resolver is measured.
