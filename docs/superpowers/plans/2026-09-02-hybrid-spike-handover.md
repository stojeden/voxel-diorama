# Przekazanie spike'u hybrydy — instrukcja dla następnego agenta

> **Nieaktualne od 2 września 2026, 15:15.** Rozdział 5 („Co zostało do zrobienia") jest
> wykonany w całości. Aktualny stan, wyniki i jedna rekomendacja są w
> `docs/superpowers/spike/2026-09-02-hybrid-spike-report.md`. Ten dokument zostaje jako zapis
> zasad nienegocjowalnych (rozdział 2), środowiska (3), mapy kodu (4) i pułapek (7), które
> nadal obowiązują.

Stan na 2 września 2026, po commicie `4c10726` na gałęzi `worktree-spike-hybrid-osiedle-centralne`.
Właściciel projektu (Piotr) zatrzymał pracę po tym commicie i przekazuje ją dalej. Ten dokument
ma wystarczyć do wznowienia bez czytania historii rozmowy.

## 1. Czym to jest i czym nie jest

- To **odwracalny spike** kierunku „hybryda soft-voxel i makiety architektonicznej” dla jednego
  fragmentu miasta (Osiedle Centralne) w prawdziwym rendererze Dioramy, za flagą developerską.
- Hybryda jest **zatwierdzona do spike'u, nie jako zamrożony art direction ani plan wdrożenia**.
  Spike kończy się renderami, pomiarami i **jedną rekomendacją: wdrażamy, upraszczamy albo
  odrzucamy**. Rekomendację formułuje agent, decyzję podejmuje właściciel.
- Nie robimy kolejnej rundy kierunków ani konceptowania. Kontekst wizualny (porównanie trzech
  kierunków, zaakceptowany hero corner) jest w artefakcie właściciela
  „Trzy kierunki Miasta”: https://claude.ai/code/artifact/a8b991b2-7b85-458e-aaf3-9fc45fde7cab

Dokumenty źródłowe w repo (gałąź spike'u):

- spec: `docs/superpowers/specs/2026-09-02-hybrid-spike-design.md`
- plan z checkboxami: `docs/superpowers/plans/2026-09-02-hybrid-spike.md`
- ten dokument: `docs/superpowers/plans/2026-09-02-hybrid-spike-handover.md`
- wyniki smoke spike'u: `docs/superpowers/spike/spike-smoke.json`, kadry w
  `docs/superpowers/spike/frames/` (niecommitowane; odtwarza je `node scripts/spikeSmoke.mjs`)

Pamięć projektu Claude Code (`~/.claude/projects/-Users-piotr-Projekty-voxel-diorama/memory/`)
zawiera notatki `hybrid-spike-mandate.md` i `art-direction-status.md` z tymi samymi decyzjami.

## 2. Zasady nienegocjowalne (słowa właściciela)

1. Zakres: jeden fragment za flagą `?world=hybrid-direct|hybrid-greedy`. Domyślny świat
   (`voxel`) ma pozostać bit w bit dzisiejszym produktem.
2. Dwie strategie geometrii porównujemy **na tym samym wejściu semantycznym**
   (`SurfacePrimitive[]`). Po decyzji przegrana implementacja zostaje usunięta; nie utrzymujemy
   dwóch równoległych rendererów. **Nie usuwaj żadnej strategii przed decyzją właściciela.**
3. **Bez podnoszenia limitów paczki przed wynikami.** Chunk wejściowy `index-*.js` ≤ 240 000 B
   (teraz 238 589 B, zapas 1,4 kB), `main-*.js` ≤ 50 000 B. Cały kod spike'u jest w chunku
   `hybrid-spike-*.js` (dynamic import). Do chunku wejściowego wolno dopisać tylko minimalny glue.
4. Cztery bramki spike'u:
   - **Bramka 1, kadry:** obecny overview, prawdziwy street-eye ~1,7 m, noc lub golden hour.
     Autobus nie stoi na zebrze, mieszkaniec jest czytelny, witryny mają proceduralną treść,
     ekspozycja nie wypala dalszego planu.
   - **Bramka 2, pomiar apples-to-apples w pipeline Dioramy:** trójkąty passu głównego i
     multipass, draw calle, programy, czas generowania, pamięć, p95 CPU/GPU na High i Low.
     Obowiązują istniejące progi: ≥ 58 FPS, p95 ≤ 20,5 ms, ≤ 1400 draw calli, ≤ 500 geometrii,
     ≤ 80 tekstur, TTI ≤ 1800 ms.
   - **Bramka 3, LOD:** screen-space, histereza, warstwy addytywne, bez widocznego poppingu w
     tourze. Kohorty okien, motywy, śnieg, mokrość i deterministyczny seed mają identyczną
     semantykę na każdym poziomie.
   - **Bramka 4, wysokości:** bazowe wysokości zostają w metrach; ×1,8 tylko dla jawnie
     oznaczonych punktowców; dachy, balkony i partery przechodzą kontrolę kolizji, tras i anchorów.
5. **Ground contact i clearance:** oba koła roweru dotykają nawierzchni i jej nie przecinają;
   rower oparty ma wiarygodny przechył i punkty podparcia; stojak obejmuje koło; mieszkańcy stoją
   dokładnie na chodniku; ławki, kosze, wiaty i latarnie nie wiszą ani nie zapadają się; autobus
   zatrzymuje się przy przystanku i nie stoi na przejściu. Kontrola działa także po zmianie LOD.
6. **Duet dominant: komin ciepłowni i wieża RTV** (nie wieża zegarowa). Wieża: smukła,
   brutalistyczna, platforma techniczna, anteny, czerwone światła lotnicze, wariant Low, punkt
   orientacyjny a nie kolos; przyszłe transmisje i mruganie to tylko haki w danych, nic nie
   implementujemy. Dwa miejsca, jedno rekomendowane: **A (16, −66)** przy Dworcu Południowym,
   alternatywa **B (−70, 22)** przy Stacji Zachodniej.
7. 100% proceduralnie: geometria z prymitywów Three.js; `CanvasTexture` tylko dla napisów.
   Determinizm: wyłącznie seed layoutu, zero losowości na klatkę, żadnych zmian w strumieniach RNG
   symulacji.
8. Nie ruszaj `src/experience/Checkpoints.ts` (test kontraktu wymaga dokładnie 14 checkpointów;
   checkpointy spike'u żyją w chunku spike'u) ani `src/world/WorldLayout.ts` (działki, trasy,
   anchory są prawdą dla nawigacji i 38 testów).

## 3. Środowisko i komendy

Worktree: `/Users/piotr/Projekty/voxel-diorama/.claude/worktrees/spike-hybrid-osiedle-centralne`
(gałąź `worktree-spike-hybrid-osiedle-centralne`, bazuje na `main` `d83f7c6`). `node_modules`
jest symlinkiem do `node_modules` głównego repo; nie uruchamiaj `npm install` bez potrzeby.
Główny checkout ma w `.git/info/exclude` wpis `.claude/worktrees/`.

```bash
node_modules/.bin/tsc --noEmit          # typecheck
node_modules/.bin/vitest run            # 225 testów, wszystkie zielone na 4c10726
node_modules/.bin/vite build            # buduje dist/; sprawdź rozmiary w dist/assets
node scripts/browserSmoke.mjs           # domyślny smoke produktu (flaga off) — musi być zielony
node scripts/spikeSmoke.mjs             # kadry + styk + LOD + budżety dla obu strategii
```

Benchmark (bramka 2), zawsze jeden świat naraz, przy zamkniętych innych kartach Dioramy:

```bash
BENCH_WORLD=voxel BENCH_QUALITY=high BENCH_SCENARIO=spike-overview,spike-street,spike-golden,spike-night-street node scripts/performanceBenchmark.mjs > docs/superpowers/spike/bench-voxel-high.json
```

Powtórz dla `BENCH_WORLD=hybrid-direct` i `hybrid-greedy` oraz dla `BENCH_QUALITY=low`
(6 uruchomień). Skrypt wypisuje JSON na stdout, a asercje progów rzuca na stderr; kod wyjścia
różny od zera oznacza przekroczony próg, ale JSON i tak jest zapisany. `BENCH_WORLD=voxel`
z filtrem `spike-*` ładuje te same kadry bez podpinania fragmentu, więc porównanie jest uczciwe.

Ograniczenia harnessu, na które natknął się poprzedni agent:

- W sesji w worktree Bash odrzuca „złożone” komendy: pętle `for`, `cd` do innego katalogu,
  komendy git dotykające głównego repo. Pisz proste łańcuchy `a && b && c` albo skrypty w plikach.
- Nie używaj gołego `git stash` (współdzielony stos); rób tymczasowe commity.
- Playwright używa systemowego Chrome (`/Applications/Google Chrome.app/...`) z Metal; nagłówkowy
  Chromium Playwrighta nie jest zainstalowany i nie pobieraj go bez pytania.
- Podgląd w panelu przeglądarki: `window.__diorama` (setTime, setWeather, applyTheme,
  debugBusStop, hybridGroundContact, getMetrics). Zamrożony checkpoint ma `delta = 0`, więc
  pasażerowie nie „wchodzą” w opacity; `debugBusStop('Osiedle Centralne')` pokazuje ich natychmiast.

## 4. Mapa kodu

Wszystko w `src/world/hybrid/` (chunk `hybrid-spike`), poza `spikeFlag.ts`, które importuje
`main.ts` statycznie i przez to siedzi w chunku wejściowym.

| Plik | Odpowiedzialność |
|---|---|
| `spikeFlag.ts` | parsowanie `?world=`, definicja fragmentu (bloki 3, 4, 5, 24, 25; prostokąt chodników; dziedziniec), zbiór punktowców `{5}`, predykat wykluczenia komórek gruntu |
| `families.ts` | rodzina bloku (płyta, punktowiec, kamienica, niski blok) i `floorPlan()`: piętra z wysokości w metrach; ×1,8 tylko dla `pointTower` |
| `CityModel.ts` | czysty, deterministyczny model fragmentu: budynki, chodniki, krawężniki, dziedziniec, przejście, rekwizyty z sondami styku, dominanty; `groundHeightAt()` (grunt płaski) |
| `palette.ts` | 32 wpisy palety z `origin` w `COLORS` (motywy propagują się tą samą różnicą HSL), flagi śniegu i mokrości, emisja |
| `HybridMaterial.ts` | jeden `MeshStandardMaterial` z `onBeforeCompile`: paleta w uniformach, kohorty okien, śnieg, mokrość, AO, style (spoiny płyty, siatka płyt, łaty asfaltu, szkło) |
| `surface.ts` | typy `SurfacePrimitive` (box, plane, prism, cylinder, torus), `Emitter`, dachy czworo- i dwuspadowe |
| `architecture.ts` | rodziny → prymitywy z warstwami LOD (0 bryły, 1 otwory i balkony, 2 ramy i drobiazgi) |
| `streetscape.ts` | chodniki, krawężniki, zebra, stojak, rowery, kosz, donica, tablica, żywopłot |
| `dominants.ts` | komin z kotłownią i wieża RTV (High i Low), walidacja miejsca, azymut z domyślnej kamery |
| `strategies/strategy.ts` | kontrakt atrybutów (`aPalette`, `aCohort`, `aAo`, `aStyle`) i statystyki |
| `strategies/DirectSurfaceStrategy.ts` | strategia A: prymityw → geometria Three.js → merge per klasa materiału i warstwa |
| `strategies/GreedyVoxelStrategy.ts` | strategia B: voxelizacja siatką 0,25 m wyrównaną do świata, greedy meshing, AO voxelowe, licznik „dilated” |
| `ScreenSpaceLod.ts` | piksele na metr, progi 9/7 i 36/30 px/m, cooldown 0,25 s, `maxLevel` |
| `GroundContact.ts` | sondy styku (12 mm), prostokąty kolizji, koperta autobusu na postoju |
| `HybridSpike.ts` | `attachHybridSpike()`: buduje klastry, meshe per klasa i warstwa, grupy LOD, hooki (theme, snow, wet, quality), metryki, raycastowa kontrola styku |
| `spikeCheckpoints.ts` | cztery kadry: `spike-overview`, `spike-street`, `spike-golden`, `spike-night-street` |

Punkty integracji poza katalogiem: `src/main.ts` (flaga, wykluczenia, dynamic import, hooki w
pętli, `getMetrics().hybrid`, `hybridGroundContact`), `src/bootstrap.ts` (`LambdaPass` po
`RenderPass` zapisuje trójkąty i draw calle passu głównego), `src/world/WorldGenerator.ts`
(`WorldGeneratorOptions`: `excludeBlocks`, `excludeGroundCell`), `vite.config.js` (grupa
`hybrid-spike`), `scripts/spikeSmoke.mjs`, `scripts/performanceBenchmark.mjs` (`BENCH_WORLD`).

## 5. Co zostało do zrobienia

Kolejność ma znaczenie. Każdy krok kończy się zielonym `tsc`, `vitest` i commitem na gałęzi.

1. **Odnów kadry po ostatniej poprawce.** `node_modules/.bin/vite build && node scripts/spikeSmoke.mjs`.
   Ostatni commit wyłączył komórki dziedzińca z gruntu voxelowego (koniec z-fightingu przed
   kamienicą), ale kadry na dysku są sprzed tej zmiany. Obejrzyj wszystkie 12 kadrów, w tym Low.
2. **Bramka 2: benchmark.** Sześć uruchomień jak w rozdziale 3, sekwencyjnie. Zestaw tabelę:
   FPS, p95, p99, hitch, draw calle, trójkąty passu głównego i multipass, programy,
   `hybrid.generationMs`, `hybrid.bytes`, `jsHeapBytes`, TTI. Uwaga: „primary” zawiera pass
   cieni (renderuje się w `RenderPass`), a multipass to głównie pass normalnych SSAO, który w
   kadrze ulicznym dokłada ~320 tys. trójkątów niezależnie od strategii.
3. **Bramka 3: dowody LOD i semantyki.** Uruchom tour z flagą (`__diorama.startTour()`) i
   obserwuj `getMetrics().hybrid.lodLevels` oraz obraz: przełączenia mają dodawać tylko drobne
   elementy. Sprawdź nocny kadr (kohorty), `applyTheme('retro')` i `applyTheme('cyberpunk')`,
   `debugSetSnowCover(1)`, `setWeather('rain')`, oraz że dwa świeże uruchomienia z tym samym
   seedem dają identyczne `hybrid.triangles` i `bytes`. Jeśli chcesz to zautomatyzować, dopisz
   do `spikeSmoke.mjs`, nie do `browserSmoke.mjs`.
4. **Bramka 4: kolizje.** Testy wysokości i działek już są (`CityModel.test.ts`). Brakuje
   sprawdzenia, czy wysunięte elementy nie kolidują z trasami pieszych: loggie i balkony wystają
   0,84–1,3 m, ale dopiero od pierwszego piętra (≥ 2,8 m nad ziemią); wykusze witryn wystają
   0,26 m w parterze. Sprawdź je względem `busStopWalkingPath`, `busShelterColliders`
   (`src/world/BusStopNavigation.ts`, promień pieszego 0,32 m), `STATIC_PROP_FOOTPRINTS` i trasy
   listonosza (`POSTMAN_ROUTE_CURVE`). Napisz to jako test jednostkowy na modelu.
5. **Raport z jedną rekomendacją.** Plik `docs/superpowers/spike/2026-09-0X-hybrid-spike-report.md`
   plus strona-artefakt dla właściciela (język polski, ten sam ton co strona porównania). Bramka po
   bramce z dowodami: kadry, tabele pomiarów, LOD, semantyka, wysokości, raport styku, miejsca
   dominant z azymutami, liczba „dilated” dla greedy, rozmiary chunków. Zakończ jedną
   rekomendacją i nazwij strategię do usunięcia. Nie usuwaj jej sam.
6. Na końcu użyj skillu `superpowers:finishing-a-development-branch`; nie merguj do `main` bez
   decyzji właściciela. Zaktualizuj notatki w pamięci projektu.

Czego nie robić: nie rozszerzaj fragmentu, nie dodawaj drzew ani wiaty w nowym języku (celowo
poza zakresem), nie implementuj mrugania świateł ani transmisji, nie zmieniaj budżetów, nie
zmieniaj `main` poza glue, nie usuwaj przegranej strategii.

## 6. Wyniki dotychczasowe

Smoke spike'u na M1 Pro, viewport 1440×900, `renderer.info` całej klatki (primary zawiera cienie):

| Świat | Jakość | Kadr | Draw calle | Trójkąty | Primary | Trójkąty hybrydy L0/L1/L2 | Generacja | LOD klastrów |
|---|---|---|---|---|---|---|---|---|
| hybrid-direct | high | overview | 604 | 575 961 | 575 958 | 2 938 / 9 158 / 8 640 | 29 ms | 01111100 |
| hybrid-direct | high | street | 473 | 896 293 | 573 136 | 2 938 / 9 158 / 8 640 | 26 ms | 22222211 |
| hybrid-direct | high | golden | 606 | 575 995 | 575 992 | 2 938 / 9 158 / 8 640 | 24 ms | 01111100 |
| hybrid-direct | high | night-street | 349 | 639 659 | 316 434 | 2 938 / 9 158 / 8 640 | 25 ms | 22222211 |
| hybrid-direct | low | street | 153 | 310 847 | 310 844 | 2 394 / 8 162 / 8 640 | 25 ms | 11111111 |
| hybrid-greedy | high | overview | 603 | 590 685 | 590 682 | 10 230 / 10 026 / 8 306 | ≈1 060 ms | 01111100 |
| hybrid-greedy | high | street | 473 | 903 653 | 580 636 | 10 230 / 10 026 / 8 306 | ≈1 060 ms | 22222211 |
| hybrid-greedy | low | street | 153 | 310 303 | 310 300 | 9 962 / 9 160 / 8 306 | ≈1 050 ms | 11111111 |

Chunki: `index` 238 589 B (limit 240 000), `main` 33 311 B (limit 50 000), `hybrid-spike` 40 956 B.
Klastry w kolejności LOD: bloki 3, 4, 5, 24, 25, streetscape, komin, wieża.

Obserwacje, które powinny trafić do raportu:

- Strategia bezpośrednia generuje fragment w ~25 ms; greedy w ~1 s i musi pogrubiać wszystko
  cieńsze niż 0,25 m do jednej komórki (ramy, szprosy, krawężniki, koła rowerów) — licznik
  `dilated` w `getMetrics().hybrid`. Greedy daje za to AO voxelowe „za darmo”.
- Cała hybryda fragmentu to ~21 tys. trójkątów (direct) wobec ~576 tys. całej sceny; koszt
  geometrii nie jest problemem, problemem jest pass normalnych SSAO przy bliskich kamerach.
- Chodnik zostawiono na wysokości gruntu produktu, a krawężnik jest listwą 0,12 m: podniesiony
  chodnik zatapiałby wiaty, latarnie i pasażerów, których stawia produkt. Prawdziwy podniesiony
  chodnik wymaga przesunięcia tych obiektów i jest tematem po spike'u.
- Drzewa, kiosk i wiata wewnątrz fragmentu pozostają voxelowe (poza zakresem); w kadrach to widać.
- Wieża RTV ma 56 m (szyb 40 m, platforma 31 m, górna 37 m, maszt do 56 m), komin 46 m; przy 62 m
  maszt ucinał się w domyślnym kadrze.

## 7. Pułapki znalezione po drodze

- `patch` jest słowem zarezerwowanym w GLSL ES 3.00; shader z taką zmienną nie kompiluje się
  po cichu (obiekty znikają, cienie zostają).
- Siatkę greedy trzeba wyrównać do kraty świata (`floor(min/cell)*cell`); bez tego chodnik
  wychodził 3 cm wyżej i kontrola styku zgłaszała „sink”.
- Szyba schowana wewnątrz pełnej bryły jest niewidoczna; szkło leży 1,5 cm przed ścianą, a
  wnękę udaje wypieczony cień (`aAo`). Prawdziwa wnęka to temat spike'u produkcyjnego.
- Bramka smoke'u produktu wymaga dokładnie jednego canvasa i jednego `requestAnimationFrame` na
  klatkę; nie dodawaj własnych pętli renderowania.
- `renderer.info` liczy wszystkie passy klatki; `main.ts` resetuje go przed `composer.render`.
- Testy: `Checkpoints.test.ts` sprawdza 14 checkpointów; `WorldLayout.test.ts` pilnuje kolizji,
  tras i anchorów; `WorldGenerator.test.ts` pilnuje budżetu świateł.

## 8. Komunikacja z właścicielem

Piotr pisze po polsku, krótko, bramkami. Chce faktów z dowodami, nie zapewnień. Nie podnosi
limitów przed wynikami i nie akceptuje rozszerzania zakresu bez pytania. Kiedy pisze
„zatrzymaj pracę”, dokończ bieżący commit i stań. Gdy nie ma go przy klawiaturze, wykonaj to,
co nie zależy od jego odpowiedzi, a pytania zadaj w podsumowaniu.
