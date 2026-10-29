# StackPanel

Prosty webowy panel do zarządzania stackami Docker Compose – w duchu Dockge, ale z automatycznymi wolumenami, a w kolejnych etapach z backupem do S3/B2 na wzór Cloudrona, lokalnymi domenami przez Caddy i instalatorem.

> Nazwa robocza. Żeby zmienić: `package.json`, `<title>` i `.brand` w `public/`, nazwa kontenera w `compose.yaml`.

## Co działa (etap 1 – stacki)

- lista stacków ze statusem (działa / częściowo / zatrzymany),
- tworzenie stacka przez wklejenie `compose.yaml` (+ opcjonalny `.env`),
- edytor z walidacją przez `docker compose config` – błędny plik nie zostanie zapisany,
- Uruchom, Restart, Aktualizuj (pull + up), Zatrzymaj, Wyłącz – z wyjściem na żywo,
- logi na żywo, lista kontenerów z portami, historia operacji,
- usuwanie stacka do kosza (`.trash/`) – dane nie są kasowane na stałe,
- jedno konto admina, sesje i ustawienia w SQLite.

## Automatyczne wolumeny

Nie wpisujesz ścieżek na hoście. Każdy stack ma folder `/opt/stacks/<nazwa>/`, a dane aplikacji lądują w `/opt/stacks/<nazwa>/data/`:

| W compose | Po zapisie |
|---|---|
| `- /config` | `- ./data/app-config:/config` |
| `- /portainer/.../app:/config` | `- ./data/app-config:/config` |
| `- db_data:/var/lib/mysql` | `- ./data/db_data:/var/lib/mysql` |
| nic, ale obraz ma `VOLUME /data` | przy uruchomieniu dopisywane `- ./data/app-data:/data` |

Bez zmian zostają: ścieżki systemowe (`docker.sock`, `/dev`, `/etc/localtime`…), ścieżki z listy dozwolonych w Ustawieniach (domyślnie `/mnt`, `/media` – np. dyski z filmami, bez backupu), ścieżki z `${ZMIENNYMI}`, ścieżki względne wewnątrz stacka i wolumeny `external`.

Panel pokazuje po zapisie, co zmienił. Foldery tworzy przed startem z właścicielem `PUID:PGID` (domyślnie 1000:1000), żeby nie powstały jako root. Jeśli aplikacja montuje pojedynczy **plik** (np. `nginx.conf`), panel nie pozwoli wystartować bez niego, bo Docker utworzyłby w tym miejscu pusty folder.

Automatyczne wolumeny można wyłączyć dla wybranego stacka (checkbox pod edytorem).

## Instalacja na serwerze testowym

```bash
git clone https://<twoj-forgejo>/gadziunet/stackpanel.git
cd stackpanel
docker compose up -d --build
```

Panel: `http://<ip-serwera>:5001` – przy pierwszym wejściu tworzysz konto admina.

**Ważne:** folder stacków musi być zamontowany pod tą samą ścieżką w kontenerze i na hoście (`/opt/stacks:/opt/stacks`), bo panel przekazuje ścieżki do Dockera działającego na hoście.

Panel ma dostęp do `docker.sock`, czyli pełną kontrolę nad serwerem – trzymaj go tylko w sieci lokalnej / za VPN.

### Uruchomienie bez Dockera (do developmentu)

```bash
npm install
STACKS_DIR=/opt/stacks npm run dev
```

Wymaga Node 20+ oraz `docker` z wtyczką `compose` na tej samej maszynie.

### Zmienne środowiskowe

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `5001` | port panelu |
| `STACKS_DIR` | `/opt/stacks` | folder ze stackami |
| `DATA_DIR` | `./data` (w obrazie `/app/data`) | baza SQLite panelu |

## Przeniesienie aplikacji z Dockhand

1. Utwórz folder `/opt/stacks/<nazwa>/data/` i skopiuj dane, np. `/portainer/Files/AppData/Config/<app>` → `/opt/stacks/<nazwa>/data/<serwis>-config` (dokładną nazwę folderu panel pokaże po zapisie compose).
2. Zatrzymaj stack w Dockhand.
3. W panelu utwórz stack z tym samym compose – ścieżki zostaną przepięte na `./data/...`.
4. Uruchom i sprawdź.

Panel pozwala utworzyć stack w istniejącym folderze bez `compose.yaml`, więc możesz najpierw wgrać dane, a potem dodać stack.

## Struktura

```
src/
  server.js    – Express, API, sesje
  db.js        – SQLite (better-sqlite3, WAL), migracje, ustawienia
  auth.js      – hasła (scrypt), sesje, limit logowań
  stacks.js    – operacje na stackach, uruchamianie docker compose
  compose.js   – automatyczne wolumeny (przepisywanie YAML z zachowaniem komentarzy)
  docker.js    – wywołania CLI docker bez powłoki
public/        – interfejs (czysty JS, bez budowania)
test/          – testy logiki wolumenów (npm test)
```

## Plan

- [x] **Etap 1:** stacki, edytor, automatyczne wolumeny, logi
- [ ] **Etap 2:** domeny lokalne przez Caddy (API, wildcard DNS-01 Bunny / `tls internal`)
- [ ] **Etap 3:** backupy jak w Cloudronie – per stack, przed aktualizacją, dumpy baz po labelce, harmonogram, retencja, szyfrowanie, restic → S3/B2, restore i klon
- [ ] **Etap 4:** instalator jednym poleceniem + kreator „nowa instalacja / przywróć z backupu”
