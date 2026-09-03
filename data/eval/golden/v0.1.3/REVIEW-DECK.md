# Golden street-suffix relabel review deck — v0.1.2 → v0.1.3

> **RULED 2026-08-06 (operator): KEEP every applied split.** The rule, verbatim: "Apply only the TERMINAL
> street suffix. Earlier suffix-like tokens remain part of the street name unless they are the final suffix
> element. Preserve post-directionals separately." Consequences: `Finel Hollow Road` -> street `Finel Hollow` +
> suffix `Road`; `Sutton Hollow` -> street `Sutton` + suffix `Hollow` (Hollow is terminal there); `Stevens Hill W`
> -> street `Stevens` + suffix `Hill` + post-directional `W`. The arrival of a later suffix reverts the earlier
> ambiguous token to the name. Semantically odd remainders (`High Manor`, `East`) stand: the parse reflects
> authoritative segmentation (Pub-28/TIGER), not human intuition, and the formatter is lossless. The model's
> 125-row over-greed is therefore a SUFFIX-BOUNDARY error (recognition is fine; the span extends too far) —
> tracked with its training change in the next-run notes.

Rows are deduped to the top-level files (`dev/` and `test/` carry the same rows).
A flag is a REVIEW TRIGGER, not an adjudication: the split below is already applied.

## Flagged (70) — needs a ruling

| row | before | after | flags | raw |
|---|---|---|---|---|
| us.jsonl:82 | "High Manor Park" | "High Manor" + "Park" | name-prone-suffix | "High Manor Park, VT 05491" |
| us.jsonl:83 | "High Manor Park" | "High Manor" + "Park" | name-prone-suffix | "05491 High Manor Park VT" |
| us.jsonl:84 | "High Manor Park" | "High Manor" + "Park" | name-prone-suffix | "HIGH MANOR PARK VT 05491" |
| us.jsonl:85 | "High Manor Park" | "High Manor" + "Park" | name-prone-suffix | "VT 05491, High Manor Park" |
| us.jsonl:218 | "Adam Hl" | "Adam" + "Hl" | name-prone-suffix | "Adam Hl, VT 05663" |
| us.jsonl:219 | "Adam Hl" | "Adam" + "Hl" | name-prone-suffix | "05663 Adam Hl, VT" |
| us.jsonl:220 | "Adam Hl" | "Adam" + "Hl" | name-prone-suffix | "Adam Hl VT 05663" |
| us.jsonl:233 | "East Rd" | "East" + "Rd" | remainder-is-affix | "East Rd, Wyoming 82431" |
| us.jsonl:234 | "East Rd" | "East" + "Rd" | remainder-is-affix | "82431 East Rd, Wyoming" |
| us.jsonl:394 | "Harrington Heights" | "Harrington" + "Heights" | name-prone-suffix | "Harrington Heights, VT 05761" |
| us.jsonl:395 | "Harrington Heights" | "Harrington" + "Heights" | name-prone-suffix | "Harrington Heights VT 05761" |
| us.jsonl:396 | "Harrington Heights" | "Harrington" + "Heights" | name-prone-suffix | "05761 Harrington Heights VT" |
| us.jsonl:580 | "Sutton Hollow" | "Sutton" + "Hollow" | name-prone-suffix | "Sutton Hollow, VT 05867" |
| us.jsonl:581 | "Sutton Hollow" | "Sutton" + "Hollow" | name-prone-suffix | "05867 Sutton Hollow VT" |
| us.jsonl:582 | "Sutton Hollow" | "Sutton" + "Hollow" | name-prone-suffix | "SUTTON HOLLOW VT 05867" |
| us.jsonl:859 | "Partridge Hill" | "Partridge" + "Hill" | name-prone-suffix | "Partridge Hill, VT 05055" |
| us.jsonl:860 | "Partridge Hill" | "Partridge" + "Hill" | name-prone-suffix | "05055 Partridge Hill VT" |
| us.jsonl:861 | "Partridge Hill" | "Partridge" + "Hill" | name-prone-suffix | "Partridge Hill, VT 05055, USA" |
| us.jsonl:862 | "Partridge Hill" | "Partridge" + "Hill" | name-prone-suffix | "Partridge Hill VT 05055" |
| us.jsonl:863 | "Partridge Hill" | "Partridge" + "Hill" | name-prone-suffix | "VT 05055 Partridge Hill" |
| us.jsonl:989 | "Morse Brook" | "Morse" + "Brook" | name-prone-suffix | "Morse Brook, Vermont 05346" |
| us.jsonl:990 | "Morse Brook" | "Morse" + "Brook" | name-prone-suffix | "05346 Morse Brook, Vermont" |
| us.jsonl:991 | "Morse Brook" | "Morse" + "Brook" | name-prone-suffix | "Morse Brook Vermont 05346" |
| us.jsonl:1038 | "LEXINGTON GREEN" | "LEXINGTON" + "GREEN" | name-prone-suffix | "Lexington Green, VT 05403" |
| us.jsonl:1039 | "LEXINGTON GREEN" | "LEXINGTON" + "GREEN" | name-prone-suffix | "05403 VT Lexington Green" |
| us.jsonl:1040 | "LEXINGTON GREEN" | "LEXINGTON" + "GREEN" | name-prone-suffix | "Lexington Green, VT" |
| us.jsonl:1118 | "Stevens Hill W" | "Stevens" + "Hill W" | name-prone-suffix | "Stevens Hill W, VT 05843" |
| us.jsonl:1119 | "Stevens Hill W" | "Stevens" + "Hill W" | name-prone-suffix | "05843 Stevens Hill W VT" |
| us.jsonl:1120 | "Stevens Hill W" | "Stevens" + "Hill W" | name-prone-suffix | "Stevens Hill W VT 05843" |
| us.jsonl:1121 | "Stevens Hill W" | "Stevens" + "Hill W" | name-prone-suffix | "VT 05843 Stevens Hill W" |
| us.jsonl:1141 | "Baumen Pass" | "Baumen" + "Pass" | name-prone-suffix | "Baumen Pass, WY 82718" |
| us.jsonl:1142 | "Baumen Pass" | "Baumen" + "Pass" | name-prone-suffix | "Baumen Pass, WY 82718, USA" |
| us.jsonl:1143 | "Baumen Pass" | "Baumen" + "Pass" | name-prone-suffix | "82718 Baumen Pass, WY" |
| us.jsonl:1160 | "Morrisville Plz" | "Morrisville" + "Plz" | name-prone-suffix | "Lamoille Health Family Dentistry, 66 Morrisville Plz, Morrisville, VT 05661-4482" |
| us.jsonl:1259 | "Slapp Hill" | "Slapp" + "Hill" | name-prone-suffix | "Hardwick Area Health Center, 4 Slapp Hill, Hardwick, VT 05843-9300" |
| us.jsonl:1359 | "Morrisville Plz" | "Morrisville" + "Plz" | name-prone-suffix | "Lamoille Health Family Dentistry, 66 Morrisville Plz, Morrisville, VT" |
| us.jsonl:1369 | "South St" | "South" + "St" | remainder-is-affix | "Springfield High School Health Center, 303 South St, Springfield, VT 05156-3298" |
| us.jsonl:1409 | "S St" | "S" + "St" | remainder-is-affix | "Springfield High School Health Center, 303 S St, Springfield, VT 05156-3298" |
| us.jsonl:1410 | "S St" | "S" + "St" | remainder-is-affix | "SPRINGFIELD HIGH SCHOOL HEALTH CENTER, 303 S ST, SPRINGFIELD VT 05156-3298" |
| us.jsonl:1413 | "Slapp Hl" | "Slapp" + "Hl" | name-prone-suffix | "Hardwick Area Health Center, 4 Slapp Hl, Hardwick, VT 058439300" |
| us.jsonl:1434 | "South St" | "South" + "St" | remainder-is-affix | "Springfield High School Health Center, 303 South Street, Springfield, Vermont" |
| us.jsonl:1438 | "Slapp Hl" | "Slapp" + "Hl" | name-prone-suffix | "Hardwick Area Health Center, 4 Slapp Hl, Hardwick, VT 05843-9300" |
| us.jsonl:1439 | "Slapp Hl" | "Slapp" + "Hl" | name-prone-suffix | "Hardwick Area Health Center, 4 Slapp Hl, Hardwick, VT" |
| us.jsonl:1500 | "MILL HL" | "MILL" + "HL" | name-prone-suffix | "HIGHGATE PUBLIC, 17 MILL HL, HIGHGATE, VT 05459" |
| us.jsonl:1531 | "VILLAGE GREEN" | "VILLAGE" + "GREEN" | name-prone-suffix | "Roger Clark Memorial, 40 Village Green, Pittsfield, VT 05762" |
| us.jsonl:1534 | "MAIN ST" | "MAIN" + "ST" | venue-context | "ST JOHNSBURY ATHENAEUM, 1171 MAIN ST, ST JOHNSBURY, Vermont" |
| us.jsonl:1639 | "SOUTH ST" | "SOUTH" + "ST" | remainder-is-affix | "Worthen Library, 75 South St, South Hero, VT 05486" |
| us.jsonl:1640 | "SOUTH ST" | "SOUTH" + "ST" | remainder-is-affix | "Worthen Library, 75 South St, South Hero, VT" |
| us.jsonl:1654 | "VILLAGE GREEN" | "VILLAGE" + "GREEN" | name-prone-suffix | "ROGER CLARK MEMORIAL, 40 Village Green, Pittsfield VT" |
| us.jsonl:1727 | "MAIN ST" | "MAIN" + "ST" | venue-context | "St Johnsbury Athenaeum, 1171 Main St, St Johnsbury, VT 05819" |
| us.jsonl:1728 | "MAIN ST" | "MAIN" + "ST" | venue-context | "St Johnsbury Athenaeum, 1171 Main St, St Johnsbury, VT" |
| us.jsonl:1775 | "MAD RIVER PARK" | "MAD RIVER" + "PARK" | name-prone-suffix | "True North Wilderness Programs LLC, 340 Mad River Park, Waitsfield, VT 05673" |
| us.jsonl:1776 | "MAD RIVER PARK" | "MAD RIVER" + "PARK" | name-prone-suffix | "TRUE NORTH WILDERNESS PROGRAMS LLC, 340 MAD RIVER PARK, WAITSFIELD, VT" |
| us.jsonl:1873 | "9TH AVE S SE HUMAN SERVICE CENTER" | "9TH AVE S SE HUMAN SERVICE" + "CENTER" | name-prone-suffix | "Dyan Melton, 2624 9th Ave S SE Human Service Center, Fargo, ND 58103" |
| us.jsonl:1874 | "9TH AVE S SE HUMAN SERVICE CENTER" | "9TH AVE S SE HUMAN SERVICE" + "CENTER" | name-prone-suffix | "Dyan Melton, 2624 9th Ave S SE Human Service Center, Fargo ND" |
| us.jsonl:2601 | "MIDTOWN PLZ MIDTOWN MALL" | "MIDTOWN PLZ MIDTOWN" + "MALL" | name-prone-suffix | "Glover Sharon Alexander, Midtown Plz Midtown Mall, Rochester, NY 14604" |
| us.jsonl:2602 | "MIDTOWN PLZ MIDTOWN MALL" | "MIDTOWN PLZ MIDTOWN" + "MALL" | name-prone-suffix | "Glover Sharon Alexander, Midtown Plz Midtown Mall, Rochester, NY" |
| us.jsonl:2607 | "one lincoln ctr" | "one lincoln" + "ctr" | name-prone-suffix | "Janet H Bliss, One Lincoln Ctr, Syracuse, NY 13202" |
| us.jsonl:2609 | "29 CATHERINE ST" | "29 CATHERINE" + "ST" | venue-context | "St Nicholas Housing Corp, 11 29 Catherine St, Brooklyn, NY 11211" |
| us.jsonl:2629 | "ivy rdg" | "ivy" + "rdg" | name-prone-suffix | "ROBYN L BLANCHARD, 135 IVY RDG, ROCHESTER, NY 14617" |
| us.jsonl:2644 | "RANDALLS ISLAND" | "RANDALLS" + "ISLAND" | name-prone-suffix | "New York Fire Dept, Randalls Island, New York, NY 10035" |
| us.jsonl:2645 | "RANDALLS ISLAND" | "RANDALLS" + "ISLAND" | name-prone-suffix | "NEW YORK FIRE DEPT, RANDALLS ISLAND, NEW YORK, NY 10035, US" |
| us.jsonl:2647 | "RAND BLDG 14 LAFAYETTE SQ" | "RAND BLDG 14 LAFAYETTE" + "SQ" | name-prone-suffix | "THERESA A BOVE, 1100 RAND BLDG 14 LAFAYETTE SQ, BUFFALO, New York 14203" |
| us.jsonl:2672 | "the commons" | "the" + "commons" | name-prone-suffix | "James Baker Law Office, 148 The Commons, Ithaca, NY 14850" |
| us.jsonl:2687 | "one penn plz" | "one penn" + "plz" | name-prone-suffix | "Nadin Ahmed, One Penn Plz, New York, NY 10119" |
| us.jsonl:2742 | "WEST ST" | "WEST" + "ST" | remainder-is-affix | "RACHEL A BUCK, 115 WEST ST, LIBERTY, NY 12754" |
| us.jsonl:2760 | "SPENCER HILL" | "SPENCER" + "HILL" | name-prone-suffix | "Corning Community College, Spencer Hill, Corning, NY 14830" |
| us.jsonl:2766 | "Victoria Forest" | "Victoria" + "Forest" | name-prone-suffix | "Brandelene Carter, 8718 Victoria Forest, Houston, TX 77088" |
| us.jsonl:2817 | "West Grove Club Lake" | "West" + "Grove Club" + "Lake" | name-prone-suffix | "Carolyn Nanni, 20818 West Grove Club Lake, Whitehouse, TX" |
| us.jsonl:2835 | "jade meadow" | "jade" + "meadow" | name-prone-suffix | "Dawn Herrera, 6506 Jade Meadow, San Antonio, TX 78249" |

## Left folded (16) — the tool declined to split these

| row | before | after | flags | raw |
|---|---|---|---|---|
| us.jsonl:130 | "Seymour East" | "Seymour East" | — | "Seymour East, VT 05853" |
| us.jsonl:131 | "Seymour East" | "Seymour East" | — | "VT 05853, Seymour East" |
| us.jsonl:132 | "Seymour East" | "Seymour East" | — | "Seymour East VT 05853" |
| us.jsonl:133 | "Seymour East" | "Seymour East" | — | "05853 Seymour East VT" |
| us.jsonl:1144 | "Co Rd 9 N" | "Co Rd 9 N" | — | "Co Rd 9 N, ND 58051" |
| us.jsonl:1145 | "Co Rd 9 N" | "Co Rd 9 N" | — | "58051 ND Co Rd 9 N" |
| us.jsonl:1146 | "Co Rd 9 N" | "Co Rd 9 N" | — | "Co Rd 9 North, ND 58051" |
| us.jsonl:1147 | "Co Rd 9 N" | "Co Rd 9 N" | — | "Co Rd 9 N 58051 ND" |
| us.jsonl:1182 | "ROUTE 30 N" | "ROUTE 30 N" | — | "Castleton Family Health Center CHCRR Admin, 275 Route 30 N, Bomoseen, VT 05732-9647" |
| us.jsonl:1183 | "ROUTE 30 N" | "ROUTE 30 N" | — | "Castleton Family Health Center CHCRR Admin, 275 Route 30 N, Bomoseen, VT" |
| us.jsonl:1342 | "HIGHWAY 49 N" | "HIGHWAY 49 N" | — | "Coal Country Community Health Center, 1312 Highway 49 N, Beulah, ND" |
| us.jsonl:1664 | "US RTE 5 N" | "US RTE 5 N" | — | "FAIRLEE PUBLIC, 221 US Rte 5 N, FAIRLEE, VT" |
| us.jsonl:1758 | "1ST AVE SW BOX E" | "1ST AVE SW BOX E" | — | "BONNIE J ANDERSON, 20 1ST AVE SW BOX E, BOWMAN, ND 586234213" |
| us.jsonl:1790 | "38TH ST NW UNIT E" | "38TH ST NW UNIT E" | — | "JANINE SCHAFFER, 706 38TH ST NW UNIT E, FARGO, ND" |
| us.jsonl:1859 | "BROADWAY N" | "BROADWAY N" | — | "KARI HEKTNER, 801 Broadway N, Fargo, ND 58102" |
| us.jsonl:2848 | "WESTPARK DR STE E" | "WESTPARK DR STE E" | — | "RENE RAMIREZ, 15632 Westpark Dr Ste E, Houston, TX 77082" |

## Ordinary corrections (1883) — first 100 shown; the JSONL deck has all

| row | before | after | flags | raw |
|---|---|---|---|---|
| adversarial.jsonl:1 | "Main St" | "Main" + "St" | — | "Buffalo Health Clinic, 123 Main St, Buffalo, NY 14201" |
| adversarial.jsonl:2 | "SW Salmon St" | "SW" + "Salmon" + "St" | — | "Portland Inn, 500 SW Salmon St, Portland, OR 97215" |
| adversarial.jsonl:3 | "Springfield Ave" | "Springfield" + "Ave" | — | "Springfield Plaza, 1 Springfield Ave, Springfield, IL 62701" |
| adversarial.jsonl:4 | "Tremont St" | "Tremont" + "St" | — | "Boston Common Hotel, 25 Tremont St, Boston, MA 02108" |
| adversarial.jsonl:5 | "Las Vegas Blvd S" | "Las Vegas" + "Blvd S" | — | "Las Vegas Sands, 3355 Las Vegas Blvd S, Las Vegas, NV 89109" |
| adversarial.jsonl:6 | "E Washington St" | "E" + "Washington" + "St" | — | "Chicago Cultural Center, 78 E Washington St, Chicago, IL 60602" |
| adversarial.jsonl:7 | "Woodward Ave" | "Woodward" + "Ave" | — | "Detroit Institute of Arts, 5200 Woodward Ave, Detroit, MI 48202" |
| adversarial.jsonl:8 | "S 2nd St" | "S" + "2nd" + "St" | — | "Memphis Music Hall of Fame, 126 S 2nd St, Memphis, TN 38103" |
| adversarial.jsonl:9 | "E Jefferson St" | "E" + "Jefferson" + "St" | — | "Phoenix Suns Arena, 201 E Jefferson St, Phoenix, AZ 85004" |
| adversarial.jsonl:10 | "1st Ave" | "1st" + "Ave" | — | "Seattle Art Museum, 1300 1st Ave, Seattle, WA 98101" |
| adversarial.jsonl:11 | "Las Vegas Blvd S" | "Las Vegas" + "Blvd S" | — | "New York, New York Steakhouse, 3790 Las Vegas Blvd S, Las Vegas, NV 89109" |
| adversarial.jsonl:12 | "Main St" | "Main" + "St" | — | "Paris, Texas Steakhouse, 100 Main St, Houston, TX 77002" |
| adversarial.jsonl:13 | "College Ave" | "College" + "Ave" | — | "Athens, Georgia Café, 200 College Ave, Athens, GA 30601" |
| adversarial.jsonl:15 | "Ocean Dr" | "Ocean" + "Dr" | — | "Miami, Florida Surf Shop, 100 Ocean Dr, San Diego, CA 92101" |
| adversarial.jsonl:16 | "Elm Ave" | "Elm" + "Ave" | — | "Nashville, Tennessee BBQ Pit, 75 Elm Ave, Atlanta, GA 30308" |
| adversarial.jsonl:18 | "St Marks Pl" | "St Marks" + "Pl" | — | "St. Mark's Place Diner, 1 St Marks Pl, New York, NY 10003" |
| adversarial.jsonl:20 | "St James Pl" | "St James" + "Pl" | — | "O'Brien's St. James Pub, 12 St James Pl, Boston, MA 02114" |
| adversarial.jsonl:21 | "N Vasquez St" | "N" + "Vasquez" + "St" | — | "N. Vasquez's Auto Body, 100 N Vasquez St, El Paso, TX 79901" |
| adversarial.jsonl:22 | "E Patel Way" | "E" + "Patel" + "Way" | — | "E. Patel & Sons, 200 E Patel Way, Houston, TX 77002" |
| adversarial.jsonl:23 | "Mt Vernon Ave" | "Mt Vernon" + "Ave" | — | "Mt. Vernon Family Diner, 1 Mt Vernon Ave, Mount Vernon, NY 10550" |
| adversarial.jsonl:24 | "Ft. Lauderdale Beach Blvd" | "Ft. Lauderdale Beach" + "Blvd" | — | "Ft. Lauderdale Beach Resort, 100 Ft. Lauderdale Beach Blvd, Fort Lauderdale, FL 33304" |
| adversarial.jsonl:25 | "Pensylvania Ave NW" | "Pensylvania" + "Ave NW" | — | "1600 Pensylvania Ave NW, Washington, DC 20500" |
| adversarial.jsonl:26 | "Pennsylvannia Ave NW" | "Pennsylvannia" + "Ave NW" | — | "1600 Pennsylvannia Ave NW, Washington, DC 20500" |
| adversarial.jsonl:27 | "Maon St" | "Maon" + "St" | — | "123 Maon St, Portand, OR 97214" |
| adversarial.jsonl:28 | "SE Salmon St" | "SE" + "Salmon" + "St" | — | "500 SE Salmon St, Portlnad, OR 97215" |
| adversarial.jsonl:29 | "Infinte Loop" | "Infinte" + "Loop" | — | "1 Infinte Loop, Cupertino, CA 95014" |
| adversarial.jsonl:30 | "Tremnt St" | "Tremnt" + "St" | — | "75 Tremnt St, Boston, MA 02108" |
| adversarial.jsonl:31 | "Main St" | "Main" + "St" | — | "123 Main St, Sprigfield, IL 62701" |
| adversarial.jsonl:32 | "Main St" | "Main" + "St" | — | "100 Main St, San Fransisco, CA 94103" |
| adversarial.jsonl:33 | "Main St" | "Main" + "St" | — | "50 Main St, Philadelphi, PA 19104" |
| adversarial.jsonl:34 | "Main St" | "Main" + "St" | — | "1 Main St, Pittsburg, PA 15222" |
| adversarial.jsonl:35 | "MAIN ST" | "MAIN" + "ST" | — | "123 MAIN ST PORTLAND OR 97214" |
| adversarial.jsonl:36 | "main st" | "main" + "st" | — | "123 main st,portland or97214" |
| adversarial.jsonl:37 | "123Main St" | "123Main" + "St" | — | "123Main St, Portland, OR 97214" |
| adversarial.jsonl:38 | "SW Salmon St" | "SW" + "Salmon" + "St" | — | "500 SW Salmon St,Portland,OR,97215" |
| adversarial.jsonl:40 | "SW   Salmon   St" | "SW" + "Salmon" + "St" | — | "500   SW   Salmon   St,   Portland,   OR   97215" |
| adversarial.jsonl:41 | "SE Salmon St" | "SE" + "Salmon" + "St" | — | "500 SE Salmon St Portland OR 97215" |
| adversarial.jsonl:42 | "Main St" | "Main" + "St" | — | "Address: 123 Main St, Portland, OR 97214" |
| adversarial.jsonl:43 | "Elm St" | "Elm" + "St" | — | "Phone: 555-1234 — 200 Elm St, Springfield, IL 62701" |
| adversarial.jsonl:44 | "Elm St" | "Elm" + "St" | — | "Send mail to: 200 Elm St, Springfield, IL 62701, USA, Earth" |
| adversarial.jsonl:45 | "Main St" | "Main" + "St" | — | "123 Main St c/o John Smith, Portland, OR 97214" |
| adversarial.jsonl:46 | "Volcanic Way" | "Volcanic" + "Way" | — | "Mt. Saint Helens Lodge, 100 Volcanic Way, Cougar, WA 98616" |
| adversarial.jsonl:47 | "Main St" | "Main" + "St" | — | "123 Main St Apt 4-B, Portland, OR 97214" |
| adversarial.jsonl:48 | "Main St" | "Main" + "St" | — | "123 Main St #4B, Portland, OR 97214" |
| adversarial.jsonl:49 | "Main St" | "Main" + "St" | — | "123 Main St Bldg C Ste 200, Portland, OR 97214" |
| adversarial.jsonl:50 | "Main St" | "Main" + "St" | — | "123 Main St, Portland, Oregon, U.S.A." |
| us.jsonl:1 | "Pennsylvania Avenue NW" | "Pennsylvania" + "Avenue NW" | — | "1600 Pennsylvania Avenue NW, Washington, DC 20500" |
| us.jsonl:4 | "Main St" | "Main" + "St" | — | "123 Main St Apt 4B, Springfield, IL 62701" |
| us.jsonl:8 | "Infinite Loop" | "Infinite" + "Loop" | — | "1 Infinite Loop, Cupertino, CA 95014" |
| us.jsonl:9 | "main st" | "main" + "st" | — | "123 main st portland or 97214" |
| us.jsonl:15 | "Finel Hollow Road" | "Finel Hollow" + "Road" | — | "Finel Hollow Road, VT 05764" |
| us.jsonl:16 | "Finel Hollow Road" | "Finel Hollow" + "Road" | — | "05764 Finel Hollow Road, VT" |
| us.jsonl:17 | "Finel Hollow Road" | "Finel Hollow" + "Road" | — | "Finel Hollow Road, VT" |
| us.jsonl:18 | "DELONG LN" | "DELONG" + "LN" | — | "DELONG LN, VT 05770" |
| us.jsonl:19 | "DELONG LN" | "DELONG" + "LN" | — | "05770 VT DELONG LN" |
| us.jsonl:20 | "DELONG LN" | "DELONG" + "LN" | — | "Delong Ln, VT" |
| us.jsonl:21 | "Lakeside St" | "Lakeside" + "St" | — | "Lakeside St, ND 58703" |
| us.jsonl:22 | "Lakeside St" | "Lakeside" + "St" | — | "58703 Lakeside St, ND" |
| us.jsonl:23 | "Lakeside St" | "Lakeside" + "St" | — | "Lakeside St, ND" |
| us.jsonl:24 | "6th St SW" | "6th" + "St SW" | — | "6th St SW, ND 58368" |
| us.jsonl:25 | "6th St SW" | "6th" + "St SW" | — | "58368, 6th St SW, ND" |
| us.jsonl:26 | "6th St SW" | "6th" + "St SW" | — | "ND 58368 6th St SW" |
| us.jsonl:27 | "6th St SW" | "6th" + "St SW" | — | "6th St SW, ND" |
| us.jsonl:28 | "Airview Dr" | "Airview" + "Dr" | — | "Airview Dr, ND 58701" |
| us.jsonl:29 | "Airview Dr" | "Airview" + "Dr" | — | "58701 Airview Dr, ND" |
| us.jsonl:30 | "Airview Dr" | "Airview" + "Dr" | — | "AIRVIEW DR ND 58701" |
| us.jsonl:31 | "Airview Dr" | "Airview" + "Dr" | — | "ND 58701 Airview Dr" |
| us.jsonl:32 | "Mountain Way" | "Mountain" + "Way" | — | "Mountain Way, WY 82601" |
| us.jsonl:33 | "Mountain Way" | "Mountain" + "Way" | — | "82601 Mountain Way, WY" |
| us.jsonl:34 | "Mountain Way" | "Mountain" + "Way" | — | "MOUNTAIN WAY WY 82601" |
| us.jsonl:35 | "Mountain Way" | "Mountain" + "Way" | — | "WY 82601 Mountain Way" |
| us.jsonl:36 | "Woodland Ave NE" | "Woodland" + "Ave NE" | — | "Woodland Ave NE, ND 58203" |
| us.jsonl:37 | "Woodland Ave NE" | "Woodland" + "Ave NE" | — | "58203 Woodland Ave NE, ND" |
| us.jsonl:38 | "Woodland Ave NE" | "Woodland" + "Ave NE" | — | "WOODLAND AVE NE, NORTH DAKOTA 58203" |
| us.jsonl:39 | "Woodland Ave NE" | "Woodland" + "Ave NE" | — | "Woodland Ave NE, ND" |
| us.jsonl:40 | "Woodland Ave NE" | "Woodland" + "Ave NE" | — | "ND 58203, Woodland Ave NE" |
| us.jsonl:41 | "MOUNTAIN SCHOOL RD" | "MOUNTAIN SCHOOL" + "RD" | — | "Mountain School Rd, VT 05079" |
| us.jsonl:42 | "MOUNTAIN SCHOOL RD" | "MOUNTAIN SCHOOL" + "RD" | — | "MOUNTAIN SCHOOL RD, 05079 VT" |
| us.jsonl:43 | "MOUNTAIN SCHOOL RD" | "MOUNTAIN SCHOOL" + "RD" | — | "05079 Mountain School Rd, VT" |
| us.jsonl:44 | "MOUNTAIN SCHOOL RD" | "MOUNTAIN SCHOOL" + "RD" | — | "Mountain School Rd, VT" |
| us.jsonl:45 | "Ackerman Ln" | "Ackerman" + "Ln" | — | "Ackerman Ln, VT 05045" |
| us.jsonl:46 | "Ackerman Ln" | "Ackerman" + "Ln" | — | "05045 Ackerman Ln VT" |
| us.jsonl:47 | "Ackerman Ln" | "Ackerman" + "Ln" | — | "VT 05045 Ackerman Ln" |
| us.jsonl:48 | "Ackerman Ln" | "Ackerman" + "Ln" | — | "Ackerman Ln, VT" |
| us.jsonl:49 | "Lawrence Hill Rd" | "Lawrence Hill" + "Rd" | — | "Lawrence Hill Rd, Vermont 05161" |
| us.jsonl:50 | "Lawrence Hill Rd" | "Lawrence Hill" + "Rd" | — | "05161 Vermont Lawrence Hill Rd" |
| us.jsonl:51 | "Lawrence Hill Rd" | "Lawrence Hill" + "Rd" | — | "05161, Lawrence Hill Rd, Vermont" |
| us.jsonl:52 | "DEERLEAP VIEW RD" | "DEERLEAP VIEW" + "RD" | — | "Deerleap View Rd, VT 05443" |
| us.jsonl:53 | "DEERLEAP VIEW RD" | "DEERLEAP VIEW" + "RD" | — | "05443 Deerleap View Rd, VT" |
| us.jsonl:54 | "DEERLEAP VIEW RD" | "DEERLEAP VIEW" + "RD" | — | "DEERLEAP VIEW RD, VT" |
| us.jsonl:55 | "DEERLEAP VIEW RD" | "DEERLEAP VIEW" + "RD" | — | "VT 05443, Deerleap View Rd" |
| us.jsonl:56 | "VALLEY DR" | "VALLEY" + "DR" | — | "Valley Dr, WY 82729" |
| us.jsonl:57 | "VALLEY DR" | "VALLEY" + "DR" | — | "82729 WY Valley Dr" |
| us.jsonl:58 | "VALLEY DR" | "VALLEY" + "DR" | — | "VALLEY DR, WY" |
| us.jsonl:59 | "VALLEY DR" | "VALLEY" + "DR" | — | "Valley Drive, WY 82729" |
| us.jsonl:60 | "VALLEY DR" | "VALLEY" + "DR" | — | "WY 82729, VALLEY DR" |
| us.jsonl:61 | "Murdock Rd" | "Murdock" + "Rd" | — | "Murdock Rd, VT 05143" |
| us.jsonl:62 | "Murdock Rd" | "Murdock" + "Rd" | — | "VT 05143 Murdock Rd" |
| us.jsonl:63 | "Murdock Rd" | "Murdock" + "Rd" | — | "05143 Murdock Rd VT" |
| us.jsonl:64 | "Susie Ct" | "Susie" + "Ct" | — | "Susie Ct, WY 83101" |
