# Marshal Editor

Éditeur 100 % client (HTML + CSS + JavaScript vanilla, aucune dépendance) pour ouvrir, explorer, modifier et réexporter
des fichiers sérialisés en **Ruby Marshal 4.8**. Il gère notamment :

- RPG Maker XP / VX / VX Ace : `.rxdata`, `.rvdata`, `.rvdata2` (y compris `Scripts.rxdata` compressé en zlib) ;
- les sauvegardes Pokémon SDK / Essentials : `.rxdata`, `.sav`, `.dat`, fichiers sans extension, en-tête `PKPRT`… ;
- tout autre fichier produit par `Marshal.dump`.

Aucun fichier n'est envoyé nulle part : tout est traité dans le navigateur.

## Démarrage

```bash
docker compose up -d --build
```

L'éditeur est alors disponible sur **http://localhost:8080**, et les tests sur http://localhost:8080/tests.html.

- Pour changer le port, utilisez `PORT=9000 docker compose up -d --build` ou ajoutez `PORT=9000` dans un fichier `.env`.
- Le build lance d'abord les 45 tests de round-trip dans une étape Node. **Si un test échoue, l'image n'est pas construite.**
- L'image finale est un nginx non-root (`nginx-unprivileged`, port 8080 dans le conteneur), en système de fichiers en lecture
  seule, avec en-têtes de sécurité (CSP `'self'`) et un point de santé `/healthz`.
- Pour arrêter : `docker compose down`. Pour voir les logs : `docker compose logs -f`.

## Structure

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | Interface (thème sombre) |
| `marshal-reader.js` | Parseur Marshal générique, détection de l'en-tête, décodeurs RGSS, utilitaires du modèle, zlib |
| `marshal-writer.js` | Writer (miroir exact du parseur), formatage des Float façon Ruby, export JSON |
| `tree-view.js` | Arbre virtualisé et paginé, édition en ligne |
| `search.js` | Recherche découpée en tranches (l'interface reste fluide) |
| `diff.js` | Instantanés, liste des modifications, diff hexadécimal |
| `app.js` | Contrôleur : chargement, panneau de détail, annuler/rétablir, export, raccourcis |
| `tests.html`, `tests/` | Tests de round-trip (exécutés au build Docker et servis sur `/tests.html`) |
| `samples/` | Quelques fichiers d'exemple à ouvrir dans l'éditeur |
| `Dockerfile`, `docker-compose.yml`, `nginx.conf` | Image de production (tests au build + nginx sur le port 8080) |

## Fonctionnement

### Chargement
- Glisser-déposer n'importe où dans la fenêtre, ou le bouton **Ouvrir un fichier** (Ctrl+O).
- **En-tête** : l'éditeur cherche les octets `04 08` dans les 64 premiers octets. Tout ce qui précède (ex. `PKPRT`) est
  conservé tel quel et réécrit à l'export. Si plusieurs positions sont possibles, la première qui se lit entièrement est retenue.
  Les octets éventuels **après** la fin du flux Marshal sont aussi conservés.
- **Scripts zlib** : un tableau de `[id, nom, données_zlib]` est reconnu comme un fichier Scripts. Chaque script est
  décompressé (`DecompressionStream('deflate')`) et devient éditable comme du texte. Un script modifié est recompressé
  (`CompressionStream`). Les scripts non modifiés gardent leurs octets compressés d'origine.

### Modèle et fidélité
Aucune classe n'est connue à l'avance : `PFM::Bag`, `RPG::Actor`, `Game_Party`… sont lus de façon générique sous la forme
`{ t, cls, ivars | items | entries | members, … }`. Chaque nœud est un objet JS : **l'identité JS correspond à l'identité Ruby**.
Un objet référencé plusieurs fois (`@` objlink) est donc le même nœud ; le modifier le modifie partout, et le writer réécrit
les liens `@`. Ces nœuds partagés portent le badge `⇄n`. Les symboles sont réécrits avec la même table (`:` puis `;`).

Le writer est un miroir exact du parseur (même ordre d'enregistrement des objets, y compris les cas particuliers de `u`
avec ivars, de `U` et des chaînes d'encodage). Pour un octet près :
- les **Float** gardent leur chaîne d'origine (y compris les octets de mantisse ajoutés par Ruby 1.8) tant qu'ils ne sont pas modifiés ;
  une nouvelle valeur est formatée comme Ruby ≥ 1.9 (`1.5`, `1e2`, `1e-5`, `-0`, `inf`, `nan`…) ;
- les **Bignum** gardent leurs octets d'origine ; un entier modifié passe automatiquement de `i` à `l` hors de ±2³⁰ ;
- l'ordre des ivars et des clés de hash est conservé.

À chaque chargement, l'arbre est réécrit et comparé à l'original : badge **✔ Round-trip OK** ou **⚠ Round-trip imparfait**
(avec l'offset du premier écart en infobulle).

### Chaînes
Les chaînes sont des octets. Encodage déduit des ivars `E` (true = UTF-8, false = US-ASCII) ou `encoding`.
- UTF-8, US-ASCII, ou sans encodage (Ruby 1.8 / RPG Maker XP) mais UTF-8 valide : édition en texte ;
- autre encodage connu du navigateur (Shift_JIS…) : aperçu en lecture seule + édition hexadécimale ;
- binaire non UTF-8 : édition hexadécimale.

Une chaîne US-ASCII qui reçoit des caractères non ASCII passe à `E = true`. Les nouvelles chaînes reçoivent `E = true`, sauf dans
un fichier « style Ruby 1.8 » (aucune chaîne avec encodage), où elles restent brutes comme dans RPG Maker XP.

### Décodeurs RGSS (type `u`)
| Classe | Format | Éditeur |
|---|---|---|
| `Table` | int32 dim, xsize, ysize, zsize, size + `size` × int16 | grille (fenêtre 16×16, navigation x/y/z) |
| `Color`, `Tone` | 4 × double | 4 champs |
| `Rect` | 4 × int32 | 4 champs |

Tout autre `u` (ou si la taille ne correspond pas) reste en octets bruts, éditables en hexadécimal.

### Interface
- Arbre repliable avec chemin complet (`root.@bag.@items[:revive]`), type, classe et valeur. Seules les lignes visibles sont dans le DOM.
- Grands tableaux et hashs paginés (50 / 100 / 250 / 1000 par page), avec saut direct à une page.
- Navigation au clavier : ↑ ↓ ← → et Entrée pour éditer. Double-clic sur une valeur pour l'éditer sur place.
- Panneau de détail avec le bon contrôle selon le type : champ numérique (entier ou flottant), sélecteur (booléen ou nil),
  zone de texte (chaîne), champ texte (symbole, un nom inconnu crée un nouveau symbole), grille (Table), éditeur de script, hexadécimal.
- Changement de type (ex. `nil` → `Integer`) avec confirmation et avertissement si l'objet est partagé.
- Ajout et suppression d'éléments (tableaux), d'entrées (hashs, avec clé Symbol/String/Integer), de variables d'instance (objets),
  duplication, renommage d'une clé ou d'une classe.
- Fil d'Ariane cliquable et bouton **Copier le chemin**.
- Valeurs modifiées surlignées en orange ; leurs ancêtres sont marqués d'un liseré.
- **Annuler / Rétablir** illimités.

### Recherche (Ctrl+F)
Porte sur les clés de hash, les noms d'ivars et de membres de Struct, les noms de classes et de modules, les symboles, les
chaînes (et le texte des scripts) et les nombres. Filtres : portée, type de nœud, correspondance partielle, exacte ou regex,
sensibilité à la casse. Résultats paginés ; un clic déplie l'arbre jusqu'au nœud, ouvre la bonne page et le met en évidence.

Exemple : chercher `max_potion`, cliquer sur `root.@bag.@items[:max_potion] = 2`, double-cliquer sur `2`, taper `99`, puis Entrée.

### Export
- **Voir les modifications** : `chemin : ancienne valeur → nouvelle valeur`, puis diff hexadécimal par nœud modifié
  (offset avant et après, octets avant et après, octets différents en gras), plus l'historique des actions.
- **Télécharger** (Ctrl+S) : `nom_edited.ext`, ou le nom exact si la case **nom exact** est cochée. L'en-tête et les octets de
  fin sont conservés. Le fichier produit est relu avant d'être proposé.
- **JSON** : export en lecture seule pour le débogage (`$class`, `$ref` pour les objets partagés et les cycles, `$bytes`, etc.).

### Raccourcis
| Touche | Action |
|---|---|
| Ctrl+O | Ouvrir |
| Ctrl+F | Rechercher |
| Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z) | Annuler / Rétablir (hors champ de saisie) |
| Ctrl+S | Télécharger |
| Échap | Fermer la fenêtre modale |

## Types Marshal pris en charge

`0` nil · `T` true · `F` false · `i` Fixnum (encodage variable, négatifs) · `l` Bignum · `f` Float (`inf`, `-inf`, `nan`, `-0`)
· `"` String · `:` Symbol · `;` symlink · `@` objlink · `[` Array · `{` Hash · `}` Hash avec défaut · `o` Object · `I` ivars
(dont `E` / `encoding`) · `S` Struct · `C` user class · `u` user-defined (`_dump`) · `U` user-marshal (`marshal_dump`) ·
`e` extended · `/` Regexp · `c` Class · `m` Module · `M` ancien Module · `d` Data.

## Tests

Les 45 tests tournent automatiquement à chaque `docker compose up -d --build` : round-trip octet pour octet de 27 fixtures
(une par type, plus RGSS, Scripts zlib et sauvegarde PSDK), formatage des Float, éditions, erreurs et export JSON.
Les fixtures de `tests/fixtures.js` ont été vérifiées identiques au `Marshal.dump` de Ruby 2.7 et 3.3, et des fichiers
modifiés par l'éditeur ont été relus avec succès par ces deux versions de Ruby.

Pour tester vos propres fichiers, déposez-les sur http://localhost:8080/tests.html.

## Limites connues

- **Fichiers chiffrés ou compressés en entier** (archives `.rgssad` / `.rgss3a`, certaines sauvegardes chiffrées) : non pris en charge.
  Seul un en-tête en clair de moins de 64 octets devant `04 08` est géré.
- **Encodages autres qu'UTF-8 et ASCII** (Shift_JIS, etc.) : affichage seulement, l'édition se fait en hexadécimal
  (le navigateur ne sait pas encoder ces jeux de caractères).
- **Scripts recompressés** : zlib du navigateur et zlib de Ruby peuvent produire des octets différents pour un même texte. Le
  script reste valide, mais seuls les scripts non modifiés sont identiques à l'octet près.
- **Partage des valeurs** : modifier un objet partagé (`⇄`) le modifie à tous ses emplacements, comme dans Ruby. Deux Float
  rendus égaux par une édition ne sont pas fusionnés en lien `@` (Ruby le ferait pour les flonums) ; le fichier reste valide.
- **Duplication** : copie superficielle, les sous-objets restent partagés avec l'original.
- **Encodages non canoniques** : un fichier produit par un autre outil que Ruby (entier encodé sur plus d'octets que nécessaire,
  `e` placé après `I`…) se lit correctement, mais le round-trip est signalé comme imparfait.
- **Tables RGSS** : les dimensions ne sont pas redimensionnables (seules les valeurs sont éditables) ; l'édition hexadécimale est
  désactivée au-delà de 64 Ko.
- **Clés de hash complexes** (tableaux ou objets) : affichées comme `{Type#i}`, non renommables.
- Le chemin d'un nœud partagé est celui de sa première occurrence dans le parcours.
