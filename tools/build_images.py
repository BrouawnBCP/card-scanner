"""Download card pictures once from YGOPRODeck and store them as small WebP thumbnails.

YGOPRODeck asks that images are downloaded a single time and re-hosted, never hotlinked
and never pulled at a high rate. So this script:
  - only fetches pictures that are not already in the output folder,
  - waits between requests (about 5 per second, below their 20/s API limit),
  - stops after --max downloads per run (the rest comes on the next nights).

Usage: python tools/build_images.py --data app/data/cards.json --out <folder>
Needs Pillow (pip install pillow).
"""
import argparse, io, json, os, sys, time, urllib.request, urllib.error

from PIL import Image

SRC = "https://images.ygoprodeck.com/images/cards_small/{id}.jpg"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=112)   # 2× the 56 px shown in the app
    ap.add_argument("--max", type=int, default=16000)
    ap.add_argument("--delay", type=float, default=0.2)
    a = ap.parse_args()

    cards = json.load(open(a.data, encoding="utf-8"))["cards"]
    ids = sorted({c[2] for c in cards if len(c) > 2 and c[2]})
    os.makedirs(a.out, exist_ok=True)
    have = {f[:-5] for f in os.listdir(a.out) if f.endswith(".webp")}
    missing_log = os.path.join(a.out, "missing.txt")
    missing = set(open(missing_log).read().split()) if os.path.exists(missing_log) else set()
    todo = [i for i in ids if str(i) not in have and str(i) not in missing][: a.max]
    print(f"{len(ids)} cards, {len(have)} thumbnails already stored, {len(todo)} to download")

    done = failed = 0
    for n, cid in enumerate(todo, 1):
        req = urllib.request.Request(SRC.format(id=cid), headers={"User-Agent": "card-scanner-thumbnails/1.0 (one-time download, self-hosted)"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            h = round(im.height * a.width / im.width)
            im.resize((a.width, h), Image.LANCZOS).save(os.path.join(a.out, f"{cid}.webp"), "WEBP", quality=70, method=6)
            done += 1
        except urllib.error.HTTPError as e:
            if e.code == 404:
                missing.add(str(cid))
            else:
                failed += 1
                if e.code == 429:
                    print("rate limited, stopping for tonight"); break
        except Exception as e:  # network hiccup: retried on the next run
            failed += 1
        if n % 500 == 0:
            print(f"  {n}/{len(todo)}")
        time.sleep(a.delay)

    open(missing_log, "w").write("\n".join(sorted(missing)))
    print(f"downloaded {done}, not found {len(missing)}, failed {failed}")


if __name__ == "__main__":
    sys.exit(main())
