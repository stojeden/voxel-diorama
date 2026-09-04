# Zamknięcie iteracji hybrydy — Osiedle Centralne

Gałąź `spike/hybrid-osiedle-centralne`. Poprzedni raport: [`2026-09-02-hybrid-spike-report.md`](2026-09-02-hybrid-spike-report.md) (rewizja 3).
**Nic nie zmergowane, nic nie wypchnięte, nic nie wdrożone.**

> **Sprostowanie do pierwszej wersji tego dokumentu.** Pisałem tu, że nocny kadr uliczny
> daje 48,3–48,7 FPS „3/3" i że hybryda jest przyczyną. Pierwsza połowa była niepełna, a
> druga myląca. Ten sam przepis pomiarowy dał później 60,0 FPS w ośmiu kolejnych
> uruchomieniach. Kadr jest **dwumodalny**, bo stoi 1,9 ms pod progiem klatki, a FPS pod
> vsync nie mierzy zapasu — tylko to, po której stronie progu klatka wypadła. Rozdział 3
> jest przepisany na podstawie pomiaru bez vsync. Werdykt się zmienił.

---

## 1. Co naprawione

### 1.1 Jeden poziom ziemi dla całej ulicy

Jezdnia to płaszczyzna ziemi na `GROUND_SURFACE_Y = −0,5`, ale trasa autobusu, trasa
listonosza i podwórko psa są zapisane na `y = 0` i **nic tego nie uzgadniało**. Raycast
w gotowym świecie: droga −0,500 m, najniższy wierzchołek autobusu +0,011 m. Autobus,
listonosz i pies jechali pół metra nad własnym asfaltem, z cieniem odklejonym od kół.
Render A/B tego samego kadru pokazuje cień schodzący do opon po osadzeniu na ziemi.

Nie zobaczyłem tego wcześniej, bo patrzyłem z poziomu oczu: przy kamerze 16 m od
autobusu jezdnia za nim wypełnia dokładnie tę część ekranu, w której powinna być szpara.
Rozstrzygnął pomiar i A/B, nie oko.

### 1.2 Skala, mierzona na gotowych siatkach

| Obiekt | Przed | Po |
|---|---|---|
| opona rowerowa (ulica) | torus r 0,34 + przekrój 0,045, os na 0,34 → **45 mm pod chodnikiem** | koło definiowane promieniem zewnętrznym 0,37 → styk co do milimetra |
| rower oparty | ten sam błąd + przechył | oś obok śladu o 0,065 m, opona na ziemi |
| koła listonosza | 0,84 m na bazie 1,30 m | **0,70 m na bazie 1,10 m** (rodzina rowerów ulicznych: 0,74 m) |
| jeździec | skala 0,85 → 2,24 m wzrostu | `PASSENGER_SCALE` — ta sama figura, co mieszkańcy |
| biodra jeźdźca | 0,40 m **nad** siodłem | 13 mm od siodła, które w ogóle powstało |
| kończyny | obrót w środku bryły | obrót w biodrze i barku; ręce na kierownicy |
| pochylenie jeźdźca | — | 0,42 rad dawało głowę 0,53 m do przodu, **przed kierownicą**; 0,26 rad z kierownicą wyżej i bliżej trzyma głowę za nią |
| opony listonosza | 0x202020, ciemniejsze niż asfalt | 0x3b332c, jak opony rowerów fragmentu |
| pies | 1,04 m w kłębie, 1,48 m długości | 0,64 m i 0,92 m |

Sylwetka jeźdźca kończy się na 2,28 m nad jezdnią. To konsekwencja proporcji figury
produktu (nogi to 37% wzrostu, u człowieka ~48%), nie osobna decyzja: **ta sama figura
stojąca ma 1,915 m**. Zapisuję jako własność stylizacji, nie jako naprawione.

### 1.3 Przystanek jako jeden układ

Dach wiaty ma 1,7 m głębokości, a słupki stoją metr za krawężnikiem, więc na domyślnym
**metrowym** chodniku wiata, ławka, znak i wszyscy oczekujący stali na trawie, a trasa
dookoła wiaty biegła po trawniku. Jeden lokalny fartuch chodnika przy tym przystanku
(x −16..−6, z 27..30), dach pogłębiony do 2,0 m i pozycje oczekiwania przesunięte pod
niego. **Jezdni nie ruszałem i autobusu nie zmniejszałem**: jezdnia ma 5 m, autobus
2,45 m, luz do każdego krawężnika 1,27 m.

### 1.4 Oczekujący i kolizje — jedna sprawa

Słupek wiaty ma 0,16 m, a jego kolizjoner miał **1,0 m**, co zabierało 1,7 m z 4 m
między słupkami. Dlatego czterech oczekujących, każdy 0,874 m szeroki w ramionach, stało
co 0,67 m i przechodziło przez siebie. Teraz rozmiar słupka jest jedną stałą, którą
czytają generator, nawigacja i kolizjonery, a cztery pozycje to dwa luźne rzędy —
najbliższa para 0,84 m, każde ciało pod dachem, nikt w kolizjonerze.

### 1.5 Autobus ma szkło, nie cztery jasne panele

Szyby miały kolor `windowLit` — ten sam ciepły krem, co zapalone okno w bloku — plus
0,25 emisji **w biały dzień**, więc żółty autobus nosił cztery płaskie blade prostokąty.
Szkło w dzień jest ciemne i bierze jasność z nieba, które odbija; zapalone wnętrze to
stan nocny. Dwie rzeczy, które pokazały kadry, a nie kod:

- Przy `envMapIntensity` 2 i chropowatości 0,08 tafla wypala się do płaskiej białej
  plamy tam, gdzie szkło jest widziane pod małym kątem — czyli na całym boku autobusu.
  1,2 i 0,16 zostawiają niebo w szybie, nie wymazując tafli.
- `setCyberLook` interpolował **emisję** z koloru szkła, więc po ściemnieniu tafli nocny
  autobus świecił granatowo zamiast pokazywać zapalone wnętrze. Tafla i wnętrze to dwa
  różne kolory.

### 1.6 Paczka i diagnostyka

Sonda czasu klatki i licznik świateł ładują się na żądanie, nie w chunku wejściowym.
Chunk wejściowy **239 954 B** wobec nietkniętego budżetu 240 000 B (`main` 33 311 /
50 000, `hybrid-spike` 34 305). Zapis wyników przechodzi przez `writeReport()`: waliduje
komplet scenariuszy i prób, pisze plik tymczasowy i dopiero podmienia, więc
`bench-voxel-low.json` nie może już mieć 0 bajtów.

---

## 2. Izolacja serii pomiarowych

To okazało się przyczyną sprzeczności, nie przypisem do niej.

- **Światy porównywane w jednym procesie** (`BENCH_WORLDS=voxel,hybrid-direct`),
  naprzemiennie scenariusz po scenariuszu, z zamienianą kolejnością pierwszeństwa.
  Wcześniej voxel i hybryda jechały jako dwa procesy w odstępie minut, więc wszystko, co
  maszyna zrobiła w przerwie, ląduje na mierzonej różnicy.
- **Kanarek**: ten sam tani scenariusz mierzony jako pierwszy i ostatni w każdym
  przebiegu; przebieg, w którym kanarek drgnął, **nie może dać PASS**. Wszystkie
  dotychczasowe: stabilny do 0,1 ms.
- **`BENCH_ORDER=given|reverse|shuffle`**, a każdy wynik zapisuje swoją pozycję w serii.
  Nocna ulica czyta się tak samo na pozycji 1, 4 i 9.
- **Stan maszyny przy każdym pomiarze**: load average i najbardziej obciążające procesy
  obce wokół okna pomiarowego. Ten pulpit nigdy nie jest bezczynny — kompozytor, okno
  rozmowy i narzędzie projektowe siedzą na tym samym GPU — i to jest teraz zapisana
  współzmienna, nie wyjaśnienie podawane po fakcie.
- **`BENCH_UNCAPPED=1`** wyłącza vsync do pomiarów zapasu, a uruchomienie bez vsync jest
  odrzucane, jeśli ktoś spróbuje ocenić je bramką 58 FPS.

---

## 3. Nocna wydajność — przepisane na podstawie pomiaru

### 3.1 Dlaczego FPS nie odpowiadał na to pytanie

Pod vsync czas klatki jest kwantowany do wielokrotności 16,7 ms, więc FPS mówi tylko
„w budżecie" albo „poza nim". Dlatego nocna ulica czyta się jako 60,0 **albo** 48,3 i
nigdy nic pomiędzy, i dlatego dwa klastry uruchomień tego samego kodu mogły się różnić o
12 FPS. Z wyłączonym vsync czas klatki jest ciągły i da się porównywać koszty.

### 3.2 Z czego zrobiona jest nocna klatka

Rozdzielczość produktu (pixel ratio 1,15, 1655×1035), światło i geometria bez zmian,
oba światy w jednym procesie, powtórzenia zgodne do 0,1 ms (`night-attribution.json`):

| stan | ms/klatkę |
|---|---|
| voxel (produkt) | **11,9–12,1** |
| hybryda jak jest | **14,8–15,0** |
| hybryda, światła lokalne zgaszone | **3,58–3,59** |
| voxel, światła lokalne zgaszone | 3,30–3,36 |
| hybryda, szkło ukryte | 14,58–14,73 |
| hybryda, fragment ukryty | 9,54–9,62 |

Z tego, wszystko z pomiaru:

- **Szesnaście świateł lokalnych to 11,2 ms z 14,8 ms klatki** — i produkt płaci za
  światła tyle samo. Noc jest droga od świateł, nie od fragmentu.

  > **Sprostowanie z 2026-09-04.** To zdanie miało dalej „0,71 ms na światło" i „produkt
  > płaci 11,9 z 12,0 ms". Oba są błędne. 0,71 to 11,2 podzielone przez 16, czyli
  > założenie liniowości, którego nikt nie zmierzył: eksperyment
  > `light-cost-experiment.json` pokazuje próg, nie prostą — 18 → 16 świateł oddaje
  > 9,43 ms (4,72 ms na światło), 16 → 12 oddaje 4,37 ms (1,09 ms), a 12 → 8, 8 → 4 i
  > 4 → 0 nie oddają nic (0,02, −0,04 i 0,10 ms, wszystko w szumie). „11,9 z 12,0 ms"
  > sparowało dwie liczby z różnych trybów pomiaru i wyszło z niego, że światła są
  > praktycznie całą klatką. W jednym kontrolowanym przebiegu bez vsync produkt ma
  > 15,83 ms przy 18 światłach i 6,70 ms przy zerowej liczbie: **koszt świateł w
  > produkcie to ≈9,1 ms z ≈15,8 ms, a nie 11,9 z 12,0**. Arytmetyka właściciela na
  > starszych liczbach (12 − 3,34 ≈ 8,6 ms) wypada w tym samym miejscu; wspólny wniosek
  > jest ten sam — poza światłami zostaje jeszcze ok. 6,7 ms klatki, której żaden budżet
  > świateł nie tknie.
- **Fragment dokłada 2,85 ms przy zapalonych światłach i 0,25 ms przy zgaszonych.** Jego
  koszt *to* jego piksele cieniowane szesnastoma światłami w rendererze forward.
- Klatka skaluje się z liczbą pikseli: 14,8 ms przy 1,71 Mpx wobec 10,94 ms przy
  1,30 Mpx (stosunek 1,35 przy 1,32 pikseli). Klatka jest fill-bound.
- „Fragment ukryty" jest **tańszy** od produktu, bo świat hybrydowy wyłącza pięć bloków,
  które fragment zastępuje: ukrycie go zostawia dziurę. Własny koszt fragmentu to
  hybryda minus voxel, nie hybryda minus ukryty.
- Intensywność świateł nie jest dźwignią: three.js kompiluje liczbę świateł w szader,
  więc wyzerowanie ośmiu z szesnastu nie zmieniło nic (14,82 wobec 14,97 ms).

### 3.3 Tańszy materiał — zmierzony przed wyborem

Cztery warianty, każdy zbudowany osobno, mierzony bez vsync przy 1,15, ze światem voxel
w tym samym procesie jako odniesieniem stanu maszyny (`night-attribution-summary.json`):

| wariant | nocna klatka hybrydy | koszt fragmentu | chunk |
|---|---|---|---|
| trzy oktawy szumu (obecnie) | 14,01 / 13,85 ms | 2,82 / 2,63 ms | 34 305 B |
| **bez szumu** | **13,47 / 13,39 ms** | **2,25 / 2,21 ms** | 34 160 B |
| jedna oktawa | 13,82 / 13,83 ms | 2,63 / 2,62 ms | 34 238 B |
| dwie oktawy | 13,81 / 14,89 ms | 1,75 / 2,88 ms | 34 275 B |

**Usunięcie szumu w całości kupuje 0,5 ms z 14,8 ms — 3,4% klatki — a spłaszcza każdą
powierzchnię fragmentu.** Jedna i dwie oktawy nie kupują nic mierzalnego. Ukrycie całego
szkła kupuje 0,15 ms. Materiał nie jest tu dźwignią i nie zamieniam ostrości obrazu na
te 0,5 ms.

### 3.4 Zmierzone dźwignie

| dźwignia | oszczędność na 14,8 ms | co kosztuje |
|---|---|---|
| bez proceduralnego szumu | 0,5 ms | płaski fragment |
| bez warstw szkła | 0,15 ms | okna przestają być szkłem |
| ~~jedno światło lokalne mniej~~ | ~~0,71 ms~~ | **wycofane 2026-09-04: koszt nie jest liniowy, patrz niżej** |
| 18 → 16 świateł | 9,43 ms | dwa ciemne światła, których nie widać w obrazie |
| 16 → 12 świateł | 4,37 ms | pule okien gasną, latarnie świecą dalej emisyjnie |
| 12 → 8 świateł | 0,02 ms | nic nie kupuje, a zabiera światło z ulicy |
| pixel ratio 1,15 → 1,00 | 3,9 ms | 13% mniej rozdzielczości liniowej |

Zapas dziś: **1,9 ms z fragmentem, 4,7 ms bez niego.**

---

## 4. Adaptacyjna rozdzielczość — ocena, nie wdrożenie

Optymalizacja materiału nie wystarczyła (0,5 ms z potrzebnych ~2,9 ms), więc oceniam
rozdzielczość — i tylko oceniam. Nie wprowadzam jej: to zmiana zachowania całego
produktu, nie naprawa spike'u.

**Produkt już ma taką zasadę i już ma w niej wyjątek dopasowany do jednego pomiaru.**
`bootstrap.ts` liczy `pixelRatio = min(devicePixelRatio, max(1, quality.pixelRatio ×
distanceScale × cameraScale))`, gdzie:

- `distanceScale` = 1 blisko / 0,8 daleko, przełączane odległością ostrości z histerezą
  112/102 m — **to jest zasada**: dalej znaczy mniej czytelnego detalu;
- `cameraScale` = 0,87 **tylko dla kamery autobusu**, z komentarzem „sprawiała, że High
  spadał na co drugi vblank na M1" — **to jest wyjątek dopasowany do jednego pomiaru na
  jednej maszynie**, dokładnie ten kształt, którego nie należy mnożyć. Nocna ulica byłaby
  drugim takim wyjątkiem.

Spójna zasada, która obejmuje oba przypadki: **skalować rozdzielczość zmierzonym kosztem
klatki, nie tożsamością kamery.** Pętla o dyscyplinie selektora LOD, który już mamy:
mediana czasu klatki z ostatnich N klatek, progi wejścia i wyjścia (histereza),
cooldown, dolna granica pixel ratio, jeden stopień na raz. Wtedy żaden kadr — nocna
ulica, deszcz w południe, przyszła dzielnica — nie potrzebuje własnej stałej.

Co to kupuje, z pomiaru: 1,15 → 1,00 to 3,9 ms, czyli 5,8 ms zapasu zamiast 1,9 ms.
Co kosztuje: 13% rozdzielczości liniowej tam i tylko tam, gdzie klatka i tak by nie
zdążyła.

**Warunek, bez którego nie wolno tego wprowadzić:** adaptacyjna rozdzielczość unieważnia
bramkę FPS, jeśli raport nie podaje rozdzielczości, w której klatka faktycznie
powstała — „60 FPS" zaczyna wtedy znaczyć „tyle pikseli, ile się zmieściło". Benchmark
zapisuje już `pixelRatio` i rozmiar kanwy przy każdym wyniku; przy takiej pętli musiałby
podawać ich **rozkład w oknie pomiarowym**, a bramka brzmieć „58 FPS przy pełnej
rozdzielczości profilu", nie „58 FPS".

Alternatywa o podobnym efekcie: **budżet świateł**. Trzy światła mniej na High to 2,1 ms
i mieści się w istniejącej zasadzie („ile świateł wolno danemu poziomowi jakości"), tylko
wprost zmienia nocny obraz całego miasta. Wybór między tymi dwiema zasadami należy do
właściciela; obie są wycenione.

---

## 5. Testy i gdzie są pełne dowody

| Test | Plik / faza | Co mierzy |
|---|---|---|
| proporcje i styk z ziemią | `src/world/hybrid/proportions.test.ts` (14) | gotowe bryły: autobus, oba rowery, listonosz, pies, wiata, ławka, jezdnia |
| prześwity, przejścia, oczekujący | `src/world/hybrid/clearance.test.ts` (15) | wiata na chodniku, ludzie pod dachem i nie w sobie, kolizjoner rozmiaru słupka, trasa nie po trawie, luz autobusu |
| szyby autobusu | `src/world/Bus.test.ts` (6) | ciemne i niegasnące w dzień, ciepłe i świecące nocą, cyjan w Cyberpunku |
| histereza LOD | `src/world/hybrid/lodHysteresis.test.ts` (7) | oba progi w obu kierunkach, pasmo, drgania, cooldown, sufit Low, najazd i odjazd |
| deterministyczność | `src/world/hybrid/determinism.test.ts` (4) | skróty FNV-1a wszystkich atrybutów wszystkich geometrii wszystkich klastrów |
| materiały | `SPIKE_PHASE=materials` → `spike-materials.json` | LOD 0/1/2 × High/Low, okna, kohorty; śnieg i wilgoć w **czterech** kombinacjach jakość × dzień/noc |
| listonosz | `SPIKE_PHASE=postman` → `spike-postman.json` + kadry | pozycja, poza i kontakt w ruchu, w świetle |
| koszt nocny | `night-attribution.json`, `night-attribution-summary.json` | widoczny / ukryty / odpięty / bez świateł / bez szkła, warianty materiału, skalowanie rozdzielczości |
| komplet wydajności | `bench-{voxel,hybrid-direct}-{high,low}.json` | 36 scenariuszy, po 3 próby TTI |
| kadry | `docs/superpowers/spike/frames/` | 8 kadrów hybrydy + 8 produktu + 2 listonosza |

Zestaw jednostkowy: **260 testów w 39 plikach**, `tsc --noEmit` czysty, smoke
przeglądarkowy zielony, budżety paczki spełnione.

### 5.1 Że te testy wykrywają regresje

Trzynaście przypadków kontrolowanego przywrócenia usterki, każdy z listą testów, które
padły: `negative-controls.json` (geometria, skala, szyby) i
`negative-controls-materials.json` (okna w LOD 0, kohorty). Po każdym przywróceniu
zestaw znowu zielony.

Cztery instrumenty **najpierw nie wykryły** usterki, którą miały łapać, i to jest
najważniejsza część tego rozdziału:

1. Test listonosza mierzył w układzie roweru, gdzie koła dotykają `y = 0` niezależnie od
   tego, jak wysoko lata cały zestaw. Mierzy teraz także w układzie świata.
2. Pomiar okien przy 300 m obejmował głównie bloki produktu: fragment dawał 824
   rozjaśnione piksele, produkt 827, a usunięcie szkła nie ruszyło żadnej z tych liczb.
   LOD 0 osiąga się teraz wysokością okna, fragment izoluje różnica dwóch światów piksel
   po pikselu, a miarą jest suma przyrostu jasności (0,17 wobec 0,07 z usterką).
3. FPS pod vsync nie mierzył zapasu — rozdział 3.
4. Dwa procesy w odstępie minut nie mierzyły różnicy między światami, tylko różnicę
   między stanami maszyny — rozdział 2.

---

## 6. Kadry

Osiem kadrów hybrydy i osiem odpowiedników produktu z tym samym ziarnem i kamerą, plus
dwa kadry listonosza, w `docs/superpowers/spike/frames/`: przegląd neutralny, poziom
oczu, kamera autobusu, kamera toura, złota godzina, noc, przegląd Low, ulica Low,
`hybrid-direct-high-postman{,-close}.jpg`.

Ocena, do zakwestionowania kadrami:

- **Autobus wygląda jak pojazd i ma szkło.** Tylna szyba czyta się jako ciemna tafla,
  bok bierze niebo pod małym kątem, nocą świeci wnętrze. Koła na jezdni.
- **Przystanek jest czytelniejszy**: chodnik pod wiatą, czterech ludzi pod dachem,
  ławka pod nim, nikt nie stoi w słupku.
- **Rowery i mieszkańcy z jednego świata**: autobus/pasażer 1,54, autobus/rower 2,73,
  pasażer/rower 1,77.
- **Listonosz jedzie, a nie leży na kierownicy** — po korekcie pochylenia. Jego rower
  nadal jest ciemny na ciemnym asfalcie w cieniu bloku; kadr trzeba stawiać od strony
  słońca, co harness robi.
- **Low trzyma sylwetkę**: różni się brakiem podziałów okien, nie brakiem obiektów.
- **Kamera toura nie odwiedza fragmentu** — tour jedzie za pociągiem.
- **Szyby pociągu są zrobione tak, jak były szyby autobusu** (`color: windowLit,
  emissive: windowLit`) i w dzień będą równie płaskie. Nie tknięte: to inny obiekt w
  innej części miasta i nikt jeszcze nie patrzył na jego kadr.

---

## 7. Pozostałe luki

1. **Nocna ulica na High stoi 1,9 ms pod progiem klatki** i przy zajętym pulpicie
   przechodzi na drugą stronę. Przyczyna zmierzona, dźwignie wycenione, wybór zasady
   należy do właściciela. **To nadal blokuje merge.**
2. **Reszta kosztu fragmentu** (2,2 ms z 2,85 po odjęciu szumu i szkła) to jego piksele
   pod szesnastoma światłami; rozbicie tego dalej wymagałoby licznika na przebieg
   świetlny, którego forward renderer nie daje.
3. **Szyby pociągu** — ten sam wzór, co poprawiony w autobusie.
4. **Streetscape 2.0** — nadal wydzielone, nie zrobione.
5. **28 JPEG-ów w historii Git** — decyzja właściciela, wciąż otwarta.

---

## 8. Stan gałęzi i werdykt

Drzewo czyste, `main` nietknięty. `tsc` czysto, 260 testów zielonych, smoke zielony,
budżety paczki niezmienione i spełnione.

**Werdykt: wstrzymane jedną bramką, ale to już nie jest zagadka — to wycena.**

Nocny kadr uliczny kosztuje 14,8 ms z 16,7 ms budżetu, z czego 11,2 ms to szesnaście
świateł, które produkt płaci tak samo, a 2,85 ms to piksele fragmentu pod tymi
światłami. Materiał zmierzony i odrzucony jako dźwignia: 0,5 ms za spłaszczenie całego
fragmentu. Do wyboru zostają dwie zasady o podobnym efekcie — koszt klatki jako
sterowanie rozdzielczością albo budżet świateł jako sterowanie nocą — obie wycenione w
milisekundach i obie widoczne w obrazie. Nic w tej rundzie nie zostało zamienione na
zielony wynik testu.
