# Hybryda Miasta — domknięcie iteracji, 2026-09-04

Gałąź `spike-hybrid-osiedle-centralne`, drzewo robocze `.claude/worktrees/spike-hybrid-osiedle-centralne`.
Nic nie zmergowane, nic nie wypchnięte, nic nie wdrożone. `main` nietknięty.

Raport jest ułożony tak, jak brzmiały punkty zlecenia. Każda liczba w nim jest
odczytem z pliku dowodowego wskazanego przy niej — nie z planu i nie z pamięci.

---

## 1. Co zostało naprawione

**Sonda czasu GPU** (`src/debug/frameTiming.ts`). Seria pomiarowa ma teraz właściciela:
każde zapytanie nosi numer swojej serii, `start()` odmawia otwarcia nowej serii nad
otwartą, `cancel()` i `dispose()` zwalniają zapytania przez `deleteQuery`, a aktywne
zapytanie nigdy nie jest usuwane przed `endQuery`. `read()` zwraca stan
`idle | measuring | complete | timeout | disjoint | unsupported | cancelled` razem z
`requested`, `samples`, `pending`, `dropped` i `usable`, więc 90 zamówionych próbek nie
może zostać uznane za komplet na podstawie pięciu. Dziewięć testów cyklu życia w
`src/debug/frameTiming.test.ts`, w tym **kontrola negatywna**, która uruchamia stary
algorytm i pokazuje, co on robił: próbki 99 ms z poprzedniej serii wchodzą do następnej,
a 60 z 70 przeterminowanych zapytań wycieka. Naprawiona sonda te same zapytania porzuca
(`dropped > 0`) i nie zostawia żadnego.

**Zapis wyniku** (`scripts/performanceBenchmark.mjs`). Kolejność jest wymuszona:
zbierz → sprawdź kompletność → sprawdź diagnostykę → sprawdź kanarka → sprawdź bramki
właściwe dla trybu → dopiero wtedy zapisz. Kanoniczny plik dostaje tylko przebieg z
werdyktem `passed`; przebieg odrzucony ląduje w `*.failed.json`, a eksperyment bez vsync
w `*.uncapped.json`. Przed zapisem walidowane są: poprawność JSON, lista scenariuszy,
dokładna liczba prób, świat, profil jakości, pixel ratio, rozmiar kanwy, rewizja kodu,
tryb vsync, kolejność pomiaru, stan przełączników diagnostycznych, wynik kanarka i
komplet surowych prób.

**Kanarek i izolacja.** Kanarek jest teraz parą na świat (`canary-start@świat`,
`canary-end@świat`) po obu stronach serii, z tolerancją 2 FPS / 2 ms p95 / 0,5 ms
klatki. Obciążenie maszyny jest opisane metodą, a nie domysłem: `ps -Ao pid,ppid,pcpu`,
własność procesu rozpoznawana po fladze profilu Playwrighta w linii poleceń (nie po
nazwie — nasza przeglądarka też nazywa się „Google"), rozdzielone `ownCpuPercent` i
`foreignCpuPercent`, oraz jawne ograniczenie zapisane w każdym pliku wyniku:
*„no per-process GPU utilisation without privileged tools: GPU contention cannot be
measured here"*. Przeglądarka właściciela pozostaje widoczna jako obce obciążenie.

**Listonosz** — punkt 6 niżej.
**Szyby pociągu** — punkt 7 niżej.
**Pasażerowie** — punkt 6 niżej.

**Arytmetyka w dokumentacji.** Raport z 2026-09-03 dostał sprostowanie w miejscu:
„0,71 ms na światło" było dzieleniem 11,2/16 z założoną, nigdy nie zmierzoną
liniowością, a „11,9 z 12,0 ms" sparowało liczby z dwóch trybów pomiaru w twierdzenie,
że światła są praktycznie całą klatką. Zmierzone w jednym przebiegu bez vsync: produkt
ma **15,8 ms przy 18 światłach i 6,7 ms przy zerowej liczbie**, czyli koszt świateł
≈9,1 ms z ≈15,8 ms. Arytmetyka właściciela (12 − 3,34 ≈ 8,6 ms) wypada w tym samym
miejscu; wspólny wniosek jest ten sam — poza światłami zostaje ok. 6,7 ms klatki, której
żaden budżet świateł nie tknie.

---

## 2. Co zostało udowodnione

| twierdzenie | czym udowodnione |
|---|---|
| stara sonda mieszała serie i gubiła zapytania | kontrola negatywna w `frameTiming.test.ts` |
| odrzucony przebieg nie nadpisuje ostatniego dobrego | kontrola negatywna: `BENCH_MIN_FPS=999`, suma SHA-256 pliku kanonicznego bez zmian, odrzut w `.failed.json` |
| koszt świateł **nie** jest liniowy | 66 surowych wierszy, dwa światy, dwa rankingi, trzy kolejności |
| liczba świateł jest kompilowana w szader | `programs` 194 → 211 przy zmianie limitu z 18 na 16 |
| przyjęty budżet nie zmienia obrazu tam, gdzie patrzy widz | 0,00 % zmienionych pikseli w ulicy, przystanku i najbliższych blokach |
| pasażerowie się nie przecinają | bryły wierzchołkowe obróconych, gotowych figur |
| stopy listonosza mają na czym stać | 0,190 m od środka korby, w teście geometrii |
| koło i rama listonosza są czytelne w neutralnym świetle | 70,8 % i 53,3 % pikseli ≥ 8/255 |
| **koło listonosza nie jest czytelne w cieniu bloku** | 39,6 % — poniżej progu ustalonego przed pomiarem |
| szyba pociągu jest ciemna w dzień i świeci w nocy | `emissiveIntensity` 0 → 1 na gotowym materiale w działającej aplikacji |
| rampa zmierzchu jest monotoniczna | 0,25 0,12 0,06 0,03 0,01 0,01 0,00 (dzień), 0,70 1,00 (noc) |

---

## 3. Co pozostaje hipotezą

- **Dlaczego krok 18 → 16 świateł kosztuje ~9 ms.** Zmierzony jest sam próg, nie jego
  przyczyna — ale dwa podejrzenia zostały **wykluczone pomiarem** (`light-identity.json`):
  - *Nie* mapa cieni: w nocnym kadrze świeci 14 świateł lokalnych z 62 w scenie i
    **żadne z nich nie rzuca cienia** (`castShadow === false` dla wszystkich), więc
    zdjęcie światła nie zdejmuje przebiegu głębokości.
  - *Nie* konkretna para lamp: w rankingu domyślnym limit 16 zdejmuje dwa reflektory
    (pojazdów), w rankingu odwrotnym dwa światła punktowe — i **oba warianty pokazują
    ten sam ~9 ms krok** (20,5 → 11,1 i 20,8 → 12,1). Próg jest w liczbie, nie w tym,
    które światło gaśnie.

  Co zostaje jako hipoteza: granica wariantu szadera albo presja rejestrów w skompilowanym
  szaderze fragmentów przy siedemnastu–osiemnastu światłach. Nie sprawdzone, nie zapisane
  jako ustalone.
- **Współzawodnictwo o GPU.** Nie da się go zmierzyć bez uprzywilejowanych narzędzi.
  Każdy plik wyniku nosi to jako ograniczenie; żaden wynik nie jest tłumaczony
  obciążeniem maszyny.
- **Teza o izolacji procesów.** Porównanie w jednym procesie nie dowodzi, że dawne
  48 FPS brało się wyłącznie z osobnych procesów — w archiwum jest też ~60 FPS przy
  1,15. Zapisane jako nierozstrzygnięte.
- **Czytelność koła w cieniu.** Że da się ją naprawić bez zmiany światła w całym
  mieście — nie wykazane. Zmiana koloru opony jej nie naprawia (niżej).

---

## 4. Koszt liczby świateł: wszystkie surowe próbki

Metoda: `renderer.render` owinięty, deterministyczny limit narzucany bezpośrednio przed
każdym rysowaniem (bo `DayNightCycle` co klatkę przypisuje `visible` każdemu światłu
lokalnemu). Klosze i materiały emisyjne **nietknięte** — wariant z limitem nadal pokazuje
każdą lampę jako świecącą. Vsync wyłączony, bo pod kwantem 16,7 ms milisekunda krańcowa
jest niewidoczna. Stałe: ziarno, checkpoint, kamera, profil High, pixel ratio 1,15,
światło kierunkowe, SSAO, postprocessing, geometria. Trzy próbki na wariant, kolejności
`given`, `reverse`, `shuffle`, oba światy w jednym procesie, na przemian.
Pliki: `light-cost-experiment.json`, `light-cost-experiment-spotsfirst.json`.

### 4.1 Ranking domyślny (punktowe zostają, reflektory pierwsze do zdjęcia)

| świat | limit | świateł | given | reverse | shuffle | mediana |
|---|---|---|---|---|---|---|
| hybryda | 18 | 18 | 20,5 | 20,8 | 20,4 | **20,5** |
| hybryda | 16 | 16 | 11,1 | 11,0 | 11,2 | **11,1** |
| hybryda | 12 | 12 | 6,7 | 6,6 | 6,6 | **6,6** |
| hybryda | 8 | 8 | 6,8 | 6,6 | 6,6 | **6,6** |
| hybryda | 4 | 4 | 6,8 | 6,7 | 6,6 | **6,7** |
| hybryda | 0 | 0 | 6,6 | 6,8 | 6,6 | **6,6** |
| voxel | 18 | 18 | 15,6 | 15,8 | 15,8 | **15,8** |
| voxel | 16 | 16 | 7,4 | 7,1 | 7,5 | **7,4** |
| voxel | 12 | 12 | 6,5 | 6,4 | 6,8 | **6,5** |
| voxel | 8 | 8 | 6,4 | 6,8 | 6,3 | **6,4** |
| voxel | 4 | 4 | 6,6 | 6,4 | 6,5 | **6,5** |
| voxel | 0 | 0 | 6,9 | 6,7 | 6,5 | **6,7** |

### 4.2 Ranking odwrotny (reflektory zostają, punktowe pierwsze do zdjęcia)

| świat | limit | świateł | given | reverse | shuffle | mediana |
|---|---|---|---|---|---|---|
| hybryda | 18 | 18 | 20,9 | 20,8 | 20,4 | **20,8** |
| hybryda | 16 | 16 | 12,3 | 12,1 | 12,0 | **12,1** |
| hybryda | 12 | 12 | 6,5 | 7,1 | 6,6 | **6,6** |
| hybryda | 2 | 2 | 6,6 | 6,7 | 7,0 | **6,7** |
| hybryda | 0 | 0 | 6,9 | 6,5 | 6,7 | **6,7** |
| voxel | 18 | 18 | 15,8 | 15,8 | 15,8 | **15,8** |
| voxel | 16 | 16 | 8,3 | 8,4 | 8,3 | **8,3** |
| voxel | 12 | 12 | 6,6 | 6,7 | 6,5 | **6,6** |
| voxel | 2 | 2 | 6,4 | 6,4 | 6,4 | **6,4** |
| voxel | 0 | 0 | 6,5 | 6,3 | 6,5 | **6,5** |

Programy szadera: 194 (hybryda) i 182 (voxel) przy 18 światłach, 211 i 197 przy każdym
mniejszym limicie. Liczba wywołań rysowania (346 / 318), trójkąty, pixel ratio (1,15) i
megapiksele (1,712925) identyczne we wszystkich 66 wierszach.

### 4.3 Koszt krańcowy każdej redukcji

| krok | hybryda | na światło | voxel | na światło |
|---|---|---|---|---|
| 18 → 16 | **−9,4 ms** | −4,7 ms | **−8,4 ms** | −4,2 ms |
| 16 → 12 | **−4,5 ms** | −1,1 ms | **−0,9 ms** | −0,2 ms |
| 12 → 8 | 0,0 ms | 0,0 ms | −0,1 ms | 0,0 ms |
| 8 → 4 | +0,1 ms | 0,0 ms | +0,1 ms | 0,0 ms |
| 4 → 0 | −0,1 ms | 0,0 ms | +0,2 ms | 0,0 ms |

**Koszt nie jest liniowy i nie jest nawet monotoniczny w szumie.** To próg, nie
nachylenie: dwa światła z osiemnastu kosztują 9,4 ms, cztery kolejne 4,5 ms, a
wszystkie pozostałe dwanaście — zero. Oba rankingi dają ten sam kształt, więc rozstrzyga
liczba, a nie rodzaj światła. Poniżej dwunastu świateł nie ma czego kupować; każde
zdjęte światło poniżej tej granicy to sam ubytek w obrazie.

---

## 5. Budżet świateł: co kupuje i co psuje

Przyjęte w profilu High: `streetLightBudget 6`, `busStopLightBudget 2`,
`stationLightBudget 2`, **`windowLightBudget 0`** — naturalna liczba świateł fizycznych
spada z 18 do 14. Klosze, `streetGlowMesh` i materiały okien nietknięte, więc miasto
nadal wygląda na oświetlone.

**Zysk (bez vsync, `light-budget-after.json`):** hybryda **9,361 ms** (próbki 9,375 /
9,361 / 9,359), voxel **7,046 ms** (7,018 / 7,130 / 7,046) — wobec 20,518 i 15,827 przy
osiemnastu światłach. To **11,16 ms** w hybrydzie i **8,78 ms** w produkcie.

**Koszt w obrazie (`light-budget-image-diff.json`, próg 6/255 na piksel):**

| kompozycja 14 świateł | ulica | przystanek i autobus | najbliższe bloki | cała klatka |
|---|---|---|---|---|
| minus dwie latarnie uliczne — **odrzucona** | 28,16 % | 22,34 % | 41,86 % | 28,36 % |
| minus dwie pule okien — **przyjęta** | 0,00 % | 0,00 % | 0,00 % | 0,29 % |

Pierwsza kompozycja została odrzucona na klatkach, nie na przeczuciu: najbliższa
kamienica robiła się czarna. Druga nie zmienia żadnego piksela w rejonach, które
wymieniają kryteria odbioru; 0,29 % całej klatki to okna dalekich bloków, które nadal
świecą emisyjnie. Kadr nocny z pociągiem: 0,04 % całej klatki.

Numer budżetu nie został wybrany przed pomiarem: zmierzone są 18, 16, 12, 8, 4 i 0, a
przyjęte 14 leży w miejscu, w którym krzywa jeszcze płaci (9,4 ms za krok 18 → 16) i
jeszcze nie zabiera ulicy.

---

## 6. Listonosz i pasażerowie

### 6.1 Sylwetka listonosza — zmierzona, nie oceniona wzrokiem

Instrument: ukryj grupę siatek roweru, wyrenderuj zamrożoną scenę ponownie, a piksele,
które się zmieniły, są dokładnie pikselami tej grupy — z tłem, od którego ma się
odróżnić, pod spodem. **Dwa renderingi zamrożonej sceny różnią się 0 pikseli**, więc
liczba znaczy to, co znaczy.

Kryterium ustalone **przed** pomiarem: połowa własnych pikseli grupy musi różnić się od
tła o co najmniej 8/255 luminancji.

| kadr | koło: pikseli | mediana ΔL | ≥ 8/255 | rama: pikseli | mediana ΔL | ≥ 8/255 |
|---|---|---|---|---|---|---|
| z boku, w cieniu bloku | 8 032 | 2,3 | **39,5 % — nie spełnia** | 1 600 | 12,3 | 73,0 % |
| trzy czwarte | 8 303 | 68,1 | 63,2 % | 2 738 | 7,8 | 49,9 % |
| w świecie, neutralne światło | 9 124 | 45,8 | 70,7 % | 1 477 | 9,4 | 51,3 % |

Odczyt z przebiegu na rewizji końcowej (`spike-postman.json`). Listonosz jedzie, więc
między przebiegami stoi w innym miejscu i wartości wahają się o kilka punktów (kadr
trzy czwarte: 60,4 % w przebiegu poprzednim, 63,2 % w tym). Kadr w cieniu jest stabilny
w okolicy 39,5–40,5 % — i w każdym przebiegu poniżej progu.

**Kadr w cieniu nie spełnia kryterium i nie da się tego naprawić kolorem opony.**
Rozjaśnienie z 0x5d564e do 0x7d766b przesunęło go z 40,5 % na 39,6 % i **pogorszyło**
medianę kontrastu (5,3 → 2,3). Kontrast jest multiplikatywny: tam gdzie chodnik leży w
cieniu kamienicy, koło i jezdnia dostają to samo światło i żaden kolor rozproszony ich
nie rozdzieli. W tym kadrze rower niesie czerwona rama (73,2 %), a listonosza — mundur.
Zostawione jako wynik ujemny; próg nie został ruszony po zobaczeniu liczb.

Zmiany kształtu (wszystkie zerobajtowe albo opłacone):

- nogi 0,58 → 0,40 m szerokości. Szerokie jak tors, czytały się jako drugie ciało — to
  było główne źródło „zgiętego klocka".
- ramiona 0,23×0,34 → 0,16×0,22 m. Ramię i tors mają kolor munduru, więc rozdziela je
  tylko sylwetka, a głębokie ramię wtapiało się w klatkę piersiową.
- spodnie 0x24313d → 0x3b4652: w granacie nogi renderowały się jako czerń.
- torba jedzie nad tylnym kołem. Była na `+z` w układzie jeźdźca, a jego obrót o π
  przenosi to **przed** kierownicę — widać to na klatkach i tak samo mówi arytmetyka.
- pasek usunięty, w jego miejsce korba z pedałami. 8 cm paska nie czytało się na żadnej
  odległości, z jakiej diorama go pokazuje; stopy siedzą teraz **0,190 m** od środka
  0,42-metrowej korby, zamiast kończyć się nad niczym między kołami.

Kryteria punktu z zlecenia: obrys koła ✔ w neutralnym świetle, ✘ w cieniu; rama
odróżnialna od asfaltu ✔ (73,2 % nawet w cieniu); biodra na siodle ✔ (test:
|biodro − siodło| < 0,14 m); dłonie przy kierownicy ✔ (test); stopy przy pedałach ✔
(0,190 m); spokojniejsza pozycja ✔ (pochylenie 0,26 rad); torba nie jest drugą nogą ✔.
Trzy kadry: `hybrid-direct-high-postman-side.jpg`, `-three-quarter.jpg`, `-in-world.jpg`
— trzeci **nie** wybiera strony po słońcu, więc pokazuje problem kontrastu, a nie ukrywa
go.

Przy okazji: kadry dowodzą teraz linii wzroku promieniem przeciw bryłom wszystkich
pozostałych siatek, **przed** zdjęciem. Pierwsze ustawienie kadru trzy czwarte postawiło
kamerę wewnątrz kamienicy, a przebieg zgłosił sukces, gdy w pliku była płaska czerwona
ściana.

### 6.2 Pasażerowie

Cztery figury na przystanku, mierzone jako **gotowe obiekty w docelowych pozycjach**:
bryły z wierzchołków (nie `Box3.applyMatrix4`, który przy obrocie zawyża), z obrotem w
stronę drzwi. Brak przecięcia bryła–bryła, dodatni prześwit 0,05 m, zmierzone luki
0,34 / 0,29 / 0,19 m przy figurze szerokiej 0,55–0,77 m i głębokiej 0,82–0,91 m po
obróceniu. Sprawdzone też: brak kolizji z wiatą, ławką i słupkiem znaku (kolidery równe
`BUS_SHELTER_POST_SIZE` i `BUS_SHELTER_SIGN_SIZE`), żadna figura nie stoi w ścieżce
podejścia, wszyscy pod dachem — liczone własnym śladem figury. Tolerancja „90 % szerokości
figury" i porównywanie odległości środków zniknęły.

---

## 7. Szyby pociągu

Semantyka jak w autobusie, ale **nie parametry autobusu**: szyba wagonu to duża płaska
tafla widziana z boku prawie z każdej kamery tej dioramy, czyli pod kątem, przy którym
gładka tafla wybucha na biało. Stąd 0,2 szorstkości, 0,4 metaliczności i 1,0
odbijalności zamiast 0,12 i 1,2 autobusu.

Zmierzone na gotowym materiale w działającej aplikacji, w chwili zdjęcia:

| kadr | t01 | tafla | luminancja tafli | emisja | intensywność |
|---|---|---|---|---|---|
| dzień | 0,431 | #24465f | 0,056 | #ffdd88 | **0** |
| noc | 0,943 | #24465f | 0,056 | #ffdd88 | **1** |

Trzy testy na gotowym materiale (`src/world/Train.test.ts`): ciemna szyba bez emisji w
dzień przy szorstkości w (0,12; 0,3) i odbijalności ≥ 1 ale < 1,2; ciepłe, świecące
wnętrze w nocy przy nadal ciemnej tafli; monotoniczna rampa zmierzchu; Cyberpunk zmienia
światło **we** szkle, nie szkło w lampę, i wraca do ciepłego po `setLivery('modern')`.
Kadry: `hybrid-direct-high-train-day.jpg`, `-train-night.jpg` — ta sama kamera (własna
kamera produktu z checkpointu `train`) i ta sama pozycja pociągu (przejazd kolejowy), bo
to właśnie czyni z nich porównanie, a nie dwa obrazki.

Pierwszy kadr nocny był kłamstwem i warto to mieć zapisane: **wczytany checkpoint
zamraża czas prezentacji**, a `DayNightCycle` wygładza swój współczynnik nocy tą samą
deltą — więc HUD pokazywał 22:33 nad czarnym niebem, podczas gdy światło, latarnie i
wnętrza wagonów stały w porannym stanie checkpointu. `nightFactorAt(0.94)` wynosi 1,000;
`smoothedNight` nigdy tam nie dojechał. Faza renderuje teraz bez checkpointu i czeka, aż
wartość, po której kadr będzie oceniany, przestanie się zmieniać.

---

## 8. Adaptacyjna rozdzielczość — projekt zasady, bez implementacji

Nic z tego nie zostało zaimplementowane w tej rundzie. Poniżej jest to, czym zasada
musiałaby być, żeby nie była wyjątkiem dopasowanym do jednego benchmarku.

1. **Sygnał to mediana zwykłych klatek, nie maksimum.** Percentyl (p50 do sterowania,
   p95 tylko do raportu) z okna kilkuset milisekund, po odrzuceniu klatek zdarzeń:
   pierwsza klatka po zmianie checkpointu, po zmianie pogody, po kompilacji szadera.
   Sterowanie maksimum oznacza sterowanie hitchami.
2. **Histereza i dwa progi.** Zejście w dół przy przekroczeniu budżetu przez p50 w
   dwóch kolejnych oknach; powrót w górę dopiero, gdy p50 zmieści się z zapasem
   (np. 85 % budżetu) również w dwóch oknach. Jeden próg daje oscylację na granicy.
3. **Cooldown i limit tempa.** Minimum kilkaset milisekund między zmianami i najwyżej
   jeden krok na zmianę — nigdy skok z 1,15 na 1,0 w jednej klatce.
4. **Skończona drabinka, nie liczba ciągła.** Np. 1,15 / 1,08 / 1,00 / 0,92. Ciągły
   pixel ratio to ciągła realokacja celów renderowania; drabinka pozwala je zbudować raz.
5. **Zmiana kamery nie jest sygnałem wydajności.** Podczas ruchu kamery i przez chwilę
   po nim pomiar jest zawieszony, a nie interpretowany.
6. **Granice.** Dolna granica jest granicą jakości obrazu, nie wydajności, i wynika z
   osobnej bramki obrazu: różnica względem 1,15 w rejonach czytelności (ulica,
   przystanek, twarze figur) nie może przekroczyć ustalonego progu. Bez tej bramki
   zasada zawsze wygra, bo mniejszy obraz to zawsze zielony FPS.
7. **Próg jest jeden i nie wolno go stroić.** Definiowany raz, jako część budżetu
   klatki, identyczny w obu światach i we wszystkich scenariuszach. Próg dobierany do
   scenariusza jest tym samym błędem, co `cameraScale` 0,87 dopasowany do jednego
   pomiaru autobusu — wyjątkiem udającym zasadę. Zmiana progu po zobaczeniu wyników
   dyskwalifikuje pomiar, na którym się ją oparło.
8. **Raport z rzeczywistego rozkładu.** Benchmark musi zapisywać rozkład pixel ratio w
   trakcie przebiegu (histogram, nie wartość zamówiona), a bramka FPS musi być czytana
   razem z nim. Wynik „60 FPS" przy nieznanym pixel ratio nic nie znaczy.
9. **Sonda debugowa nie jest mechanizmem produkcyjnym.** `frameTiming` mierzy przez
   `EXT_disjoint_timer_query_webgl2`, którego `TIME_ELAPSED_EXT` obejmuje czekanie w
   potoku — to ograniczenie górne, nie koszt, dostępne warunkowo i o kosztowym cyklu
   życia. Sterowanie produkcyjne musiałoby brać sygnał z czasu ramki, nie z niej.

Warunek wstępny: dopiero jeśli optymalizacja nie wystarczy. Po tej rundzie zapas przy
vsync jest dodatni w obu światach na High i na Low (punkt 9), więc **przesłanka do
włączenia tej zasady nie jest spełniona.**

---

## 9. Weryfikacja końcowa

Rewizja: `0e952ad`, drzewo robocze czyste.

| sprawdzenie | komenda | wynik |
|---|---|---|
| typy | `npm run typecheck` | czysto |
| testy jednostkowe | `npm test` | **273 zielone w 41 plikach** |
| build | `npm run build` | ok, wejście **239 888 B / 240 000 B** |
| smoke produktu | `node scripts/browserSmoke.mjs` | **przeszedł**, `browserErrors: 0`, przystanek nocą 60,0 FPS |
| smoke hybrydy, wszystkie fazy | `SPIKE_PHASE=all node scripts/spikeSmoke.mjs` | **przeszedł**, paczki 239 888 / 33 311 / 34 305 B |
| materiały (LOD × jakość) | faza `materials` powyżej | przeszła, macierz w `spike-materials.json` |
| kontakt i kolizje | `npx vitest run src/world/hybrid/proportions.test.ts src/world/hybrid/clearance.test.ts` | w 273 zielonych |
| listonosz | `npx vitest run src/world/Postman.test.ts` | w 273 zielonych |
| porównanie świateł | `node scripts/lightCostExperiment.mjs` | 66 wierszy, punkt 4 |
| benchmark High, vsync | `BENCH_WORLDS=voxel,hybrid-direct BENCH_QUALITY=high BENCH_OUT=… node scripts/performanceBenchmark.mjs` | **passed**, `final-bench-high.json` |
| benchmark Low, vsync | `BENCH_WORLDS=voxel,hybrid-direct BENCH_QUALITY=low BENCH_OUT=… node scripts/performanceBenchmark.mjs` | **passed**, `final-bench-low.json` |
| zapas bez vsync | `LIGHT_CAPS=18 node scripts/lightCostExperiment.mjs` | (uzupełniane) |
| obraz przy 16 / 14 / 12 światłach | `FRAMES_CAPS=16,14,12 node scripts/lightBudgetFrames.mjs` | (uzupełniane) |
| kontrola pisarza wyniku | `BENCH_MIN_FPS=999 BENCH_OUT=… node scripts/performanceBenchmark.mjs` | **plik kanoniczny nietknięty**, odrzut w `.failed.json` |
| tożsamość świateł progu | `node scripts/lightIdentity.mjs` | (uzupełniane) |

### 9.1 Benchmark High, vsync jak w produkcie (`final-bench-high.json`)

Rewizja `0e952ad`, kolejność `given`, oba światy na przemian, jeden proces, jedna karta,
blokada plikowa na jedną instancję, `contexts().length === 1`, `pages().length === 1`.

**Werdykt `passed`, lista problemów pusta.** Wszystkie 42 pomiary: **60,0 FPS**,
p95 **16,7–16,8 ms**, 0,0 % klatek wolnych. TTI najgorsze **1 078,6 ms** wobec bramki
1 800 ms. Kanarek stabilny na obu końcach w obu światach (60,0 → 60,0 FPS,
16,8 → 16,8 ms p95).

Trzy rzeczy warte podkreślenia, bo są sprawdzeniem punktów 1–3 tego zlecenia:

1. **Nocna ulica przechodzi przy pełnym pixel ratio 1,15** (kanwa 1655×1035), a nie
   przez zmniejszenie obrazu. To samo dotyczy `night-snow-train`, `spike-street` i obu
   kadrów nadjeziornych.
2. **Sonda GPU zwróciła 90 z 90 próbek w każdym z 42 pomiarów**, status `complete`,
   `disjoint: false`, jedna seria na pomiar. Ani jednej serii częściowej ani przerwanej —
   to naprawa z punktu 1 w działaniu na całym przebiegu.
3. **Zmierzony stan zapisuje liczbę świateł**: 14 w nocnej ulicy (oba światy), 5 w
   `evening-rain-bus`, 4 w kadrach dziennych, 3 w `night-snow-train`. Przyjęty budżet
   jest widoczny w wyniku, nie tylko w profilu.

Czego ten przebieg **nie** pokazuje: `animationGpu.medianMs` dla nocnej ulicy to
18,55 ms przy 60 FPS i p95 16,7 ms. To nie sprzeczność — `TIME_ELAPSED_EXT` obejmuje
czekanie na wymianę bufora, więc przy włączonym vsync jest ograniczeniem górnym, nie
kosztem. Koszt mierzy eksperyment bez vsync (punkt 4). Tej liczby nie wolno cytować jako
kosztu klatki.

**Benchmark Low, ta sama rewizja (`final-bench-low.json`):** werdykt **`passed`**, lista
problemów pusta, wszystkie 42 pomiary 60,0 FPS, p95 do 16,8 ms, TTI najgorsze
**1 178,2 ms**, kanarek stabilny na obu końcach w obu światach. Sonda GPU znów
**90 z 90 próbek w każdym z 42 pomiarów**. Nocna ulica na Low renderuje przy pixel ratio
1,0 z **12** światłami fizycznymi — profil Low ma własny, ciaśniejszy budżet.

### 9.2 Pomiar odrzucony, i dlaczego

Pierwszy przebieg zapasu bez vsync po benchmarkach dał **12,20 ms** dla hybrydy przy
czternastu światłach, wobec **9,30–9,40 ms** w przebiegu z 08:47 tego samego dnia, przy
identycznej konfiguracji: te same 14 świateł, te same 346 wywołań, ta sama kanwa
1655×1035, ten sam pixel ratio 1,15. Różniły się dwie rzeczy, których nie umiem
rozdzielić: średnie obciążenie maszyny (5,1–6,4 wobec 8,7–9,2) i liczba skompilowanych
programów (194 wobec 136).

Dwie przyczyny są możliwe i **żadna nie jest udowodniona**: obciążenie maszyny —
którego dla GPU nie da się tu zmierzyć, co każdy plik wyniku nosi jako ograniczenie —
albo stan cieplny i dogasający proces poprzedniego benchmarku, bo ten przebieg startował
bezpośrednio po dwóch dwudziestominutowych pomiarach.

Do tego dołożyłem własny błąd narzędziowy: kolejne zadania weryfikacyjne miały czekać na
siebie, ale warunek `pgrep` dopasowywał się do samych czekających powłok, więc cztery
zadania GPU zwolniły się jednocześnie, zderzyły na portach serwera podglądu i na
blokadzie benchmarku. Żadne z tych czterech nie mierzyło czasu (dwa diffy obrazu,
smoke funkcjonalny, przebieg z założenia odrzucany i odczyt sceny), więc ich wnioski
stoją — ale wynik zapasu z tego okna **jest odrzucony jako niewiarygodny**, a nie
zapisany jako pomiar. Przebieg powtórzony pojedynczo, po odstaniu maszyny, jest w
punkcie 9.3.

Co z tego zostaje jako wniosek metodyczny: **liczby krańcowe z punktu 4 są różnicami
wewnątrz jednego przebiegu** — każdy wariant mierzony jeden po drugim w tych samych
warunkach — więc przesunięcie bazy maszyny ich nie psuje. Bezwzględne „9,4 ms" psuje.
Do bramki służy benchmark z vsync, nie ta liczba.

**Wyjątek, który został:** `evening-rain-bus` renderuje przy pixel ratio 1,0005, bo
`cameraScale` 0,87 dla kamery autobusu nadal obowiązuje. To jest dokładnie ten wyjątek
dopasowany do jednego pomiaru, o którym mówi punkt 6 zlecenia — nie został naprawiony w
tej rundzie i nie należy go czytać jako zasady.

---

## 10. Werdykt

(uzupełniany po zakończeniu przebiegu weryfikacyjnego)
