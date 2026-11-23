# Card Scanner — mémo pour Claude

Site web mobile (PWA) pour scanner des cartes (Yu-Gi-Oh, One Piece, Pokémon, Riftbound) une par une
et exporter un CSV Cardmarket. Sans serveur : lecture du code de set sur le téléphone (PaddleOCR via
ONNX Runtime), comparaison avec la base de cartes, cotes du guide des prix Cardmarket.
Publié sur GitHub Pages (dépôt public `BrouawnBCP/card-scanner`, workflow `.github/workflows/deploy.yml`).

**Toujours répondre en français.** L'utilisateur teste sur son téléphone et envoie des captures ;
il demande « commit » quand il valide.

## Commandes

- Données : `python tools/build_data.py` (et `build_onepiece.py`, `build_pokemon.py`, `build_riftbound.py`).
- Serveur local : `python -m http.server 8766 --directory app` (config `card-scanner` de
  `.claude/launch.json`), puis http://localhost:8766.
- Retours des testeurs : `python tools/discord_feedback.py [--since AAAA-MM-JJ]` → `feedback/discord.md`.
- **Git** n'est pas dans le PATH : utiliser celui de GitHub Desktop
  `(Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop\app-*\resources\app\git\cmd\git.exe" | Select-Object -Last 1).FullName`.
  Commiter seulement les fichiers modifiés, message en français. Ne pas pousser (l'utilisateur fait « Push origin »).
- Ne jamais lire, afficher ni commiter `discord-token.txt` (secret) ; `feedback/` et
  `tools/rarity_overrides.json` restent hors du dépôt (privés).

## Économiser la limite d'usage (important)

Les fichiers de ce projet sont très gros : les lire en entier épuise vite la limite.

- `app/app.js` (~170 Ko) : **jamais en entier**. Chercher avec Grep (nom de fonction, texte affiché),
  puis lire seulement l'extrait utile (`offset` / `limit`, 50 à 150 lignes).
- `app/style.css` (~50 Ko), `app/index.html` (~30 Ko) : même règle, par extraits.
- `app/data/*.json` (jusqu'à 5 Mo) : **ne jamais les ouvrir**. Interroger avec une ligne de Python
  (`python -c "import json; d=json.load(open('app/data/cards.json')); ..."`) qui n'affiche que le résultat.
- `app/vendor/` (moteur OCR) : ne pas lire.
- `feedback/diag-*` : lire d'abord `session.json` ; ouvrir au plus 2 ou 3 images de `frames/`, celles
  qui concernent le problème. Ne jamais ouvrir les `.zip` (15 à 36 Mo).
- `feedback/discord.md` : lire seulement les sections récentes ou concernées.
- `prototype/` : ancienne version, ne pas lire sauf demande.
- Vérifier par un test ciblé (Python ou JavaScript dans la page), pas par des captures d'écran ;
  une ou deux captures au plus pour un changement visuel (préférer `get_page_text` / `read_page`).
- Pas d'audit complet sauf demande ; réponses courtes.
