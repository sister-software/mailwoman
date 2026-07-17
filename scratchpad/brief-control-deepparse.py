"""The brief's exact control set on deepparse (bpemb). Run in the deepparse venv."""
import json, warnings
warnings.filterwarnings("ignore")
from deepparse.parser import AddressParser

SET = {
    "bare-hn-like": ["39A", "44B", "121", "9600"],
    "valid-postcode": ["1234AB", "90210", "75008"],
    "invalid-postcode": ["1234SA", "0123AB"],
    "route-date-name": ["Interstate 35", "FM 3009", "11 Novembre", "10 Ave"],
    "contextful": ["Epleskogen 39A", "Tindvegen nedre 44B", "aleja Wojska Polskiego 178", "9600 S Interstate 35 TX"],
}
rows = [(k, i) for k, ins in SET.items() for i in ins]
p = AddressParser(model_type="bpemb", device="cpu", verbose=False)
parsed = p([i for _, i in rows])
if not isinstance(parsed, list): parsed = [parsed]
out = {}
for (k, i), pr in zip(rows, parsed):
    g = {}
    for tok, tag in pr.to_list_of_tuples():
        if tag in (None, "EOS"): continue
        g[tag] = f"{g[tag]} {tok}" if tag in g else tok
    out.setdefault(k, {})[i] = g
    print(f"  [{k}] {i:<26} {json.dumps(g, ensure_ascii=False)}")
json.dump(out, open("/home/lab/Projects/mailwoman/scratchpad/deepparse-cmp/brief-control-deepparse.json","w"), indent=2, ensure_ascii=False)
