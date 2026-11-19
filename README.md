# Card Scanner

Site web mobile pour scanner des cartes Yu-Gi-Oh une par une et exporter un CSV importable sur Cardmarket.
Il fonctionne sans serveur et sans IA : le code de set est lu sur le téléphone (PaddleOCR via ONNX Runtime), puis comparé
aux codes qui existent vraiment (base YGOPRODeck). Les cotes viennent du guide des prix public de Cardmarket.

## Contenu

| Dossier / fichier | Rôle |
|---|---|
| `app/` | Le site publié (page, scanner, liste, export, mode hors ligne) |
| `app/vendor/paddle/`, `app/vendor/ort/` | Moteur de lecture de texte (PaddleOCR + ONNX Runtime), embarqué pour marcher hors ligne |
| `tools/build_data.py` | Construit `app/data/cards.json` (cartes, codes, identifiants et cotes Cardmarket) |
| `tools/make_icons.py` | Dessine les icônes de l'appli |
| `.github/workflows/deploy.yml` | Chaque nuit : reconstruit les données et republie le site sur GitHub Pages |
| `prototype/` | Première version (page Claude), gardée pour référence |

## Mettre en ligne (une seule fois)

1. Crée un compte sur github.com et installe **GitHub Desktop**.
2. Dans GitHub Desktop : *File › Add local repository* › choisis ce dossier › accepte de créer le dépôt.
3. *Publish repository*, nom `card-scanner`, **décoche « Keep this code private »** (GitHub Pages gratuit demande un dépôt public).
4. Sur github.com, dans le dépôt : *Settings › Pages › Source* : **GitHub Actions**.
5. Onglet *Actions* › « Publier le site » › *Run workflow*. Au bout de 2 à 3 minutes, le site est à
   `https://<ton-pseudo>.github.io/card-scanner/`.

## Installer sur iPhone

Ouvre l'adresse dans **Safari** › bouton Partager › **Sur l'écran d'accueil**.

## Mettre à jour

Les cotes et la base de cartes se mettent à jour seules chaque nuit. Pour publier une modification du code :
GitHub Desktop › *Commit to main* › *Push origin*.

## Tester sur le PC

```powershell
python tools/build_data.py
python -m http.server 8766 --directory app
```
Puis ouvrir http://localhost:8766 (la caméra marche sur `localhost`).

