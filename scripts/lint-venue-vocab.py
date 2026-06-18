import pyarrow.parquet as pq, glob
from collections import Counter, defaultdict

VENUES = ["Public Library","Community Center","Health Center","Municipal Library","Elementary School","High School","Memorial Hospital","Fire Department","City Hall","Senior Center","Medical Clinic","Family Practice","Dental Group","Veterans Hall","Recreation Center","Town Office","Community Hospital","Public School","Arts Council","County Courthouse"]
TOKENS = set(w for v in VENUES for w in v.split())

parts = sorted(glob.glob('/mnt/playpen/mailwoman-data/corpus/versioned/v0.5.0/corpus-v0.5.0/train/*.parquet'))
bysrc = defaultdict(list)
for p in parts:
    bysrc[pq.read_table(p, columns=['source']).column('source')[0].as_py()].append(p)
sample = []
for s,n in [('usgov-nppes',4),('usgov-hrsa-fqhc',1),('tiger',4),('usgov-nad',5),('wof-admin',4)]:
    sample += bysrc.get(s,[])[:n]
print('scanning', len(sample), 'parts across nppes/hrsa/tiger/nad/wof-admin')

tally = defaultdict(Counter)
for p in sample:
    t = pq.read_table(p, columns=['tokens','labels'])
    for tk, lb in zip(t.column('tokens').to_pylist(), t.column('labels').to_pylist()):
        for w, l in zip(tk, lb):
            if w in TOKENS:
                tally[w][l[2:] if l[:2] in ('B-','I-') else l] += 1

print(f'\n{"token":14} {"total":>8}  tag distribution (top 4)')
flagged=[]
for w in sorted(TOKENS):
    c = tally[w]; tot = sum(c.values())
    if tot==0:
        print(f'{w:14} {0:>8}  (absent)'); continue
    s = '  '.join(f'{tag} {100*n//tot}%' for tag,n in c.most_common(4))
    nonvenue = 100*(c.get('street',0)+c.get('locality',0))//tot
    venue_pct = 100*c.get('venue',0)//tot
    flag = '  <<< CONTRADICTION?' if nonvenue>60 and venue_pct<25 else ''
    if flag: flagged.append(w)
    print(f'{w:14} {tot:>8}  {s}{flag}')
print('\nFLAGGED:', flagged or 'none — VENUES vocab is base-consistent')
