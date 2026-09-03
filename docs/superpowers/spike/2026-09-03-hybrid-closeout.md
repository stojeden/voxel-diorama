# Zamknięcie iteracji hybrydy — Osiedle Centralne

Gałąź `spike/hybrid-osiedle-centralne`, rewizja `d3846e0` (+ ta runda).
Poprzedni raport: [`2026-09-02-hybrid-spike-report.md`](2026-09-02-hybrid-spike-report.md) (rewizja 3).
**Nic nie zmergowane, nic nie wypchnięte, nic nie wdrożone.**

---

## 1. Co naprawione

### 1.1 Jeden poziom ziemi dla całej ulicy

Jezdnia to płaszczyzna ziemi na `GROUND_SURFACE_Y = −0,5`, ale trasa autobusu, trasa
listonosza i podwórko psa są zapisane na `y = 0` i **nic tego nie uzgadniało**. Raycast
w gotowym świecie: droga −0,500 m, najniższy wierzchołek autobusu +0,011 m. Autobus,
listonosz i pies jechali pół metra nad własnym asfaltem, z cieniem odklejonym od kół.
Render A/B tego samego kadru pokazuje cień schodzący do opon po osadzeniu na ziemi.

Nie zauważyłem tego wcześniej, bo patrzyłem na kadr z poziomu oczu: przy kamerze
16 m od autobusu jezdnia za nim wypełnia dokładnie tę część ekranu, w której powinna
być szpara, i koła „stoją" na drodze, która jest bliżej. Rozstrzygnął dopiero pomiar i
A/B, nie oko.

### 1.2 Skala — mierzona na gotowych siatkach, nie na argumentach konstruktorów

| Obiekt | Przed | Po |
|---|---|---|
| opona rowerowa (ulica) | torus r 0,34 + przekrój 0,045, os na 0,34 → **45 mm pod chodnikiem** | koło definiowane promieniem zewnętrznym 0,37 → styk co do milimetra |
| rower oparty | ten sam błąd + przechył | oś obok śladu o 0,065 m, opona na ziemi |
| koła listonosza | 0,84 m na bazie 1,30 m | **0,70 m na bazie 1,10 m** (rodzina rowerów ulicznych: 0,74 m) |
| jeździec | skala 0,85 → 2,24 m | `PASSENGER_SCALE` — ta sama figura, co wszyscy mieszkańcy |
| biodra jeźdźca | 0,40 m **nad** siodłem | 13 mm od siodła, które w ogóle powstało |
| kończyny | obrót w środku bryły | obrót w biodrze i barku; ręce na kierownicy, stopa nad jezdnią i pod siodłem |
| pies | 1,04 m w kłębie, 1,48 m długości | 0,64 m i 0,92 m |

Poprzednia wersja testu proporcji **dopuszczała 50 mm zapadnięcia** — czyli dokładnie
tyle, ile maskowała. Teraz obowiązuje własna tolerancja fragmentu, 12 mm, i mierzy się
gotową geometrię każdego obiektu osobno.

Sylwetka jeźdźca kończy się na 2,27 m nad jezdnią. To konsekwencja proporcji figury
produktu (nogi to 37% wzrostu, u człowieka ~48%), nie osobna decyzja: **ta sama figura
stojąca ma 1,915 m**. Zapisuję to jako własność stylizacji, nie jako naprawione.

### 1.3 Przystanek jako jeden układ

Dach wiaty ma 1,7 m głębokości, a słupki stoją metr za krawężnikiem, więc na domyślnym
**metrowym** chodniku wiata, ławka, znak i wszyscy oczekujący stali na trawie, a trasa
dookoła wiaty biegła po trawniku. Jeden lokalny fartuch chodnika przy tym przystanku
(x −16..−6, z 27..30) i pozycje oczekiwania przesunięte pod dach — wcześniej stały
0,15 m **za** jego krawędzią.

**Jezdni nie ruszałem i autobusu nie zmniejszałem.** Zmierzone: jezdnia Alei
Południowej ma 5 m (5 komórek asfaltu), autobus 2,45 m, luz do każdego krawężnika
1,27 m. Pojazd nigdy nie był tu problemem — problemem był chodnik.

### 1.4 Pomiar zamiast powtarzania stałej

- Test wiaty czyta **woksele, które wiata emituje**, nie przelicza `BUS_SHELTER_ROOF_Y`.
- Części obiektu mierzone przez ponowne uruchomienie jego własnego emitera (`emitProp`),
  nie przez zbieranie wszystkiego w promieniu 1,1 m — co przy rowerze łapało drugi
  rower i stojak, więc „rower" miał 1,3 m szerokości i nie był żadnym obiektem.
- Wycięte pseudo-uniwersalne reguły: „wiata nigdy nie wyższa niż autobus", „ławka nie
  dłuższa niż wzrost pasażera o połowę". W ich miejsce: prześwit nad najwyższym
  mieszkańcem, dach nad ławką, siedzisko na wysokości siedzenia, miejsce dla dwóch osób,
  luz autobusu do obu krawężników. To, że wiata jest niższa od autobusu, jest decyzją
  stylistyczną tej diorami — nie prawem realizmu i nie asercją.

### 1.5 Paczka i diagnostyka

Sonda czasu klatki i licznik świateł to diagnostyka, więc **ładują się na żądanie**, a
nie w chunku wejściowym: pętla renderowania trzyma tylko nullowy uchwyt i dwa
opcjonalne wywołania. Chunk wejściowy **239 866 B** wobec nietkniętego budżetu
240 000 B (`main` 33 311 / 50 000, `hybrid-spike` 34 305).

Wyniki benchmarku zapisuje `writeReport()`: waliduje komplet scenariuszy i prób TTI,
pisze plik tymczasowy i dopiero podmienia. Dlatego `bench-voxel-low.json` już nie
może mieć 0 bajtów — poprzednio driver przekierowywał stdout do pliku docelowego, więc
powłoka obcinała go, zanim node wystartował. Każdy raport nosi rewizję, znacznik czasu
i warunki pomiaru, w tym `deviceScaleFactor` i to, czy działała diagnostyczna nadpiska.

---

## 2. Testy i gdzie są pełne dowody

| Test | Plik / faza | Co mierzy |
|---|---|---|
| proporcje i styk z ziemią | `src/world/hybrid/proportions.test.ts` (14) | gotowe bryły: autobus, oba rowery, listonosz, pies, wiata, ławka, jezdnia |
| prześwity i przejścia | `src/world/hybrid/clearance.test.ts` (13) | wiata na chodniku, oczekujący pod dachem, trasa nie po trawie, luz autobusu do krawężników |
| histereza LOD | `src/world/hybrid/lodHysteresis.test.ts` (7) | oba progi w obu kierunkach, pasmo, 40 klatek drgań na każdym progu, cooldown co do klatki, sufit Low, najazd i odjazd |
| deterministyczność | `src/world/hybrid/determinism.test.ts` (4) | skróty FNV-1a **wszystkich** atrybutów wszystkich geometrii wszystkich klastrów; dwa budowania i dwa modele z ziarna |
| materiały | `SPIKE_PHASE=materials` → `spike-materials.json` | macierz LOD 0/1/2 × High/Low przy zgaszonych i potwierdzonych światłach, okna, kohorty, śnieg, wilgoć |
| LOD i semantyka w scenie | `SPIKE_PHASE=gate3` → `spike-semantics.json` | bez zmian względem rewizji 3 |
| koszt nocny fragmentu | `night-fragment-experiment.json` | widoczny / ukryty / odpięty + liczniki per przebieg |
| noc a rozdzielczość | `night-resolution-experiment.json` | oba światy naprzemiennie przy 1,15 i przy 1,00 |
| komplet wydajności | `bench-{voxel,hybrid-direct}-{high,low}.json` | 36 scenariuszy, po 3 próby TTI każdy |
| kadry | `docs/superpowers/spike/frames/` | 8 kadrów hybrydy + 8 odpowiedników produktu |

Zestaw jednostkowy: **256 testów w 39 plikach**, `tsc --noEmit` czysty.

### 2.1 Że te testy wykrywają regresje

Nie przez zawężanie zakresów. Przez kontrolowane wprowadzenie usterki z powrotem —
dziesięć przypadków geometrii, każdy z listą testów, które padły
(`negative-controls.json`), i dwa przypadki materiałów w przeglądarce
(`negative-controls-materials.json`). Po każdym przywróceniu zestaw znowu zielony.

Dwa z tych przypadków najpierw **nie zostały wykryte**, i to jest najważniejsza rzecz w
tym rozdziale:

1. Pierwsza wersja testu listonosza przepuściła jego lewitację, bo mierzyła w układzie
   roweru, gdzie koła dotykają `y = 0` niezależnie od tego, jak wysoko lata cały zestaw.
   Test mierzy teraz **także w układzie świata, wobec jezdni**.
2. Pierwsza wersja pomiaru okien przepuściła szklenie usunięte z LOD 0. Przy 300 m
   pudełko fasady to głównie bloki produktu: fragment dawał 824 rozjaśnione piksele,
   produkt 827, a usunięcie szkła z fragmentu **nie ruszyło żadnej z tych liczb**. Teraz
   LOD 0 osiąga się wysokością okna (280 px z 110 m), fragment jest izolowany różnicą
   dwóch światów piksel po pikselu, a miarą jest suma przyrostu jasności, bo przy LOD 0
   okno ma szerokość jednego piksela i antyaliasing rozmywa je pod każdy próg.
   Zmierzone: fragment dodaje **0,17** światła produktu, a ze szkleniem wyniesionym z
   warstwy masy — **0,07**. Próg 0,11 to średnia geometryczna tych dwóch liczb.

---

## 3. Nocna wydajność — co ustalone, a co pozostaje hipotezą

### 3.1 Ustalone

**Fragment jest przyczyną, ale tylko przy pełnej rozdzielczości profilu High.**
Ten sam checkpoint, ta sama kamera, to samo ziarno, ta sama jakość, światy
naprzemiennie, wszystkie próby zapisane w `night-resolution-experiment.json`:

| pixel ratio | świat | FPS | p95 | klatki > 20,5 ms | draw calls | trójkąty |
|---|---|---|---|---|---|---|
| **1,15** (1655×1035) | voxel | 60,0 / 60,0 / 60,0 | 16,7–16,8 | 0,0% | 319 | 669 577 |
| **1,15** | hybrid-direct | **48,3 / 48,7 / 48,7** | **33,3–33,4** | **23,3–24,1%** | 347 | 642 287 |
| **1,00** (1440×900) | voxel | 60,0 / 60,0 | 16,7–16,8 | 0,0% | 319 | — |
| **1,00** | hybrid-direct | **60,0 / 60,0** | 16,7–16,8 | 0,0% | 347 | — |

Z tego wynika kilka rzeczy, każda z pomiaru:

- **To nie jest geometria.** Hybryda rysuje w tym kadrze **mniej** trójkątów niż
  produkt, który zastępuje (642 287 wobec 669 577), przy 28 draw callach więcej. Koszt
  jest na piksel, nie na wierzchołek i nie na obiekt.
- **To nie jest podpięcie do scen.** Ten sam kadr z fragmentem ukrytym (`visible =
  false`, dalej w scenie) i odpiętym (usuniętym ze scen) daje **identyczne liczniki per
  przebieg**, co do trójkąta: main 141/306 624, normalne 138/299 628, trzeci 23/13 728.
  Hipoteza rewizji 3 — „bryły otaczające scalonych meshy nie są odcinane frustumem,
  więc koszt jest stały na klatkę" — jest tym pomiarem **wykluczona**, i nic tu nie
  uzasadnia zawężania bryły otaczającej poniżej rozmiarów obiektu.
  Rozbicie na przebiegi wymagało owinięcia `renderer.render` z harnessu; sam graf scen
  był dostępny prościej, przez `window.__diorama.scene`, czego wcześniej nie sprawdziłem.
- Koszt fragmentu w liczbach: 13 draw calli i 11 098 trójkątów w passie głównym, tyle
  samo w passie normalnych SSAO, 2 calle w trzecim.
- **Sprzeczność z rewizji 3 jest wyjaśniona i nie jest to obciążenie maszyny ani
  temperatura.** 9/9 uruchomień przy 47–50 FPS i 9/9 przy 60 FPS pochodziły z dwóch
  harnessów, które różniły się jedną rzeczą: `deviceScaleFactor`. Profil High prosi o
  pixel ratio 1,15, a renderer bierze `min(devicePixelRatio, 1,15 · distanceScale ·
  cameraScale)`. Przy `deviceScaleFactor: 1` wychodzi 1,00 i **32% pikseli mniej**.
  Teraz to jedna stała w skrypcie i pole w każdym pliku wyniku.

### 3.2 Pozostaje hipotezą

- **Która część kosztu na piksel dominuje**: trzyoktawowy szum materiału, przemalowanie
  przez `glass` i `glassClear`, czy pass normalnych SSAO nad fragmentem. Odczyty
  `TIME_ELAPSED_EXT` pod vsync obejmują oczekiwanie i w większości uruchomień wychodzą
  **niekonkluzywne** według reguły rozrzutu (16,7/4 ms), więc nie da się nimi rozdzielić
  składników. Jedna czysta para przy pixel ratio 1,00 daje ~5 ms na fragment.
- **Czy punktowe obniżenie pixel ratio dla nocnej kamery ulicznej zamknęłoby bramkę bez
  widocznej straty.** Produkt robi dokładnie to dla kamery autobusu (`cameraScale =
  0,87`), a pomiar pokazuje, że przy 1,00 kadr trzyma 60 FPS z zerowym udziałem wolnych
  klatek. Nie wprowadzam tego: to decyzja o jakości całego produktu, nie naprawa spike'u.

### 3.3 Komplet wyników

`bench-{voxel,hybrid-direct}-{high,low}.json`, rewizja `d3846e0`, 36 scenariuszy, po
3 próby TTI każdy (zapisane wszystkie, nie tylko mediana). Po `d3846e0` nie zmieniło
się nic w `src/` — późniejsze commity to dokumentacja i harness — więc te liczby
dotyczą także HEAD.

- **35 z 36 scenariuszy: 60,0 FPS, p95 16,7–16,8 ms, 0% klatek powyżej 20,5 ms.**
- **1 scenariusz nie przechodzi: `hybrid-direct` / High / `spike-night-street` — 48,3 FPS,
  p95 33,4 ms, 24,1% wolnych klatek.** Ten sam kadr na Low: 60,0 FPS.
- TTI: mediana median 1081 ms, najgorsza mediana 1364 ms, **najgorsza pojedyncza próba
  1379 ms** (`hybrid-direct` / High / `night-snow-train`, próby 1378,7 / 1347,4 /
  1364,1). Próg 1800 ms — z zapasem, licząc po najgorszej próbie, nie po medianie.
- Historyczne wyniki z rewizji sprzed `a89af98` leżą w `bench-archive/` z opisem, czym
  są i czego w nich brakuje. Nie są przedstawiane jako aktualny pomiar.

---

## 4. Kadry do oceny wizualnej

Osiem kadrów hybrydy i osiem odpowiedników produktu z tym samym ziarnem, checkpointem i
kamerą, w `docs/superpowers/spike/frames/`:

| Kadr | Plik (hybryda) |
|---|---|
| przegląd, światło neutralne | `hybrid-direct-high-spike-overview.jpg` |
| poziom oczu | `hybrid-direct-high-spike-street.jpg` |
| kamera autobusu | `hybrid-direct-high-bus-camera.jpg` |
| kamera toura | `hybrid-direct-high-tour-camera.jpg` |
| złota godzina | `hybrid-direct-high-spike-golden.jpg` |
| noc | `hybrid-direct-high-spike-night-street.jpg` |
| przegląd, Low | `hybrid-direct-low-spike-overview.jpg` |
| ulica, Low | `hybrid-direct-low-spike-street.jpg` |

Moja ocena, do zakwestionowania kadrami:

- **Autobus wygląda jak pojazd.** Nadkola, tylna szyba, stożki świateł 0,42 × 2,4 m
  zamiast ośmiometrowego klina, i — od tej rundy — koła na jezdni.
- **Szkło wygląda jak szkło, a nocą lepiej niż w produkcie.** W kadrze nocnym okna
  kamienicy czytają się jako okna z podziałami i ciepłym wnętrzem; produkt w tym samym
  kadrze pokazuje wielkie płaskie świecące prostokąty. Zmierzone 0,17 światła produktu
  to nie deficyt czytelności — produkt prześwietla.
- **Rowery i mieszkańcy należą do tego samego świata.** Autobus/pasażer 1,54,
  autobus/rower 2,73, pasażer/rower 1,77 — wszystkie w okolicy wartości odniesienia.
- **Low trzyma sylwetkę.** Na ulicy Low różni się brakiem podziałów okien i cieńszą
  ramą, nie brakiem obiektów.
- **Kamera toura nie odwiedza fragmentu** — tour jedzie za pociągiem. Ten kadr pokazuje
  tylko, że tour nie ucierpiał; nie jest oceną fragmentu.
- **Czterech oczekujących pod wiatą zachodzi na siebie.** Figura ma 0,874 m szerokości z
  rękami, a pozycje oczekiwania są co 0,67 m; wolny prześwit między słupkami wiaty to
  2,36 m, a czterech takich figur potrzebuje 3,5 m. Wszyscy stoją na chodniku, pod
  dachem i poza każdym kolizjonerem — ale ramiona się przecinają. Zostawiam: naprawa to
  albo mniej oczekujących, albo dłuższa wiata, albo węższa figura, czyli decyzja o
  produkcie, nie o tym fragmencie.

---

## 5. Pozostałe luki

1. **`spike-night-street` na High nie przechodzi bramki 58 FPS.** Przyczyna
   zlokalizowana (koszt na piksel fragmentu przy pixel ratio 1,15), mechanizm
   udowodniony, rozstrzygnięcie — nie. **To blokuje merge.**
2. **Rozdział kosztu na piksel** między szum, szkło i SSAO — nie zmierzony
   rozstrzygająco, bo sonda GPU pod vsync jest niekonkluzywna.
3. **Kolizjonery wiaty nie odpowiadają jej geometrii**: słupek ma 0,16 m, a jego
   kolizjoner 1,0 m (plus 0,32 m zapasu). Nic z tego nie wynika dla obecnych pozycji
   (są poza kolizjonerami), ale to niespójność danych, którą zgłaszam, a nie naprawiam
   — dotyczy nawigacji całego produktu, nie fragmentu.
4. **Listonosz nie ma kadru referencyjnego.** Zweryfikowany pomiarem gotowych siatek
   (styk, rozmiary, poza, relacje), nie renderem: pojawia się tylko o świcie na drodze
   południowej, checkpointy zamrażają aktorów, a debugowe API nie daje swobodnej kamery.
5. **Streetscape 2.0** — nadal wydzielone, nie zrobione (rozdział 11 poprzedniego
   raportu).
6. **28 JPEG-ów w historii Git** — decyzja właściciela, wciąż otwarta.

---

## 6. Stan gałęzi i werdykt

- Gałąź `spike/hybrid-osiedle-centralne`, drzewo czyste, `main` nietknięty.
- Nowe commity tej rundy: paczka i zapis dowodów, geometria i skala świata, trzy
  brakujące zestawy testów, dowód kosztu nocnego.
- `tsc --noEmit` czysto, 256 testów zielonych, budżety paczki niezmienione i spełnione.

**Werdykt: nadal wstrzymane jedną bramką, ale to już nie jest ta sama blokada.**

W rewizji 3 blokada brzmiała „hybryda gubi vsync nocą i nie wiemy dlaczego, a
przypuszczenie mówi o bryłach otaczających". Teraz brzmi: *hybryda kosztuje na piksel
tyle, że nocny kadr uliczny przy pixel ratio 1,15 mieści się w 20,5 ms tylko w trzech
czwartych klatek; przy 1,00 mieści się w całości; geometria i podpięcie są z tego
wykluczone pomiarem.* Do decyzji właściciela zostaje **jedna rzecz**: czy zamykamy tę
bramkę taniej rysowanym nocnym materiałem, czy punktowym obniżeniem rozdzielczości dla
tej kamery — tak jak produkt już robi dla kamery autobusu.

Wszystko poza tą jedną bramką jest w tej rundzie zamknięte i zmierzone.
