# Hybryda Miasta — domknięcie iteracji, 2026-09-04

Gałąź `spike-hybrid-osiedle-centralne`, drzewo robocze `.claude/worktrees/spike-hybrid-osiedle-centralne`.
**Nic nie zmergowane, nic nie wypchnięte, nic nie wdrożone.** `main` nietknięty.

Wszystkie liczby pochodzą z jednego sekwencyjnego przebiegu na rewizji **`e4e28f7`**, z
czystego drzewa, z jednej podpisanej paczki:

| | |
|---|---|
| commit | `e4e28f7fdb206f33cd3dc67cb69ed8c444881a28` |
| drzewo źródeł | `65714cd14e472f9a17aa135b75e334398d4480b4` |
| entry chunk | `index-Dei4cSsb.js`, 239 960 B, `sha256 051a38bb…` |
| cały `dist` | 12 plików, 1 337 323 B, hash zbiorczy `eb11423fda88` |
| paczki | entry 239 960 B / **limit 240 000**, main 33 311 B, hybrid-spike 34 305 B |

Dwanaście z trzynastu artefaktów nosi ten stempel w środku; każdy pomiar sprawdził go
przed wyrenderowaniem klatki. Jeden renderer naraz, wymuszony plikowym lockiem, który
obejmuje też build. Manifest i indeks dowodów: `build-manifest.json`,
`evidence-index.json`.

---

## 1. Pasażerowie: jedno rozstawienie, wołane przez runtime i test

`busStopWaitingPlacements` w `src/world/BusStopNavigation.ts` zwraca `waitPos`, `doorPos`
i `facing`. Wołają je: `Bus.ts` (buduje tłum), `clearance.test.ts` (mierzy bryły, ścieżkę
i pobyt pod dachem) oraz `BusStopNavigation.test.ts` (trasa wokół przeszkód). W kodzie
testów nie ma już **żadnego** własnego punktu drzwi.

Runtime rozdziela pasażerów na dwie kolejki do drzwi odległe o 3,2 m, więc nie patrzą w tę
samą stronę — a kierunek decyduje o głębokości obróconej figury. Na prawdziwych kierunkach
**cztery figury się nie mieszczą**: dwie najszersze sąsiadki mierzą 0,90 i 0,91 m w poprzek
rzędu i zachodzą na siebie o 0,002 m; rozstaw 1,0 m wypycha skrajną bryłę za 3,84 m
światła między słupkami.

**Trzy figury, 1,2 m odstępu, 0,25 m przed linią słupków:**

| figura | kierunek | szerokość × głębokość | odstęp do następnej |
|---|---|---|---|
| #0 | 173° | 0,90 × 0,48 m | **0,336 m** |
| #1 | 140° | 0,83 × 0,75 m | **0,359 m** |
| #2 | −144° | 0,85 × 0,72 m | — |

Zajmują 3,28 m z 3,84 m światła, są czyste wobec ławki i pod dachem 2,0 m; pobyt pod
dachem sprawdzany na **obróconym obrysie**, nie na nominalnym pudełku. Wymagany prześwit:
0,05 m. Liczba została zmniejszona, nie wciśnięta tolerancją.

---

## 2. Budżet świateł: prawdziwe „przed" i „po"

`scripts/windowLightPrePost.mjs` odtwarza obie konfiguracje jawnie: **bazową** przez
`DayNightCycle.windowLightBudget = 2` (światła zapala runtime, swoją intensywnością z
zegara i krzywej aktywności mieszkańców) i **przyjętą** przez wycofanie tych samych
świateł dokładnie tak, jak robi to budżet 0. Pętla animacji zaparkowana, rendering z deltą
0, ta sama klatka renderowana dwa razy jako kontrola. Światła identyfikowane po
**tożsamości obiektu**.

### 2.1 Przyjęta zmiana: dwie pule okien (`light-budget-pre-post-windowLights.json`)

| kadr | ostrość | świateł | kontrola | zmienione | szczyt ΔL |
|---|---|---|---|---|---|
| nocna ulica | 17,9 m | 14 → 16 | **0 px** | 0 px (0 %) | 0 |
| bliska fasada | 19,3 m | 14 → 16 | **0 px** | **497 px (0,03 %)** | 12 |
| przystanek i autobus | 14,7 m | 14 → 16 | **0 px** | 0 px (0 %) | 0 |
| pociąg | 114,3 m | 5 → 5 | **0 px** | 0 px (0 %) | 0 |
| swobodna kamera | 232,4 m | 5 → 5 | **0 px** | 0 px (0 %) | 0 |

Dwa ostatnie kadry pokazują 5 → 5, bo runtime sam zeruje ten budżet powyżej 112 m ostrości
(`DayNightCycle.setCameraFocusDistance`) — w szerokim kadrze zmiana **nie może** być
widoczna, i te kadry są na to dowodem. Ich hashe wyrenderowanych pikseli są identyczne
(`854fe2b5c08b`), co harness sprawdza jako warunek.

Kadr „bliska fasada" jest celowany w jedno z dwóch świateł po tożsamości, więc tam różnica
**musi** wystąpić — harness to wymusza. Same pule stoją przy fasadach na x ≈ 52–68, więc w
nocnej ulicy i na przystanku nie ma ich w kadrze.

### 2.2 Odrzucona alternatywa: dwie latarnie (`light-budget-pre-post-streetLamps.json`)

| kadr | zmienione | procent | szczyt ΔL |
|---|---|---|---|
| nocna ulica | **475 140 px** | **27,74 %** | 105 |
| bliska fasada | 140 041 px | 8,18 % | 221 |
| przystanek i autobus | 172 559 px | 10,07 % | 36 |
| pociąg / swobodna kamera | 0 px | 0 % | 0 |

**0,03 % wobec 27,74 % w tym samym kadrze.** Przy danej liczbie świateł dowolne dwa
oszczędzają podobnie, więc wybór rozstrzyga obraz — i rozstrzyga go z ogromnym marginesem.
Oświetlone mieszkanie zachowuje emisyjne okno; traci tylko plamę na własnej fasadzie.
Latarnia zabiera ze sobą jezdnię.

---

## 3. Koszt świateł na rewizji końcowej

Vsync wyłączony. Stałe: ziarno, checkpoint nocnej ulicy, kamera, profil High, pixel ratio
1,15, kanwa 1655×1035. Trzy próbki na wariant, kolejności `given`, `reverse`, `shuffle`,
oba światy w jednym procesie na przemian. Każdy wiersz nosi liczbę świateł **rzeczywiście
aktywnych**, nie zamówiony limit.

### 3.1 Konfiguracja z przywróconymi pulami (`light-cost-sweep-windowpools.json`)

| aktywnych | hybryda | produkt |
|---|---|---|
| 16 | **13,73 ms** | **11,13 ms** |
| 14 | **8,78 ms** | **6,28 ms** |
| 12 | 7,70 ms | 5,86 ms |

| krok | hybryda | na światło | produkt | na światło |
|---|---|---|---|---|
| 16 → 14 (dwie pule okien) | **4,94 ms** | 2,47 ms | **4,86 ms** | 2,43 ms |
| 14 → 12 | 1,09 ms | 0,55 ms | 0,42 ms | 0,21 ms |

### 3.2 Konfiguracja wysłana (`light-cost-sweep.json`, naturalnie 14)

Limity 18, 16 i 14 nie zdejmują niczego — to ta sama scena trzy razy, i tak jest zapisana.

| aktywnych | hybryda | produkt |
|---|---|---|
| 14 (limity 18, 16, 14) | 9,30 / 9,30 / 9,32 ms | 7,01 / 7,03 / 7,03 ms |
| 12 | 7,39 ms | 5,64 ms |
| 8 | 5,97 ms | 5,77 ms |
| 4 | 6,07 ms | 5,75 ms |
| 0 | 5,96 ms | 5,83 ms |

| krok | hybryda | produkt |
|---|---|---|
| 14 → 12 | **1,93 ms** | **1,39 ms** |
| 12 → 8 | 1,42 ms | −0,13 ms (w szumie) |
| 8 → 4 | −0,09 ms | 0,03 ms |
| 4 → 0 | 0,10 ms | −0,09 ms |

**Koszt krańcowy światła maleje wraz z liczbą świecących** — 2,47 ms przy szesnastu, ok.
0,97 przy czternastu, 0,35 przy dwunastu, nic poniżej ośmiu. To rosnący koszt całkowity,
nie próg i nie stała na światło. Czternaście jest tam, gdzie drogie światła są już
spłacone, a te, które zostały, są prawie darmowe.

### 3.3 Czego nie wiadomo

- **Dlaczego koszt rośnie superliniowo.** Dwa podejrzenia wykluczone pomiarem
  (`light-identity.json`): *nie* mapy cieni — w nocnym kadrze świeci 14 świateł lokalnych z
  62 w scenie i **żadne nie rzuca cienia**, w obu światach; *nie* konkretna para lamp —
  oba rankingi dają ten sam kształt. Zostaje granica wariantu szadera albo presja
  rejestrów. Nie sprawdzone.
- **Współzawodnictwo o GPU.** Niemierzalne bez uprzywilejowanych narzędzi; każdy plik
  wyniku nosi to jako ograniczenie. Bezwzględny czas klatki nie jest tu powtarzalny lepiej
  niż do ok. pół milisekundy między przebiegami, dlatego cytowane są wyłącznie różnice
  wewnątrz jednego przebiegu, a do bramki służy benchmark z vsync.

---

## 4. Pociąg: ta sama pozycja, kontrolowany czas

Pozycja ustawiana przez `train.seekRouteProgress` plus `train.update` z **zerową deltą**
(stawia wagony bez przesuwania czegokolwiek), zegar ustawiany, stabilizowany, korygowany o
dryf i **zamrażany** razem z pętlą klatek, pogoda i kamera ustawiane jawnie, ustabilizowany
współczynnik nocy odczytywany z `DayNightCycle` i przekazywany do `update` wprost.
Tolerancje ustalone **przed** przebiegiem: `t01` ±0,002, pozycja ±0,001 (0,16 m na trasie
162,3 m).

| kadr | `t01` (żądane → uzyskane) | błąd `t01` | współczynnik nocy | pozycja | błąd pozycji |
|---|---|---|---|---|---|
| dzień | 0,42 → **0,42097** | 0,00097 | 0,0001 | 0,68000 | **0,000 m** |
| noc | 0,94 → **0,94097** | 0,00097 | 0,9999 | 0,68000 | **0,000 m** |

Ten sam skład, ten sam wagon, ta sama kamera (sprawdzana z dokładnością 0,01 m na każdej
osi), różnią się wyłącznie czas i oświetlenie.

Osobne potwierdzenie właściwego materiału — jedyny materiał w mieście o barwie
nieoświetlonego okna i szorstkości 0,2 / metaliczności 0,4 / odbijalności 1,0, unikalność
sprawdzana jako warunek:

| kadr | tafla | luminancja tafli | emisja | intensywność |
|---|---|---|---|---|
| dzień | `#24465f` | 0,056 | `#ffdd88` | **0** |
| noc | `#24465f` | 0,056 | `#ffdd88` | **1** |

Plik: `spike-train.json`.

---

## 5. Rower listonosza

Bramka ustalona **przed** pomiarem i nietknięta: połowa własnych pikseli grupy musi różnić
się od tła o co najmniej 8/255 luminancji. Kontrola instrumentu: 0 zmienionych pikseli
między dwoma renderami zamrożonej sceny, w każdym kadrze.

| kadr | koło | rama | koło / tło |
|---|---|---|---|
| z boku, w cieniu bloku | **65,7 %** | **58,4 %** | 22,0 / 37,9 |
| trzy czwarte | **64,7 %** | **54,5 %** | 31,0 / 59,1 |
| w świecie, neutralne światło | **67,5 %** | **50,2 %** | 58,3 / 0 |

Co zostało zmienione, żeby to osiągnąć: koła są torusami o przekroju 0,045 m (poprzednie
0,07 czytało się jak obwarzanek), rury ramy mają 0,10 m zamiast 0,08, czerwień jest
jednoznacznie pocztowa (`0xe0392b`) zamiast brunatnej, opona ma podłogę emisyjną
`0x2a2a2a` niezależną od orientacji normalnej, a **widelec do przedniej piasty i dolna
rura od piasty do piasty** domykają sylwetkę — wcześniej przednie koło wisiało pół metra
pod główką ramy przyczepione do niczego. Promień koła, rozstaw osi i skala człowieka bez
zmian. Listonosz jeździ tylko między t 0,28 i 0,50, więc emisja nigdy nie jest widziana na
tle nocy.

Plik: `spike-postman.json`.

---

## 6. Weryfikacja techniczna

### 6.1 Benchmark High, vsync jak w produkcie (`final-bench-high.json`)

Werdykt **`passed`**, lista problemów pusta, 42 pomiary, kolejność `given`, oba światy na
przemian, jeden proces, jedna karta.

- najgorsze FPS **60,00**, najgorsze p95 **16,8 ms**, najgorsze TTI **964,0 ms** wobec
  bramki 1800 ms
- kanarek stabilny na obu końcach w obu światach
- sonda GPU: `complete`, **90 z 90 próbek we wszystkich 42 pomiarach**
- nocna ulica przechodzi przy **pełnym pixel ratio 1,15** (kanwa 1655×1035), nie przez
  zmniejszenie obrazu; zmierzony stan zapisuje **14** świateł lokalnych

Czego ten przebieg nie mówi: `animationGpu.medianMs` przy włączonym vsync obejmuje
czekanie na wymianę bufora, więc jest ograniczeniem górnym, nie kosztem klatki.

### 6.2 Benchmark Low (`final-bench-low.json`)

Werdykt **`passed`**, problemy puste, 42 pomiary, najgorsze FPS **60,00**, p95 **16,8 ms**,
TTI **1064,9 ms**. Sonda GPU **90 z 90 w 42 pomiarach**. Nocna ulica: pixel ratio 1,0,
**12** świateł lokalnych.

### 6.3 Pozostałe kontrole

| sprawdzenie | komenda | wynik |
|---|---|---|
| typy | `npm run typecheck` | czysto |
| testy jednostkowe | `npm test` | **273 zielone w 41 plikach** |
| build i budżet paczki | `npm run build` | **239 960 B / 240 000 B** |
| smoke produktu, konsola | `node scripts/browserSmoke.mjs` | przeszedł |
| smoke hybrydy, wszystkie fazy | `SPIKE_PHASE=all node scripts/spikeSmoke.mjs` | przeszedł |
| przed/po: pule okien | `PREPOST_VARIANT=windowLights node scripts/windowLightPrePost.mjs` | 497 px (0,03 %), kontrola 0 px |
| przed/po: latarnie | `PREPOST_VARIANT=streetLamps node scripts/windowLightPrePost.mjs` | 475 140 px (27,74 %), kontrola 0 px |
| koszt świateł, profil wysłany | `LIGHT_CAPS=18,16,14,12,8,4,0 node scripts/lightCostExperiment.mjs` | punkt 3.2 |
| koszt świateł, pule przywrócone | `LIGHT_BUDGET=windowLightBudget:2 LIGHT_CAPS=16,14,12 node scripts/lightCostExperiment.mjs` | punkt 3.1 |
| tożsamość świateł | `node scripts/lightIdentity.mjs` | 14 z 62 świeci, 0 rzuca cień |
| procesy, karty, instancje | wspólny lock plikowy; `contexts().length === 1`, `pages().length === 1` | spełnione |
| czystość drzewa | `git status --porcelain` | pusty przed i po batchu |

### 6.4 Provenance pomiaru

Kolejność w każdym harnessie: wspólny lock → czyste drzewo → pełny HEAD i hash drzewa →
jeden build **pod tym lockiem** → manifest → dopiero preview i pomiar → lock zwalniany po
zamknięciu przeglądarki i serwera podglądu. Każdy harness sprawdza przed renderem: HEAD
bez zmian, drzewo nadal czyste, commit i drzewo z manifestu zgodne, **wszystkie 12 plików
`dist`** zgodne co do nazwy, rozmiaru i SHA-256.

Sprawdzone kontrolą negatywną: dopisanie jednego komentarza do `hybrid-spike-CaFIaPuy.js`
przerywa pomiar komunikatem `changed: assets/hybrid-spike-CaFIaPuy.js
(60203456a0ef -> 96d9b5c7bae0)`; po przywróceniu pliku przebieg przechodzi. Brak manifestu
i brudne drzewo również przerywają pomiar.

---

## 7. PASS / FAIL — techniczne

| sprawdzenie | stan | oparte na |
|---|---|---|
| Wszystkie artefakty z jednej czystej rewizji | **PASS** | 12 z 13 nosi `e4e28f7` / tree `65714cd14e47` / dist `eb11423fda88`; wyjątek w punkcie 8 |
| Build powiązany z rewizją, nie tylko polem `revision` | **PASS** | manifest 12 plików + hash zbiorczy, kontrola negatywna na lazy chunku |
| Jeden renderer naraz, lock obejmuje build i sprzątanie | **PASS** | lock plikowy, zwalniany po `stopPreview` w zewnętrznym `finally` |
| Benchmark High, vsync | **PASS** | `passed`, 60,00 FPS, p95 16,8 ms, TTI 964 ms, pixel ratio 1,15 |
| Benchmark Low, vsync | **PASS** | `passed`, 60,00 FPS, p95 16,8 ms, TTI 1064,9 ms |
| Sonda GPU kompletna | **PASS** | `complete 90/90` w 84 pomiarach |
| Testy jednostkowe | **PASS** | 273 w 41 plikach |
| Budżet paczki | **PASS** | 239 960 B / 240 000 B |
| Pasażerowie na transformacjach runtime'u | **PASS** | jedna funkcja placementu, zero własnych drzwi w testach, prześwity 0,336 / 0,359 m |
| Budżet świateł z prawdziwym pre/post | **PASS** | 0,03 % wobec 27,74 %, kontrola 0 px w każdym kadrze |
| Pociąg w identycznej pozycji i kontrolowanym czasie | **PASS** | błąd `t01` 0,00097 / 0,002, błąd pozycji 0,000 m |
| Szyba wagonu: ciemna dniem, ciepła nocą | **PASS** | emisja 0 → 1 na unikalnym materiale |
| Kadry dowodowe śledzone w repo | **PASS** | 11 plików w `frames/evidence/`, hashe w `evidence-index.json` |
| Drzewo czyste, nic nie zmergowane | **PASS** | `git status --porcelain` pusty |
| Rower: bramka 50 % w trzech kadrach | **PASS, ale z cienkim marginesem** | 65,7 / 64,7 / 67,5 % (koło) i 58,4 / 54,5 / **50,2** % (rama) — patrz punkt 8 |

---

## 8. Nierozwiązane decyzje wizualne

Te punkty **nie są** techniczną porażką — wymagają oceny właściciela.

1. **Rama roweru: margines bramki jest cienki i niestabilny.** W tym przebiegu wychodzi
   58,4 / 54,5 / 50,2 %, czyli w kadrze „w świecie" zaledwie 0,2 punktu nad progiem. W
   poprzednich przebiegach na tym samym kodzie ta grupa dawała od 43,7 % do 58,4 %, bo
   listonosz stoi za każdym razem w innym miejscu, a rurki stoją raz na asfalcie, raz na
   trawie o podobnej luminancji. **Bramkę uznaję za zdaną w tym przebiegu, ale nie za
   zdaną pewnie.** Decyzja: czy to wystarczy, czy rama wymaga jeszcze jednej zmiany.
2. **Sylwetka roweru wymaga akceptacji wzrokowej.** Metryka mówi, że rura odróżnia się od
   tła; nie mówi, że rower wygląda jak rower. Moja ocena: w normalnym kadrze Dioramy
   czyta się jako rozpoznawalny rower z domkniętą ramą — ale to **Twoja** ocena rozstrzyga.
   Kadry: `frames/evidence/hybrid-direct-high-postman-{side,three-quarter,in-world}.jpg`.
3. **Piasty i szprychy nie zostały dodane** — niewidoczne z normalnej kamery, a kosztują
   bajty przy 40 B zapasu w entry chunku. Do decyzji, czy w ogóle są potrzebne.
4. **`cameraScale` 0,87 dla kamery autobusu** nadal obowiązuje i daje pixel ratio 1,0005 w
   `evening-rain-bus`. To wyjątek dopasowany do jednego pomiaru, nie zasada. Nie naprawiony
   w tej rundzie.
5. **Trzech pasażerów zamiast czterech** to zmiana widoczna na przystanku. Wymuszona
   geometrią, ale to zmiana wyglądu.

**Znana luka techniczna, świadomie niezałatana:** `spike-semantics.json` pochodzi z
finalnego batcha, ale writer tej jednej fazy nie rozsypuje stempla, więc plik nie potwierdza
tego sam z siebie. Żadna liczba w tym raporcie z niego nie pochodzi. Do naprawy w
następnej rundzie, gdy wolno będzie zmieniać kod.

**Adaptacyjna rozdzielczość** pozostaje wyłącznie projektem — nic nie zaimplementowane.
Przesłanka do jej włączenia nie jest spełniona: zapas przy vsync jest dodatni w obu
światach na High i na Low.

---

## 9. Rekomendacja dla całego spike'u

## **NO MERGE**

Nie dlatego, że coś w tej rundzie nie działa. Bramki są zdane, drzewo czyste, budżet
paczki utrzymany, 273 testy zielone, oba benchmarki `passed` na wskazanym commicie z
podpisanej paczki, a każdy cytowany plik jest w repozytorium wraz z hashem. Powody są dwa
i oba są poza zakresem pomiaru:

1. **Gałąź zawiera sam spike hybrydowy**, a decyzje, na których on stoi — gęstość siatki,
   meshing, materiały i budżet paczki dla fragmentu — nie zostały zatwierdzone. Spike miał
   je wycenić i wycenił; zgoda na wejście do produktu to osobna decyzja.
2. **Rower czeka na akceptację wzrokową**, a jego margines na bramce jest cienki (punkt 8).

Co jest gotowe do wydzielenia, gdyby właściciel tak zdecydował — zmiany po stronie
produktu, każda z dowodem i niezależna od fragmentu hybrydowego:

- jedno rozstawienie pasażerów wołane przez runtime i testy, i trzy figury, które naprawdę
  się mieszczą;
- budżet czternastu świateł z prawdziwym przed/po i alternatywą wycenioną w pikselach;
- szyby wagonu porównane w identycznej pozycji i kontrolowanym czasie;
- czytelność roweru listonosza — z otwartą pozycją na ramę;
- provenance pomiaru: podpisany build, wspólny lock, weryfikacja przed każdym renderem.

Odbiór techniczny i wizualny odbywa się osobno, po tym raporcie.

---

## 10. Kadry dowodowe: ścieżki i hashe

Wszystkie śledzone w repozytorium. `sha256` to suma pliku takiego, jaki leży w gicie;
`render` to suma wyrenderowanych pikseli, na których policzono diff. Para, której
render się zgadza, a plik nie, różni się HUD-em, nie sceną. Pełne sumy:
`docs/superpowers/spike/evidence-index.json`.

| plik (w `docs/superpowers/spike/frames/evidence/`) | bajty | `sha256` | `render` |
|---|---|---|---|
| `hybrid-direct-high-prepost-windowLights-near-facade-baseline.png` | 679 564 | `0651a71300ee76bb…` | `67c72276231d4120…` |
| `hybrid-direct-high-prepost-windowLights-near-facade-adopted.png` | 666 412 | `abf8aa21b1c1cbf9…` | `32d54a3375d34cd9…` |
| `hybrid-direct-high-prepost-windowLights-free-exploration-baseline.png` | 249 263 | `bdf33a6a62ff4838…` | `854fe2b5c08b62db…` |
| `hybrid-direct-high-prepost-windowLights-free-exploration-adopted.png` | 248 499 | `f15ee77e1b6fe955…` | `854fe2b5c08b62db…` |
| `hybrid-direct-high-prepost-streetLamps-night-street-baseline.png` | 3 093 897 | `a27f450051726e7a…` | `c0d6bf2be0a35c0f…` |
| `hybrid-direct-high-prepost-streetLamps-night-street-adopted.png` | 1 675 449 | `3c22a3035a99780d…` | `2d4d2f1ebcbb6709…` |
| `hybrid-direct-high-postman-side.jpg` | 131 950 | `e163f9a386fbc10a…` | — |
| `hybrid-direct-high-postman-three-quarter.jpg` | 131 220 | `a9996cc089b28d00…` | — |
| `hybrid-direct-high-postman-in-world.jpg` | 114 943 | `5afb8b1ff5c12bbb…` | — |
| `hybrid-direct-high-train-day.jpg` | 233 861 | `bf1e70be5e8d6d12…` | — |
| `hybrid-direct-high-train-night.jpg` | 207 457 | `0214428cc8765864…` | — |

JSON-y zestawu końcowego, wszystkie ze stemplem `e4e28f7` / tree `65714cd14e47` /
dist `eb11423fda88` w środku:

- `docs/superpowers/spike/build-manifest.json` — 2 678 B  `sha256 7f46a17d3c44ee88…`
- `docs/superpowers/spike/final-bench-high.json` — 445 256 B  `sha256 2ffb35abc684c5c8…`
- `docs/superpowers/spike/final-bench-low.json` — 451 043 B  `sha256 b04ec79af4a48e5a…`
- `docs/superpowers/spike/light-budget-pre-post-windowLights.json` — 16 402 B  `sha256 841c3b77c871adb5…`
- `docs/superpowers/spike/light-budget-pre-post-streetLamps.json` — 16 666 B  `sha256 506355d9c65d127e…`
- `docs/superpowers/spike/light-cost-sweep.json` — 40 736 B  `sha256 d25724f716036b3b…`
- `docs/superpowers/spike/light-cost-sweep-windowpools.json` — 19 857 B  `sha256 bab7ab3f9bb3a12e…`
- `docs/superpowers/spike/light-identity.json` — 5 742 B  `sha256 b8fb6ab9af9e6917…`
- `docs/superpowers/spike/spike-postman.json` — 6 349 B  `sha256 ae453018d8526fba…`
- `docs/superpowers/spike/spike-train.json` — 6 370 B  `sha256 a674328841086e83…`
- `docs/superpowers/spike/spike-materials.json` — 22 217 B  `sha256 3895ebfa9838d175…`
- `docs/superpowers/spike/spike-semantics.json` — 34 713 B  `sha256 0432c26dae79c2c7…`
- `docs/superpowers/spike/spike-smoke.json` — 13 943 B  `sha256 22cd44d44808f451…`

Wyjątek: `spike-semantics.json` nie nosi stempla w środku (punkt 8) i nic z niego nie
jest cytowane.

