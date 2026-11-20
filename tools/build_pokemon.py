"""Build the Pokémon card database used by the web app.

Sources (downloaded fresh unless --cache is given):
  - the TCGdex cards database (github.com/tcgdex/cards-database, one archive): French and English
    names, rarity, set code ("PAL", French "EAP"…), set size (the number after the slash) and the
    Cardmarket product id of every card
  - Cardmarket price guide for Pokémon (idGame 6)

Output: app/data/pokemon.json
  {"v", "img": picture address prefix, "cards": [[nameEN, nameFR, picture]], "sets": [...],
   "prints": {"PBL-071": [...], "21/149": [...]},      # set code + number, or number/set size
   "prices": {"cmId": [trend, low, avg7]}}
A card printed with its set code ("PBL FR 071/084", 2023 onwards) is found by "PBL-071"; older cards
only show "21/149": several sets can share that, the app then compares the name it reads.
"""
import argparse, collections, datetime, io, json, os, re, sys, tarfile, urllib.request

DB = "https://codeload.github.com/tcgdex/cards-database/tar.gz/refs/heads/master"
CM_PRICES = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json"
IMG = "https://assets.tcgdex.net/"
HERE = os.path.dirname(os.path.abspath(__file__))
RARITY_FR = {"Common": "Commune", "Uncommon": "Peu commune", "Rare": "Rare", "Rare Holo": "Rare Holo", "None": ""}


def download(url, cache, name):
    p = os.path.join(cache, name) if cache else None
    if p and os.path.exists(p):
        return open(p, "rb").read()
    req = urllib.request.Request(url, headers={"User-Agent": "card-scanner-data-build"})
    with urllib.request.urlopen(req, timeout=600) as r:
        raw = r.read()
    if p:
        os.makedirs(cache, exist_ok=True)
        open(p, "wb").write(raw)
    return raw


def field(src, name):
    m = re.search(r"\b" + name + r':\s*"((?:[^"\\]|\\.)*)"', src)
    return m.group(1) if m else ""


def lang_block(src, name):
    """name: { en: "...", fr: "..." } -> dict"""
    m = re.search(r"\b" + name + r":\s*\{([^{}]*)\}", src)
    if not m:
        return {}
    return dict(re.findall(r'\b(\w\w):\s*"((?:[^"\\]|\\.)*)"', m.group(1)))


def number(src, path):
    m = re.search(r"\b" + path + r":\s*\{[^{}]*?\bcardmarket:\s*(\d+)", src, re.S)
    return int(m.group(1)) if m else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "app", "data", "pokemon.json"))
    ap.add_argument("--cache", help="folder to reuse downloaded sources (local dev)")
    a = ap.parse_args()

    tar = tarfile.open(fileobj=io.BytesIO(download(DB, a.cache, "pk_db.tgz")), mode="r:gz")
    files = {}
    for m in tar.getmembers():
        parts = m.name.split("/")
        if m.isfile() and len(parts) >= 3 and parts[1] == "data" and m.name.endswith(".ts"):
            files["/".join(parts[2:])] = tar.extractfile(m).read().decode("utf-8")

    # series ("Sun & Moon.ts" -> id "sm"), sets ("Sun & Moon/Sun & Moon.ts"), cards ("Sun & Moon/Sun & Moon/21.ts")
    serie_id = {p[:-3]: field(s, "id") for p, s in files.items() if p.count("/") == 0}
    sets = {}
    for p, s in files.items():
        if p.count("/") == 1:
            serie, name = p[:-3].split("/")
            mab = re.search(r"abbreviations:\s*\{([^{}]*)\}", s)
            ab = dict(re.findall(r'\b(\w+):\s*"([^"]*)"', mab.group(1))) if mab else {}
            cc = re.search(r"cardCount:\s*\{[^}]*official:\s*(\d+)", s)
            sets[(serie, name)] = {"id": field(s, "id"), "serie": serie_id.get(serie, ""), "name": lang_block(s, "name"),
                                   "official": int(cc.group(1)) if cc else 0, "abbr": {ab.get("official", ""), ab.get("fr", "")} - {""},
                                   "date": field(s, "releaseDate")}

    prices_raw = {g["idProduct"]: g for g in json.loads(download(CM_PRICES, a.cache, "pk_pg6.json"))["priceGuides"]}

    cards, card_idx, setnames, set_idx, prints = [], {}, [], {}, collections.defaultdict(list)
    for p, s in files.items():
        if p.count("/") != 2 or "name:" not in s:
            continue
        serie, setname, fn = p.split("/")
        st = sets.get((serie, setname))
        if not st or not st["id"]:
            continue
        local = fn[:-3]
        names = lang_block(s, "name")
        en, fr = names.get("en", ""), names.get("fr", "")
        if not en and not fr:
            continue
        rarity = field(s, "rarity")
        cm = number(s, "thirdParty")
        img = f"en/{st['serie']}/{st['id']}/{local}" if st["serie"] else ""
        ck = (en, fr, img)
        if ck not in card_idx:
            card_idx[ck] = len(cards); cards.append([en or fr, fr or en, img])
        sn = st["name"].get("fr") or st["name"].get("en") or st["id"]
        if sn not in set_idx:
            set_idx[sn] = len(setnames); setnames.append(sn)
        entry = [card_idx[ck], set_idx[sn], RARITY_FR.get(rarity, rarity), cm, 1]
        digits = re.sub(r"^0+(?=\d)", "", local)
        if re.fullmatch(r"\d+", local):
            for ab in st["abbr"]:                                  # "PBL FR 071/084" -> PBL-071
                prints[f"{ab.upper()}-{int(local):03d}"].append(entry)
            if st["official"]:                                     # "21/149"
                prints[f"{int(local)}/{st['official']}"].append(entry)
        else:                                                      # "TG01", "SV001", "SWSH050"…
            for ab in st["abbr"]:
                prints[f"{ab.upper()}-{local.upper()}"].append(entry)
            prints[f"#{local.upper()}"].append(entry)

    prices = {}
    for lst in prints.values():
        for e in lst:
            g = prices_raw.get(e[3])
            if g:
                prices[str(e[3])] = [g.get("trend") or g.get("trend-holo"), g.get("low") or g.get("low-holo"), g.get("avg7") or g.get("avg7-holo")]

    out = {"v": datetime.date.today().isoformat(), "img": IMG, "cards": cards, "sets": setnames, "prints": prints, "prices": prices}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    linked = sum(1 for l in prints.values() for e in l if e[3])
    print(f"pokemon: sets {len(sets)} | cards {len(cards)} | keys {len(prints)} | with cardmarket id {linked} | prices {len(prices)} | "
          f"{os.path.getsize(a.out)//1024} KB")


if __name__ == "__main__":
    sys.exit(main())
