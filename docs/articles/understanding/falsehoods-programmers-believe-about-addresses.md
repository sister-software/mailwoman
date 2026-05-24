---
sidebar_position: 24
title: Falsehoods programmers believe about addresses
---

# Falsehoods programmers believe about addresses

Every address parser starts with assumptions. Most of them are wrong. This article collects the falsehoods that consistently break parsers, validators, databases, and form fields — curated from real-world counterexamples and the project's own failure-mode catalogue.

If you are building anything that touches addresses, read this list. If you are not, read it anyway — it's a masterclass in how messy real-world data is.

## Numbers

### "A building number will be all-numeric."

Counterexample: `1A Egmont Road, Middlesbrough, TS4 2HT`. Also `4-5 Bonhill Street, London, EC2A 4BX` (ranges). And `43rd ½ St, Pittsburgh, PA` (fractions — written in unicode as ½, as `43 1/2`, or as `43.5`). And `1313 1/2 Railroad Ave, Bellingham, WA 98225-4729`.

### "No buildings are numbered zero."

Counterexample: `0 Egmont Road, Middlesbrough, TS4 2HT`.

### "Well, at least no buildings have negative numbers."

Counterexample: `Minusone Priory Road, Newbury, RG14 7QS`. No database renders this as `-1` — it's literally the word "Minusone."

### "A building number will only be used once per street."

The difference between `50 Ammanford Road, Tycroes, Ammanford, SA18 3QJ` and `50 Ammanford Road, Llandybie, Ammanford, SA18 3YF` is about 4 miles. Same street name, different towns.

### "The number of buildings is the difference between highest and lowest building numbers."

Buildings may be numbered by distance from the start of the road: in Antibes, France and rural Finland, `Longroad 65` means the building 750 meters from the start of Longroad. Numbers can also skip (even numbers on one side, odd on the other), be reused (new construction on a filled-in lot), or be assigned to multiple buildings sharing the same number.

### "If the addresses on the left of the road are even, the addresses on the right must be odd."

Counterexample: Boulevard Théophile Sueur, Montreuil, Seine-Saint-Denis, France has evens-only on both sides. The two sides are also in different cities and Départements.

### "A building will only have one number."

Counterexample from Hong Kong: `15/F, Cityplaza 3, 14 TaiKoo Wan Road, Island East, HKSAR` — the building is number 14 on the road and number 3 in its group of buildings.

### "When there's a building name, there won't be a building number (or vice-versa)."

Counterexample: `Flat 1.4, Ziggurat Building, 60-66 Saffron Hill, London, EC1N 8QX`. Has a flat number, a building name, and a building number range.

### "A building name won't also be a number."

Counterexample: `Ten Post Office Sq, Boston MA 02109` — which is not the same as `10 Post Office Sq, Boston MA 02109`. One is spelt out, one is a digit. Different buildings.

### "Well, at least you can omit leading zeros."

Counterexample: `101 Alma St, Apartment 001, Palo Alto` — apartments 1 and 001 were on different floors.

### "A street with a building A will not also have a building Alpha."

Counterexample: `14100 N 46th St., Alpha 39, Tampa, FL 33613` — a condo association with blocks A through Z then Alpha, Beta, Gamma, Delta, and Theta. Mail was routinely misrouted from block Alpha to block A and vice-versa.

## Street names

### "A street name won't include a number."

Counterexample: `8 Seven Gardens Burgh, WOODBRIDGE, IP13 6SU`. Also `Plein 1944, Nijmegen, Netherlands` — streets can be numbered.

### "When there's a numbered street and a house number, there will be a separator between them."

Counterexample from the Netherlands: `Gondel 2695, Lelystad` — area Gondel, street 26, number 95. No separator.

### "Street names always end in descriptors like 'street', 'avenue', 'drive', 'square', 'hill' or 'view'."

Counterexample: `Piccadilly, London, W1J 9PN`.

### "OK, but when they do have a descriptor there will only be one."

A street name can be entirely descriptors: `17 Hill Street, London, W1J 5LJ` or `Avenue Road, Toronto, Ontario`.

### "OK, but when they do have a descriptor it will be at the end."

French addresses use prefix descriptors: `rue de Rivoli`, `avenue des Champs-Élysées`, `place de la Concorde`.

### "OK, but at the very least you wouldn't name a town Street."

There is a town called Street in Somerset, UK.

### "Street names don't recur in the same city."

London has High Street in W3, W5, N8, SE25, E13, E17, NW10, N1, E1, NW1, W14, SE13, SW19, E11, SW19 again, and E6. Seventeen different High Streets, all in London. Without a postcode, the street name is useless.

### "A road will only have one name."

The A1 in the UK is a 410-mile road composed of Goswell Road, Regent Road, and dozens of other named segments. Multiple buildings numbered 1 exist on different segments of the A1.

### "Addresses will only have one street."

The Royal Mail supports "dependent streets": `6 Elm Avenue, Runcorn Road, Birmingham, B12 8QX`. Runcorn Road is the main street; Elm Avenue is a stub that isn't unique within the city.

## Postcodes

### "Zip codes don't start with a zero."

Counterexamples: `02109` (Boston, MA), `07737` (Jena, Germany), `0800` (Darwin, Australia), `00002` (Helsinki, Finland). Brazilian and Israeli postcodes also start with zero.

### "A zip code corresponds to a single city."

ZIP code 33334 covers three cities: Oakland Park, Wilton Manors, and Fort Lauderdale — all in Florida.

### "A single postcode will be larger than a single building."

The Empire State Building has its own ZIP code: 10118. In the UK, DVLA Swansea uses `SA99 1BA` for V5C processing, `SA99 1AB` for driving licences — different postcodes for different departments in the same building. The London Borough of Enfield uses five postcodes for five departments.

### "A single postcode will only cover a few tens of addresses."

The University of Warwick uses `CV4 7AL` — one postcode for 6,000 students living on campus. French postcode `75015` covers the XVth arrondissement of Paris with over 230,000 people.

## Administrative hierarchy

### "An address will include a state."

Counterexample: Any address in the United Kingdom. Also Belgium: `Boulevard Frère Orban, 27, 4000 Liège` — no county, no region, just street, postcode, city.

### "An address will have a county."

The Royal Mail stopped using postal counties in 1996. Belgium, Norway, and many other countries don't use them.

### "An address requires both a city and a country."

Singapore is a city-state. Addresses can look like `Singapore, Singapore` — or `Singapore, Singapore, Singapore` if you demand city, county, and country.

### "You can't have two towns with the same name in the same country."

The UK has three Newports. The Netherlands has two cities called Eursinge — in the same province.

### "The address from the postal service database is sufficient to deliver mail."

People in new blocks of flats and houseboats in boatyards sometimes need to prefix their official address with a boat name or flat number for the delivery to find them. The postal database doesn't capture these informal additions.

## Format and characters

### "Addresses don't contain commas, apostrophes, hyphens, ampersands, dots or exclamation marks."

Counterexamples: `St. Judes & St. Pauls C of E (Va) Primary School, 10 Kingsbury Road, London, N1 4AZ`, `1 Acre View, Bo'ness, EH51 9RQ`, `1 Highview Terrace, Westward Ho!, Bideford, EX39 1AQ`, `Flat 1.4, Ziggurat Building, 60-66 Saffron Hill, London, EC1N 8QX`.

### "Addresses will be written in ASCII or at least Latin characters."

The Greek tax office: `Χανδρή 1 & Θεσσαλονίκης, Τ.Κ. 18346, Αθήνα`. International mail may include the country name in both source and destination character sets.

### "OK, but they'll either be in ascending or descending specificity."

Hungarian addresses use different orders depending on available lines. One line: `{zip} {town}, {street} {buildingNr}`. Multiple lines: `{street} {buildingNr}. {zip} {town}, {country}`. An envelope: `{street} {buildingNr}. {town} {zip} {country}`. Three different orders for the same address.

Japanese addresses go from prefecture to city to ward to district to sub-district to block to lot — the opposite of Western "specific to general" ordering: `〒100-8994 東京都 中央区 八重洲一丁目 5番3号 東京中央郵便局`.

### "Building numbers appear before street names."

In the Netherlands: `Plein 1944 85 D` — street name first, building number after. In Finland: `Kornetintie 6 A II krs` — street, building number, staircase, floor.

### "An address corresponds to the recipient's location."

PO boxes, GPO boxes, locked bags, private bags, parcel lockers, community mail agents, "Care of Post Office," and reply-paid addresses all route to sorting offices and collection points, not to recipients. Santa Claus has postcodes in multiple countries: `H0H 0H0` (Canada), `XM4 5HQ` (UK), `DK-3900 Nuuk` (Germany, routed through Greenland).

## International and edge cases

### "Addresses will have a street."

Japan does not use named streets for most addresses. Buildings are numbered by district, block, and lot: `東京都千代田区丸の内1-1-1`. Rural routes in the US use box numbers on delivery routes: `Box 1234, R.R. 1, Winthrop, ME 04364`.

### "An address will be comprised of road names."

Counterexample: `2 mi N then 3 mi W of Jennings, OK 74038` — received successful deliveries for years. The Very Large Array radio telescope uses `50 miles West of Socorro, New Mexico, USA`. In Nicaragua: `From where the Chinese restaurant used to be, two blocks down, half a block toward the lake, next door to the house where the yellow car is parked, Managua, Nicaragua`.

Mannheim, Germany uses grid coordinates: `Institut für Deutsche Sprache, R 5, 6-13, D-68161 Mannheim` — block R, row 5, buildings 6-13.

### "An address can be expressed with a single country."

Kerguelen Island (French territory in the Indian Ocean): `District de Kerguelen, Terres Australes et Antarctiques Françaises, via la Réunion, France`. Three administrative regions plus a routing indicator.

### "But written addresses don't change."

A condo in Florida changed address three times in a few years: first as `14100 N 46th St., Alpha 39, Lutz, FL 33549`, then Tampa after a new post office, then `FL 33613` after a ZIP change, then `14410 Hanging Moss Circle, #101` after a block-naming scheme change. Same physical location, four different written addresses.

Cities, streets, and entire countries get renamed. The county of Gwent, UK no longer exists. Lenin Street became something else in Eastern Europe. Territory disputes change which administrative region an address is officially in.

### "Real place names won't contain rude words."

Middlesex, Scunthorpe, Penistone, and many others are real English place names. Address validators that filter for profanity reject real places.

## What this means for a parser

The falsehoods converge on a single design principle: **the parser should validate less and surface more.** Every falsehood above is something a programmer hardcoded into a validator and later regretted. A parser that:

- Rejects addresses with leading-zero postcodes → broken for Boston.
- Assumes streets end in a type suffix → broken for Piccadilly.
- Strips "special characters" → broken for `Bo'ness` and `Westward Ho!`.
- Requires a state → broken for every UK address.
- Expects numbers before street names → broken for most of Europe.
- Requires a street → broken for Japan.

The correct posture is to extract what you can identify, flag what you're uncertain about, and let the downstream system decide. A parser that says "I found a postcode at position X, a locality at position Y, and I'm not sure about the rest" is more useful than one that rejects the input because the street doesn't end in "Street."

This is the **graceful failure** principle from `how-mail-delivery-works.md`: the postal system itself handles ambiguity through human intervention. The parser should surface ambiguity, not reject it.

## See also

- [How humans break addresses](./how-humans-break-addresses.md) — the failure taxonomy organized by root cause
- [The database fallacy](./the-database-fallacy.md) — why no database captures all these edge cases
- [What is a postcode?](./what-is-a-postcode.md) — why postcodes aren't polygons and don't start with predictable digits
- [What is an intersection address?](./what-is-an-intersection.md) — why not all addresses have streets
- [How can a building have two addresses?](./how-can-a-building-have-two-addresses.md) — why buildings change addresses
