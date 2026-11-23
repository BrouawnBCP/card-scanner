"""Build the sealed products database (displays, ETB, coffrets, boosters…) for Pokémon and One Piece.

Sources (downloaded fresh unless --cache is given):
  - Cardmarket public product lists: non-singles (sealed) and singles (to find each expansion)
  - Cardmarket price guides (Pokémon idGame 6, One Piece idGame 18)
  - Pokémon: the TCGdex cards database (French / English expansion names and logos). An expansion is
    linked to Cardmarket through its cards: their Cardmarket ids say which Cardmarket expansion they belong to.

Output: app/data/sealed_pk.json, app/data/sealed_op.json
  {"v", "logo": logo address prefix, "exps": [[nameEN, nameFR, logo path or set code]],
   "items": [[idProduct, nameEN, nameFR, type, exp index or -1]], "prices": {"id": [trend, low, avg7, avg1]}}
Japanese / Asian products and lots (singles sets), coins are left out.
"""
import argparse, collections, datetime, io, json, os, re, sys, tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_pokemon import download, field, lang_block, number, DB  # noqa: E402

CM = "https://downloads.s3.cardmarket.com/productCatalog/"
ASIAN = re.compile(r"Non-English|Asia|Japanese|Korean|Chinese|\bJP\b|\bKR\b|\bID/TH\b|\bT?CS\w*\d\w*:|Simplified|Traditional|\bThai\b|Indonesian", re.I)
SKIP_CAT = re.compile(r"Coins|Lots?$")

# type of product from its name (first match wins), with its French word
TYPES = [
    ("case", r"Booster Box Case|Display Case|\bCase\b", "Carton"),
    ("etb", r"Elite Trainer Box", "Coffret Dresseur d'Élite"),
    ("bundle", r"Booster Bundle|BOOster Bundle", "Bundle de boosters"),
    ("display", r"Booster Box|Booster Display|\bDisplay\b", "Display"),
    ("upc", r"Ultra[- ]Premium Collection|Super[- ]Premium Collection", "Coffret Ultra-Premium"),
    ("bnb", r"Build (&|and) Battle", "Kit d'Avant-Première"),
    ("tin", r"\bTins?\b", "Pokébox"),
    ("blister", r"Blister", "Blister"),
    ("deck", r"\bDecks?\b", "Deck"),
    ("booster", r"Booster|Pack\b", "Booster"),
    ("box", r"Collection|\bBox\b|Set\b|Kit\b", "Coffret"),
]
# English words of a product name → French (Pokémon names); longest first
WORDS_FR = [
    ("Elite Trainer Box", "Coffret Dresseur d'Élite"), ("Booster Box Case", "Carton de displays"), ("Booster Box", "Display"),
    ("Booster Bundle", "Bundle de boosters"), ("Ultra-Premium Collection", "Coffret Ultra-Premium"), ("Ultra Premium Collection", "Coffret Ultra-Premium"),
    ("Premium Collection", "Coffret Premium"), ("Special Collection", "Coffret spécial"), ("Collection Box", "Coffret"), ("Collection", "Coffret"),
    ("Build & Battle Box", "Kit d'Avant-Première"), ("Build & Battle Stadium", "Stade Avant-Première"), ("Mini Tins", "Mini Pokébox"), ("Mini Tin", "Mini Pokébox"),
    ("Tins", "Pokébox"), ("Tin", "Pokébox"), ("Theme Deck", "Deck à thème"), ("League Battle Deck", "Deck de Combat de Ligue"),
    ("Battle Deck", "Deck de combat"), ("Sleeved Booster", "Booster sous blister"), ("Checklane Blister", "Blister"),
    ("3-Pack Blister", "Tripack"), ("Blister", "Blister"), ("Poster Collection", "Coffret Poster"), ("Pin Collection", "Coffret Pin's"),
    ("Binder Collection", "Coffret Classeur"), ("Surprise Box", "Coffret Surprise"), ("Trainer Kit", "Kit du Dresseur"),
    ("Cards", "cartes"), ("Boosters", "boosters"),
]


def ptype(name, cat):
    if "Tins" in cat:
        return "tin"
    if "Theme Deck" in cat or "Preconstructed" in cat:
        return "deck"
    for k, rx, _ in TYPES:
        if re.search(rx, name, re.I):
            return k
    return "box" if "Box" in cat or "Promo" in cat else "booster" if "Booster" in cat else "other"


FR_TYPES = sorted({f for _, f in WORDS_FR if f[0].isupper()}, key=len, reverse=True)


def words_fr(s):
    s = re.sub(r"^(\d+) (.+?) Case$", r"Carton de \1 \2", s)  # "6 Booster Box Case" → "Carton de 6 Display"
    for e, f in WORDS_FR:
        s = re.sub(r"\b" + re.escape(e) + r"\b", f, s)
    return s


def to_fr(name, en, fr):
    """'Chilling Reign Booster Box' → 'Display Règne de Glace'."""
    if not (en and fr) or not name.startswith(en):
        return words_fr(name.replace(en, fr) if en and fr else name)
    rest = name[len(en):]
    colon = rest.lstrip().startswith(":")
    rest = words_fr(rest.lstrip(" :-"))
    if not rest:
        return fr
    if not colon:  # "Expansion + type": French order, type first ("Display Règne de Glace (18 boosters)")
        for t in FR_TYPES:
            if rest.startswith(t):
                return f"{t} {fr}{rest[len(t):]}".strip()
        m = re.match(r"(Carton de \d+ (?:\S+ )*?(?:Display|Coffret Dresseur d'Élite|Booster sous blister))(.*)", rest)
        if m:
            return f"{m.group(1)} {fr}{m.group(2)}".strip()
    return f"{fr}{' :' if colon else ''} {rest}"


def price_of(g):
    return [g.get("trend"), g.get("low"), g.get("avg7"), g.get("avg1")] if g else None


def tcgdex_sets(cache):
    """cardmarket expansion id -> (nameEN, nameFR, logo path) through the cards' Cardmarket ids."""
    tar = tarfile.open(fileobj=io.BytesIO(download(DB, cache, "pk_db.tgz")), mode="r:gz")
    files = {}
    for m in tar.getmembers():
        parts = m.name.split("/")
        if m.isfile() and len(parts) >= 3 and parts[1] == "data" and m.name.endswith(".ts"):
            files["/".join(parts[2:])] = tar.extractfile(m).read().decode("utf-8")
    serie_id = {p[:-3]: field(s, "id") for p, s in files.items() if p.count("/") == 0}
    sets, cards = {}, collections.defaultdict(list)
    for p, s in files.items():
        if p.count("/") == 1:
            serie, name = p[:-3].split("/")
            sets[(serie, name)] = {"id": field(s, "id"), "serie": serie_id.get(serie, ""), "name": lang_block(s, "name")}
        elif p.count("/") == 2:
            cm = number(s, "thirdParty")
            if cm:
                cards[tuple(p.split("/")[:2])].append(cm)
    return sets, cards


def build_pk(cache, out):
    ns = json.loads(download(CM + "productList/products_nonsingles_6.json", cache, "pk_ns6.json"))["products"]
    singles = json.loads(download(CM + "productList/products_singles_6.json", cache, "pk_s6.json"))["products"]
    pg = {g["idProduct"]: g for g in json.loads(download(CM + "priceGuide/price_guide_6.json", cache, "pk_pg6.json"))["priceGuides"]}
    exp_of = {p["idProduct"]: p["idExpansion"] for p in singles}
    sets, cards = tcgdex_sets(cache)
    by_exp = {}
    for k, ids in cards.items():
        st = sets.get(k)
        if not st or not st["id"] or "Pocket" in k[0]:
            continue
        c = collections.Counter(exp_of[i] for i in ids if i in exp_of)
        if not c:
            continue
        x, n = c.most_common(1)[0]
        if n * 2 < len(ids):
            continue
        en, fr = st["name"].get("en", ""), st["name"].get("fr", "")
        if x not in by_exp or len(ids) > by_exp[x][3]:  # main set of the expansion (most cards)
            by_exp[x] = (en or fr, fr or en, f"{st['serie']}/{st['id']}", len(ids))
    # a product named after an expansion ("Chilling Reign Elite Trainer Box", "Evolving Skies: …"): that one first
    named = {}
    for k, st in sets.items():
        en, fr = st["name"].get("en", ""), st["name"].get("fr", "")
        if len(en) >= 4 and st["id"] and "Pocket" not in k[0] and not re.search(r"Promo|Trainer Kit|McDonald", en):
            named.setdefault(en, (en, fr or en, f"{st['serie']}/{st['id']}", 0))
    by_len = sorted(named, key=len, reverse=True)

    def exp(p):
        n = p["name"]
        for en in by_len:
            if n.startswith(en) and (len(n) == len(en) or n[len(en)] in " :-"):
                return named[en]
        return by_exp.get(p["idExpansion"])
    return write(ns, pg, out, exp, "https://assets.tcgdex.net/", True)


def build_op(cache, out):
    ns = json.loads(download(CM + "productList/products_nonsingles_18.json", cache, "op_ns18.json"))["products"]
    singles = json.loads(download(CM + "productList/products_singles_18.json", cache, "op_cm18.json"))["products"]
    pg = {g["idProduct"]: g for g in json.loads(download(CM + "priceGuide/price_guide_18.json", cache, "op_pg18.json"))["priceGuides"]}
    code = collections.defaultdict(collections.Counter)
    for p in singles:
        m = re.search(r"\b((?:OP|ST|EB|PRB)\d{2})-\d{3}\b", p["name"])
        if m:
            code[p["idExpansion"]][m.group(1)] += 1
    names = collections.defaultdict(list)
    for p in ns:
        names[p["idExpansion"]].append(p["name"])

    def exp(p):
        c = code.get(p["idExpansion"])
        if not c:
            return None
        cd = c.most_common(1)[0][0]
        boxes = [n for n in names[p["idExpansion"]] if re.search(r"Booster Box$|^Starter Deck", n)]
        en = re.sub(r"\s*Booster Box$|^Starter Deck:?\s*", "", min(boxes, key=len)) if boxes else cd
        cd = re.sub(r"(\D+)(\d+)", r"\1-\2", cd)  # OP05 -> OP-05
        return (en, en, cd, 0)
    return write(ns, pg, out, exp, "", False)


def write(ns, pg, out, exp_of, logo, fr_names):
    exps, exp_idx, items = [], {}, []
    for p in sorted(ns, key=lambda p: -p["idProduct"]):  # newest first
        name, cat = p["name"].replace('""', '"').strip(), p.get("categoryName", "")
        if ASIAN.search(name) or SKIP_CAT.search(cat):
            continue
        e = exp_of(p)
        xi = -1
        if e:
            if e[:3] not in exp_idx:
                exp_idx[e[:3]] = len(exps); exps.append(list(e[:3]))
            xi = exp_idx[e[:3]]
        fr = to_fr(name, e[0], e[1]) if fr_names and e else to_fr(name, "", "") if fr_names else name
        items.append([p["idProduct"], name, fr if fr != name else "", ptype(name, cat), xi])
    prices = {str(i[0]): price_of(pg.get(i[0])) for i in items if pg.get(i[0])}
    data = {"v": datetime.date.today().isoformat(), "logo": logo, "exps": exps, "items": items, "prices": prices}
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    linked = sum(1 for i in items if i[4] >= 0)
    print(f"{os.path.basename(out)}: {len(items)} products | with expansion {linked} | expansions {len(exps)} | "
          f"prices {len(prices)} | {os.path.getsize(out)//1024} KB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", help="folder to reuse downloaded sources (local dev)")
    a = ap.parse_args()
    d = os.path.join(HERE, "..", "app", "data")
    os.makedirs(d, exist_ok=True)
    build_pk(a.cache, os.path.join(d, "sealed_pk.json"))
    build_op(a.cache, os.path.join(d, "sealed_op.json"))


if __name__ == "__main__":
    sys.exit(main())
