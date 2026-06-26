# #822 placer-frontier diagnostic — forward geocoding by country

_geonames cities15000, top 3/country by population (≥ 50000). "Resolved" = within
50 km of the city's true coordinate. "US namesake" = an intended non-US city that resolved
inside the continental-US bbox. Bare "City, Country" query — exactly what the drop-in sends._

- Countries sampled: **187**
- Overall resolve-rate: **29.2%** (148/506)
- US-namesake misroutes: **16.2%** (82/506)
- Supported (50%+ resolve): **54** countries · Frontier (under 50%): **133**
- Pure US-namesake (every sampled city → US): **11** countries — the cleanest #822 targets

> **How to read this.** This is the placer's country-emission ceiling, not the geocoder's capability.
> A bare "City, Country" query carries no country hint, so US plus the 54 supported countries below
> resolve; `countrycodes` recovers more (the manual escape). The lever for the rest is placer coverage
> (#822) — GPU model work.

## Pure US-namesake countries — the unambiguous #822 placer-emission gap

Every sampled city resolved to a US namesake: the placer never emits the country, so a confident US
place wins. A country constraint (`countrycodes`) is the manual escape today; the fix is placer coverage.

| Country               | ISO2 | Cities → US |
| --------------------- | ---- | ----------: |
| Barbados              | BB   |         1/1 |
| Georgia               | GE   |         3/3 |
| Greece                | GR   |         3/3 |
| Guyana                | GY   |         1/1 |
| Hong Kong             | HK   |         3/3 |
| Jamaica               | JM   |         3/3 |
| Comoros               | KM   |         1/1 |
| Moldova, Republic of  | MD   |         3/3 |
| New Caledonia         | NC   |         1/1 |
| Solomon Islands       | SB   |         1/1 |
| Virgin Islands (U.S.) | VI   |         1/1 |

## All frontier countries (under 50% resolve) — the #822 work list

Where US-namesake is below the miss count, the rest are exonym (Wien/Vienna) or gazetteer-coverage
misses — a different fix than placer emission.

| Country                                    | ISO2 | Resolved | US-namesake |
| ------------------------------------------ | ---- | -------: | ----------: |
| Barbados                                   | BB   |      0/1 |         1/1 |
| Georgia                                    | GE   |      0/3 |         3/3 |
| Greece                                     | GR   |      0/3 |         3/3 |
| Guyana                                     | GY   |      0/1 |         1/1 |
| Hong Kong                                  | HK   |      0/3 |         3/3 |
| Jamaica                                    | JM   |      0/3 |         3/3 |
| Comoros                                    | KM   |      0/1 |         1/1 |
| Moldova, Republic of                       | MD   |      0/3 |         3/3 |
| New Caledonia                              | NC   |      0/1 |         1/1 |
| Solomon Islands                            | SB   |      0/1 |         1/1 |
| Virgin Islands (U.S.)                      | VI   |      0/1 |         1/1 |
| Central African Republic                   | CF   |      0/3 |         2/3 |
| Guinea                                     | GN   |      0/3 |         2/3 |
| Hungary                                    | HU   |      0/3 |         2/3 |
| Liberia                                    | LR   |      0/3 |         2/3 |
| Mongolia                                   | MN   |      0/3 |         2/3 |
| Palestine, State of                        | PS   |      0/3 |         2/3 |
| Russian Federation                         | RU   |      0/3 |         2/3 |
| Sudan                                      | SD   |      0/3 |         2/3 |
| Syrian Arab Republic                       | SY   |      0/3 |         2/3 |
| South Africa                               | ZA   |      0/3 |         2/3 |
| Angola                                     | AO   |      0/3 |         1/3 |
| Argentina                                  | AR   |      0/3 |         1/3 |
| Australia                                  | AU   |      0/3 |         1/3 |
| Canada                                     | CA   |      0/3 |         1/3 |
| Kyrgyzstan                                 | KG   |      0/3 |         1/3 |
| Kuwait                                     | KW   |      0/3 |         1/3 |
| Lao People's Democratic Republic           | LA   |      0/3 |         1/3 |
| Macedonia, the Former Yugoslav Republic of | MK   |      0/3 |         1/3 |
| Mauritius                                  | MU   |      0/3 |         1/3 |
| Malawi                                     | MW   |      0/3 |         1/3 |
| Poland                                     | PL   |      0/3 |         1/3 |
| Singapore                                  | SG   |      0/3 |         1/3 |
| Sierra Leone                               | SL   |      0/3 |         1/3 |
| South Sudan                                | SS   |      0/3 |         1/3 |
| Togo                                       | TG   |      0/3 |         1/3 |
| Yemen                                      | YE   |      0/3 |         1/3 |
| Afghanistan                                | AF   |      0/3 |         0/3 |
| Antigua and Barbuda                        | AG   |      0/1 |         0/1 |
| Albania                                    | AL   |      0/3 |         0/3 |
| Armenia                                    | AM   |      0/3 |         0/3 |
| Azerbaijan                                 | AZ   |      0/3 |         0/3 |
| Bosnia and Herzegovina                     | BA   |      0/3 |         0/3 |
| Burkina Faso                               | BF   |      0/3 |         0/3 |
| Burundi                                    | BI   |      0/3 |         0/3 |
| Benin                                      | BJ   |      0/3 |         0/3 |
| Brunei Darussalam                          | BN   |      0/1 |         0/1 |
| Bolivia                                    | BO   |      0/3 |         0/3 |
| Brazil                                     | BR   |      0/3 |         0/3 |
| Bahamas                                    | BS   |      0/1 |         0/1 |
| Bhutan                                     | BT   |      0/1 |         0/1 |
| Botswana                                   | BW   |      0/3 |         0/3 |
| Belarus                                    | BY   |      0/3 |         0/3 |
| Belize                                     | BZ   |      0/1 |         0/1 |
| Congo, the Democratic Republic of the      | CD   |      0/3 |         0/3 |
| Congo                                      | CG   |      0/3 |         0/3 |
| China                                      | CN   |      0/3 |         0/3 |
| Costa Rica                                 | CR   |      0/3 |         0/3 |
| Cape Verde                                 | CV   |      0/2 |         0/2 |
| Curaçao                                    | CW   |      0/1 |         0/1 |
| Cyprus                                     | CY   |      0/3 |         0/3 |
| Djibouti                                   | DJ   |      0/2 |         0/2 |
| Ecuador                                    | EC   |      0/3 |         0/3 |
| Egypt                                      | EG   |      0/3 |         0/3 |
| Eritrea                                    | ER   |      0/2 |         0/2 |
| Fiji                                       | FJ   |      0/3 |         0/3 |
| Gabon                                      | GA   |      0/3 |         0/3 |
| Gambia                                     | GM   |      0/3 |         0/3 |
| Guadeloupe                                 | GP   |      0/1 |         0/1 |
| Equatorial Guinea                          | GQ   |      0/2 |         0/2 |
| Guinea-Bissau                              | GW   |      0/2 |         0/2 |
| Honduras                                   | HN   |      0/3 |         0/3 |
| Haiti                                      | HT   |      0/3 |         0/3 |
| Ireland                                    | IE   |      0/3 |         0/3 |
| Iraq                                       | IQ   |      0/3 |         0/3 |
| Korea, Democratic People's Republic of     | KP   |      0/3 |         0/3 |
| Lesotho                                    | LS   |      0/2 |         0/2 |
| Libya                                      | LY   |      0/3 |         0/3 |
| Morocco                                    | MA   |      0/3 |         0/3 |
| Montenegro                                 | ME   |      0/2 |         0/2 |
| Madagascar                                 | MG   |      0/3 |         0/3 |
| Mali                                       | ML   |      0/3 |         0/3 |
| Macao                                      | MO   |      0/3 |         0/3 |
| Martinique                                 | MQ   |      0/1 |         0/1 |
| Mauritania                                 | MR   |      0/3 |         0/3 |
| Maldives                                   | MV   |      0/1 |         0/1 |
| Mozambique                                 | MZ   |      0/3 |         0/3 |
| Namibia                                    | NA   |      0/3 |         0/3 |
| Niger                                      | NE   |      0/3 |         0/3 |
| Nicaragua                                  | NI   |      0/3 |         0/3 |
| Papua New Guinea                           | PG   |      0/2 |         0/2 |
| Puerto Rico                                | PR   |      0/3 |         0/3 |
| Paraguay                                   | PY   |      0/3 |         0/3 |
| Rwanda                                     | RW   |      0/3 |         0/3 |
| Somalia                                    | SO   |      0/3 |         0/3 |
| Suriname                                   | SR   |      0/1 |         0/1 |
| Sao Tome and Principe                      | ST   |      0/1 |         0/1 |
| El Salvador                                | SV   |      0/3 |         0/3 |
| Swaziland                                  | SZ   |      0/2 |         0/2 |
| Tajikistan                                 | TJ   |      0/3 |         0/3 |
| Timor-Leste                                | TL   |      0/1 |         0/1 |
| Turkmenistan                               | TM   |      0/3 |         0/3 |
| Trinidad and Tobago                        | TT   |      0/3 |         0/3 |
| Uzbekistan                                 | UZ   |      0/3 |         0/3 |
| Zambia                                     | ZM   |      0/3 |         0/3 |
| Zimbabwe                                   | ZW   |      0/3 |         0/3 |
| Belgium                                    | BE   |      1/3 |         2/3 |
| Denmark                                    | DK   |      1/3 |         2/3 |
| Algeria                                    | DZ   |      1/3 |         2/3 |
| New Zealand                                | NZ   |      1/3 |         2/3 |
| Sweden                                     | SE   |      1/3 |         2/3 |
| Dominican Republic                         | DO   |      1/3 |         1/3 |
| Sri Lanka                                  | LK   |      1/3 |         1/3 |
| Latvia                                     | LV   |      1/3 |         1/3 |
| Serbia                                     | RS   |      1/3 |         1/3 |
| Slovakia                                   | SK   |      1/3 |         1/3 |
| Uruguay                                    | UY   |      1/3 |         1/3 |
| United Arab Emirates                       | AE   |      1/3 |         0/3 |
| Bangladesh                                 | BD   |      1/3 |         0/3 |
| Bulgaria                                   | BG   |      1/3 |         0/3 |
| Bahrain                                    | BH   |      1/3 |         0/3 |
| Cote DIvoire                               | CI   |      1/3 |         0/3 |
| Colombia                                   | CO   |      1/3 |         0/3 |
| Cuba                                       | CU   |      1/3 |         0/3 |
| Malaysia                                   | MY   |      1/3 |         0/3 |
| Reunion                                    | RE   |      1/3 |         0/3 |
| Saudi Arabia                               | SA   |      1/3 |         0/3 |
| Chad                                       | TD   |      1/3 |         0/3 |
| Thailand                                   | TH   |      1/3 |         0/3 |
| Turkey                                     | TR   |      1/3 |         0/3 |
| Ukraine                                    | UA   |      1/3 |         0/3 |
| United States                              | US   |      1/3 |         0/3 |
| Venezuela                                  | VE   |      1/3 |         0/3 |

## Supported countries (≥50% resolve)

| Country                      | ISO2 | Resolved |
| ---------------------------- | ---- | -------: |
| Western Sahara               | EH   |      1/2 |
| Mexico                       | MX   |      2/3 |
| Austria                      | AT   |      2/3 |
| Switzerland                  | CH   |      2/3 |
| Czech Republic               | CZ   |      2/3 |
| Israel                       | IL   |      2/3 |
| India                        | IN   |      2/3 |
| Pakistan                     | PK   |      2/3 |
| Portugal                     | PT   |      2/3 |
| Chile                        | CL   |      2/3 |
| Cameroon                     | CM   |      2/3 |
| Estonia                      | EE   |      2/3 |
| United Kingdom               | GB   |      2/3 |
| Guatemala                    | GT   |      2/3 |
| Iran, Islamic Republic of    | IR   |      2/3 |
| Cambodia                     | KH   |      2/3 |
| Kazakhstan                   | KZ   |      2/3 |
| Lebanon                      | LB   |      2/3 |
| Myanmar                      | MM   |      2/3 |
| Nigeria                      | NG   |      2/3 |
| Norway                       | NO   |      2/3 |
| Nepal                        | NP   |      2/3 |
| Oman                         | OM   |      2/3 |
| Panama                       | PA   |      2/3 |
| Peru                         | PE   |      2/3 |
| Philippines                  | PH   |      2/3 |
| Qatar                        | QA   |      2/3 |
| Romania                      | RO   |      2/3 |
| Senegal                      | SN   |      2/3 |
| Tunisia                      | TN   |      2/3 |
| Uganda                       | UG   |      2/3 |
| Germany                      | DE   |      3/3 |
| Spain                        | ES   |      3/3 |
| Ethiopia                     | ET   |      3/3 |
| Finland                      | FI   |      3/3 |
| France                       | FR   |      3/3 |
| French Guiana                | GF   |      1/1 |
| Ghana                        | GH   |      3/3 |
| Croatia                      | HR   |      3/3 |
| Indonesia                    | ID   |      3/3 |
| Iceland                      | IS   |      1/1 |
| Italy                        | IT   |      3/3 |
| Jordan                       | JO   |      3/3 |
| Japan                        | JP   |      3/3 |
| Kenya                        | KE   |      3/3 |
| Korea, Republic of           | KR   |      3/3 |
| Lithuania                    | LT   |      3/3 |
| Luxembourg                   | LU   |      1/1 |
| Netherlands                  | NL   |      3/3 |
| Slovenia                     | SI   |      2/2 |
| Taiwan (Province of China)   | TW   |      3/3 |
| Tanzania, United Republic of | TZ   |      3/3 |
| Viet Nam                     | VN   |      3/3 |
| Mayotte                      | YT   |      1/1 |
