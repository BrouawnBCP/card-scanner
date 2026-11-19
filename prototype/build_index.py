import json, csv, re, sys
ygo, cm_csv, out = sys.argv[1], sys.argv[2], sys.argv[3]

en = json.load(open(ygo + "/en.json", encoding="utf-8"))["data"]
fr = {c["id"]: c["name"] for c in json.load(open(ygo + "/fr.json", encoding="utf-8"))["data"]}

def split_code(code):
    # "MP20-EN167" -> ("MP20", "167"); "LOB-E001" -> ("LOB", "001")
    m = re.match(r"^([A-Z0-9]+)-([A-Z]{0,2})(\d+[A-Z]?)$", code.strip().upper())
    return (m.group(1), m.group(3)) if m else (None, None)

cards = []          # [nameEN, nameFR]
sets = {}           # setName -> idx
setnames = []
prints = {}         # "PREFIX-NUM" -> [[cardIdx, setIdx, rarity, cmId]]
for c in en:
    ci = len(cards)
    cards.append([c["name"], fr.get(c["id"], "")])
    for s in c.get("card_sets") or []:
        p, n = split_code(s["set_code"])
        if not p:
            continue
        if s["set_name"] not in sets:
            sets[s["set_name"]] = len(setnames); setnames.append(s["set_name"])
        prints.setdefault(f"{p}-{n}", []).append([ci, sets[s["set_name"]], s["set_rarity"], 0])

# Cardmarket product ids from the user's own export
cm = {}
with open(cm_csv, encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        sc = re.sub(r"-[A-Z]$", "", r["setCode"].upper())
        key = f"{sc}-{r['cn']}"
        rar = r["rarity"]
        cm.setdefault(key, {})[rar] = int(r["cardmarketId"])
        cm[key].setdefault("_set", r["set"])

hit = 0
for key, lst in prints.items():
    m = cm.get(key)
    if not m:
        continue
    ids = {k: v for k, v in m.items() if k != "_set"}
    for e in lst:
        rid = ids.get(e[2])
        if rid is None and len(ids) == 1 and len(lst) == 1:
            rid = next(iter(ids.values()))
        if rid:
            e[3] = rid; hit += 1

json.dump({"cards": cards, "sets": setnames, "prints": prints},
          open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print("cards", len(cards), "prints keys", len(prints), "cm keys", len(cm), "linked", hit)
