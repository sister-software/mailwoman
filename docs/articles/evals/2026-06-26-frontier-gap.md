# #822 placer-frontier diagnostic — bare vs country-hint, by country

_geonames cities15000, top 3/country by population (≥ 50000). "Resolved" = within
50 km of the city's true coordinate. **Bare** = no country constraint (what the drop-in sends
for a bare query); **+hint** = with the country as a `countrycodes` constraint. The bare→hint lift is
what growing the placer would buy (#822); what stays unresolved with a hint is the exonym/coverage lever._

- Cities: **506** across **187** countries
- Resolve-rate **bare: 29.2%** → **+hint: 46.6%** (lift +17.4 pp)
- Bare US-namesake misroutes: **16.2%** (82/506) — undercounts the placer gap
- Countries: **54** bare-supported · **36** placer-recoverable (#822) · **97** residual
- Residual splits: **92** name-not-found (English name matches no in-country record — exonym fix where the record exists under a local name, else coverage-absence) · **5** wrong-place (coverage/disambiguation)

> **How to read this.** Bare resolve-rate is the placer ceiling, not the geocoder's capability — a
> bare query carries no country hint. The **+hint** column is the honest #822 prize: countries that
> resolve once the country is known but not before. The **residual** set fails even with the hint, so
> the placer can't fix it — that's alt-name (Warsaw/Warszawa) + gazetteer coverage, a parallel lever.

## Placer-recoverable (#822) — a country hint fixes it; growing the placer captures it

| Country              | ISO2 | Bare | +hint |
| -------------------- | ---- | ---: | ----: |
| Angola               | AO   |  0/3 |   2/3 |
| Argentina            | AR   |  0/3 |   2/3 |
| Bolivia              | BO   |  0/3 |   2/3 |
| China                | CN   |  0/3 |   2/3 |
| Ecuador              | EC   |  0/3 |   2/3 |
| Bahrain              | BH   |  1/3 |   2/3 |
| Sri Lanka            | LK   |  1/3 |   2/3 |
| Malaysia             | MY   |  1/3 |   2/3 |
| Serbia               | RS   |  1/3 |   2/3 |
| Slovakia             | SK   |  1/3 |   2/3 |
| Thailand             | TH   |  1/3 |   2/3 |
| Ukraine              | UA   |  1/3 |   2/3 |
| Australia            | AU   |  0/3 |   3/3 |
| Belarus              | BY   |  0/3 |   3/3 |
| Canada               | CA   |  0/3 |   3/3 |
| Costa Rica           | CR   |  0/3 |   3/3 |
| Egypt                | EG   |  0/3 |   3/3 |
| Ireland              | IE   |  0/3 |   3/3 |
| Morocco              | MA   |  0/3 |   3/3 |
| Russian Federation   | RU   |  0/3 |   3/3 |
| Singapore            | SG   |  0/3 |   3/3 |
| South Africa         | ZA   |  0/3 |   3/3 |
| United Arab Emirates | AE   |  1/3 |   3/3 |
| Bangladesh           | BD   |  1/3 |   3/3 |
| Bulgaria             | BG   |  1/3 |   3/3 |
| Cote DIvoire         | CI   |  1/3 |   3/3 |
| Colombia             | CO   |  1/3 |   3/3 |
| Cuba                 | CU   |  1/3 |   3/3 |
| Dominican Republic   | DO   |  1/3 |   3/3 |
| Algeria              | DZ   |  1/3 |   3/3 |
| Latvia               | LV   |  1/3 |   3/3 |
| New Zealand          | NZ   |  1/3 |   3/3 |
| Saudi Arabia         | SA   |  1/3 |   3/3 |
| Turkey               | TR   |  1/3 |   3/3 |
| Uruguay              | UY   |  1/3 |   3/3 |
| Venezuela            | VE   |  1/3 |   3/3 |

## Residual A — name-not-found (exonym fix, or coverage-absence)

The hint returns NOTHING: the English query name matches no place in the country. Where the record
exists under a LOCAL name (`Warsaw` vs `Warszawa` — proven end-to-end), indexing alt-name surface forms
onto the candidate table fixes it cheaply (#823, no model change). Where the country has no candidate
records at all, it's coverage. European exonyms dominate; the per-country split needs a local-name probe.
`hint→∅` = of the hint-unresolved cities, how many returned no result (vs a wrong place).

| Country                                    | ISO2 | Bare | +hint | hint→∅ |
| ------------------------------------------ | ---- | ---: | ----: | -----: |
| Afghanistan                                | AF   |  0/3 |   0/3 |    3/3 |
| Antigua and Barbuda                        | AG   |  0/1 |   0/1 |    1/1 |
| Albania                                    | AL   |  0/3 |   0/3 |    3/3 |
| Armenia                                    | AM   |  0/3 |   0/3 |    3/3 |
| Azerbaijan                                 | AZ   |  0/3 |   0/3 |    3/3 |
| Bosnia and Herzegovina                     | BA   |  0/3 |   0/3 |    3/3 |
| Barbados                                   | BB   |  0/1 |   0/1 |    1/1 |
| Burkina Faso                               | BF   |  0/3 |   0/3 |    3/3 |
| Burundi                                    | BI   |  0/3 |   0/3 |    3/3 |
| Benin                                      | BJ   |  0/3 |   0/3 |    3/3 |
| Brunei Darussalam                          | BN   |  0/1 |   0/1 |    1/1 |
| Bahamas                                    | BS   |  0/1 |   0/1 |    1/1 |
| Bhutan                                     | BT   |  0/1 |   0/1 |    1/1 |
| Botswana                                   | BW   |  0/3 |   0/3 |    3/3 |
| Belize                                     | BZ   |  0/1 |   0/1 |    1/1 |
| Congo, the Democratic Republic of the      | CD   |  0/3 |   0/3 |    3/3 |
| Central African Republic                   | CF   |  0/3 |   0/3 |    3/3 |
| Congo                                      | CG   |  0/3 |   0/3 |    3/3 |
| Cape Verde                                 | CV   |  0/2 |   0/2 |    2/2 |
| Curaçao                                    | CW   |  0/1 |   0/1 |    1/1 |
| Cyprus                                     | CY   |  0/3 |   0/3 |    3/3 |
| Djibouti                                   | DJ   |  0/2 |   0/2 |    2/2 |
| Eritrea                                    | ER   |  0/2 |   0/2 |    2/2 |
| Fiji                                       | FJ   |  0/3 |   0/3 |    3/3 |
| Gabon                                      | GA   |  0/3 |   0/3 |    3/3 |
| Georgia                                    | GE   |  0/3 |   0/3 |    3/3 |
| Gambia                                     | GM   |  0/3 |   0/3 |    3/3 |
| Guinea                                     | GN   |  0/3 |   0/3 |    3/3 |
| Guadeloupe                                 | GP   |  0/1 |   0/1 |    1/1 |
| Equatorial Guinea                          | GQ   |  0/2 |   0/2 |    2/2 |
| Guinea-Bissau                              | GW   |  0/2 |   0/2 |    2/2 |
| Guyana                                     | GY   |  0/1 |   0/1 |    1/1 |
| Hong Kong                                  | HK   |  0/3 |   0/3 |    3/3 |
| Honduras                                   | HN   |  0/3 |   0/3 |    3/3 |
| Haiti                                      | HT   |  0/3 |   0/3 |    3/3 |
| Jamaica                                    | JM   |  0/3 |   0/3 |    3/3 |
| Kyrgyzstan                                 | KG   |  0/3 |   0/3 |    3/3 |
| Comoros                                    | KM   |  0/1 |   0/1 |    1/1 |
| Korea, Democratic People's Republic of     | KP   |  0/3 |   0/3 |    3/3 |
| Kuwait                                     | KW   |  0/3 |   0/3 |    3/3 |
| Lao People's Democratic Republic           | LA   |  0/3 |   0/3 |    3/3 |
| Liberia                                    | LR   |  0/3 |   0/3 |    3/3 |
| Lesotho                                    | LS   |  0/2 |   0/2 |    2/2 |
| Libya                                      | LY   |  0/3 |   0/3 |    3/3 |
| Moldova, Republic of                       | MD   |  0/3 |   0/3 |    3/3 |
| Montenegro                                 | ME   |  0/2 |   0/2 |    2/2 |
| Madagascar                                 | MG   |  0/3 |   0/3 |    3/3 |
| Macedonia, the Former Yugoslav Republic of | MK   |  0/3 |   0/3 |    3/3 |
| Mali                                       | ML   |  0/3 |   0/3 |    3/3 |
| Mongolia                                   | MN   |  0/3 |   0/3 |    3/3 |
| Macao                                      | MO   |  0/3 |   0/3 |    3/3 |
| Martinique                                 | MQ   |  0/1 |   0/1 |    1/1 |
| Mauritania                                 | MR   |  0/3 |   0/3 |    3/3 |
| Mauritius                                  | MU   |  0/3 |   0/3 |    3/3 |
| Maldives                                   | MV   |  0/1 |   0/1 |    1/1 |
| Malawi                                     | MW   |  0/3 |   0/3 |    3/3 |
| Mozambique                                 | MZ   |  0/3 |   0/3 |    3/3 |
| Namibia                                    | NA   |  0/3 |   0/3 |    3/3 |
| New Caledonia                              | NC   |  0/1 |   0/1 |    1/1 |
| Niger                                      | NE   |  0/3 |   0/3 |    3/3 |
| Nicaragua                                  | NI   |  0/3 |   0/3 |    3/3 |
| Papua New Guinea                           | PG   |  0/2 |   0/2 |    2/2 |
| Puerto Rico                                | PR   |  0/3 |   0/3 |    3/3 |
| Palestine, State of                        | PS   |  0/3 |   0/3 |    3/3 |
| Paraguay                                   | PY   |  0/3 |   0/3 |    3/3 |
| Rwanda                                     | RW   |  0/3 |   0/3 |    3/3 |
| Solomon Islands                            | SB   |  0/1 |   0/1 |    1/1 |
| Sudan                                      | SD   |  0/3 |   0/3 |    3/3 |
| Sierra Leone                               | SL   |  0/3 |   0/3 |    3/3 |
| Somalia                                    | SO   |  0/3 |   0/3 |    3/3 |
| Suriname                                   | SR   |  0/1 |   0/1 |    1/1 |
| South Sudan                                | SS   |  0/3 |   0/3 |    3/3 |
| Sao Tome and Principe                      | ST   |  0/1 |   0/1 |    1/1 |
| El Salvador                                | SV   |  0/3 |   0/3 |    3/3 |
| Syrian Arab Republic                       | SY   |  0/3 |   0/3 |    3/3 |
| Swaziland                                  | SZ   |  0/2 |   0/2 |    2/2 |
| Togo                                       | TG   |  0/3 |   0/3 |    3/3 |
| Tajikistan                                 | TJ   |  0/3 |   0/3 |    3/3 |
| Timor-Leste                                | TL   |  0/1 |   0/1 |    1/1 |
| Turkmenistan                               | TM   |  0/3 |   0/3 |    3/3 |
| Trinidad and Tobago                        | TT   |  0/3 |   0/3 |    3/3 |
| Uzbekistan                                 | UZ   |  0/3 |   0/3 |    3/3 |
| Virgin Islands (U.S.)                      | VI   |  0/1 |   0/1 |    1/1 |
| Yemen                                      | YE   |  0/3 |   0/3 |    3/3 |
| Zambia                                     | ZM   |  0/3 |   0/3 |    3/3 |
| Zimbabwe                                   | ZW   |  0/3 |   0/3 |    3/3 |
| Reunion                                    | RE   |  1/3 |   0/3 |    3/3 |
| Chad                                       | TD   |  1/3 |   0/3 |    3/3 |
| Greece                                     | GR   |  0/3 |   1/3 |    2/2 |
| Hungary                                    | HU   |  0/3 |   1/3 |    2/2 |
| Belgium                                    | BE   |  1/3 |   1/3 |    2/2 |
| Denmark                                    | DK   |  1/3 |   1/3 |    2/2 |

## Residual B — gazetteer coverage / disambiguation

The hint returns a WRONG place: the country has a same-name match but the target city isn't in the
candidate gazetteer, or loses disambiguation. Needs more data, not alt-names (Beijing, Rio).

| Country       | ISO2 | Bare | +hint | hint→∅ |
| ------------- | ---- | ---: | ----: | -----: |
| Brazil        | BR   |  0/3 |   0/3 |    0/3 |
| Iraq          | IQ   |  0/3 |   1/3 |    1/2 |
| Poland        | PL   |  0/3 |   1/3 |    1/2 |
| Sweden        | SE   |  1/3 |   1/3 |    0/2 |
| United States | US   |  1/3 |   1/3 |    0/2 |

## Bare-supported (≥50% resolve with no hint) — US + the #743 safelist + tail

| Country                      | ISO2 | Bare |
| ---------------------------- | ---- | ---: |
| Western Sahara               | EH   |  1/2 |
| French Guiana                | GF   |  1/1 |
| Mayotte                      | YT   |  1/1 |
| Austria                      | AT   |  2/3 |
| Switzerland                  | CH   |  2/3 |
| Cameroon                     | CM   |  2/3 |
| Czech Republic               | CZ   |  2/3 |
| United Kingdom               | GB   |  2/3 |
| Guatemala                    | GT   |  2/3 |
| Cambodia                     | KH   |  2/3 |
| Lebanon                      | LB   |  2/3 |
| Mexico                       | MX   |  2/3 |
| Nigeria                      | NG   |  2/3 |
| Nepal                        | NP   |  2/3 |
| Panama                       | PA   |  2/3 |
| Philippines                  | PH   |  2/3 |
| Portugal                     | PT   |  2/3 |
| Romania                      | RO   |  2/3 |
| Uganda                       | UG   |  2/3 |
| Chile                        | CL   |  2/3 |
| Estonia                      | EE   |  2/3 |
| Israel                       | IL   |  2/3 |
| India                        | IN   |  2/3 |
| Iran, Islamic Republic of    | IR   |  2/3 |
| Kazakhstan                   | KZ   |  2/3 |
| Myanmar                      | MM   |  2/3 |
| Norway                       | NO   |  2/3 |
| Oman                         | OM   |  2/3 |
| Peru                         | PE   |  2/3 |
| Pakistan                     | PK   |  2/3 |
| Qatar                        | QA   |  2/3 |
| Senegal                      | SN   |  2/3 |
| Tunisia                      | TN   |  2/3 |
| Germany                      | DE   |  3/3 |
| Spain                        | ES   |  3/3 |
| Ethiopia                     | ET   |  3/3 |
| Finland                      | FI   |  3/3 |
| France                       | FR   |  3/3 |
| Ghana                        | GH   |  3/3 |
| Croatia                      | HR   |  3/3 |
| Indonesia                    | ID   |  3/3 |
| Iceland                      | IS   |  1/1 |
| Italy                        | IT   |  3/3 |
| Jordan                       | JO   |  3/3 |
| Japan                        | JP   |  3/3 |
| Kenya                        | KE   |  3/3 |
| Korea, Republic of           | KR   |  3/3 |
| Lithuania                    | LT   |  3/3 |
| Luxembourg                   | LU   |  1/1 |
| Netherlands                  | NL   |  3/3 |
| Slovenia                     | SI   |  2/2 |
| Taiwan (Province of China)   | TW   |  3/3 |
| Tanzania, United Republic of | TZ   |  3/3 |
| Viet Nam                     | VN   |  3/3 |
