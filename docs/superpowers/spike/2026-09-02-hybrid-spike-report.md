# Raport ze spike'u hybrydy — Osiedle Centralne

Gałąź `worktree-spike-hybrid-osiedle-centralne`, **rewizja 2** z 2 września 2026.
Spike miał się skończyć renderami, pomiarami i **jedną rekomendacją**. Rekomendacja jest
w rozdziale 8.

**Rewizja 3.** Audyt wspólnej skali świata (rozdział 12): autobus kończył 3,569 m na podwoziu
8,18 m i to, nie perspektywa, czytało się jako „olbrzym obok zabawek"; naprawiony razem z
rowerem i stożkami świateł. Rewizja 2 dodała: zaostrzoną asercję TTI, trzy defekty, usunięcie
`GreedyVoxelStrategy` i wydzielenie Streetscape 2.0; rozdział 0 zawiera erratę do dwóch jej
błędnych twierdzeń.

**Nowa blokada, rozdział 13: hybryda nie trzyma 58 FPS w kadrze nocnym — 47–50 FPS w dziewięciu
z dziewięciu prób, przy 60,0 FPS produktu w tych samych dziewięciu.** Rewizja 2 raportowała
60 FPS wszędzie; było zmierzone, ale niestabilne. Werdykt z rozdziału 8 jest tym wstrzymany.
Gałąź nie jest zmergowana; czysty zestaw do merge'a jest do przygotowania (10.3).

Sprzęt i warunki wszystkich pomiarów: MacBook M1 Pro, systemowy Chrome przez Playwrighta,
ANGLE Metal, viewport 1440×900, `deviceScaleFactor` 1, seed symulacji 20260722, seed layoutu
20260610. Jeden świat na uruchomienie, jedna karta, blokada procesu.

Odtworzenie dowodów:

```bash
node_modules/.bin/vite build && node scripts/spikeSmoke.mjs                 # 12 kadrów hybrydy
SPIKE_WORLDS=voxel node scripts/spikeSmoke.mjs                              # 6 kadrów bazowych
SPIKE_PHASE=gate3 node scripts/spikeSmoke.mjs                               # bramka 3
node_modules/.bin/vitest run src/world/hybrid/clearance.test.ts             # bramka 4
```

Kadry nie są commitowane: katalog jest w `.gitignore` i odtwarza go pierwsze polecenie.
Zastrzeżenie o historii gałęzi — w 10.2. Pomiary są w repo: `spike-smoke.json`,
`spike-smoke-voxel.json`, `spike-semantics.json`, `bench-<świat>-<jakość>.json`.

Strona dla właściciela (ten sam werdykt, wizualnie, po polsku):
**https://claude.ai/code/artifact/77c565b1-517d-4e7d-b1b4-38e8873b2c9c**
Źródło strony leży w `verdict-page/page.html` z placeholderami `{{IMG_*}}`; wycinki kadrów
składa `verdict-page/crops.py`, a potem podstawia się je jako `data:` URI pod te placeholdery.

## 0. Errata rewizji 1 — dwie rzeczy podałem źle

Zanim cokolwiek innego. Rewizja 1 tego raportu zawierała dwa błędne twierdzenia, na których
oparłeś decyzje. Oba są tu wycofane.

**E1. `metalness` szkła to 0,7, nie 0,85.** Wziąłem tę liczbę z dokumentu planu
(`docs/superpowers/plans/2026-09-02-hybrid-spike.md`), a nie z kodu. W kodzie było
`M('glass', 0x3a5266, { roughness: 0.08, metalness: 0.7 })`. Dla porównania produkt daje
niezapalonemu oknu 0,08 / 0,65, a zapalonemu 0,18 / 0,40 — czyli hybryda była praktycznie
identyczna z niezapalonym oknem produktu, nie „fizycznie podejrzana" wobec niego.

**E2. Wniosek „metalness zjada czytelność zapalonych okien" był nieprawdziwy.** Zmierzyłem to
dopiero teraz, poprawnym narzędziem: przy nieruchomej kamerze ulicznej porównuję dwie chwile w
pasie porannym, między którymi zmienia się **tylko** aktywność kohort (t = 0,28 → 0,30, słońce
prawie nieruchome), i liczę piksele, które zmieniają luminancję o więcej niż 12.

| | piksele zmieniające się > 12 luma | średnia zmiana | maksimum |
|---|---|---|---|
| produkt (voxel) | 27 454 | 59,7 | 152 |
| hybryda, **przed** korektą materiału | 29 722 | 55,7 | 103 |
| hybryda, **po** korekcie materiału | 29 810 | 56,2 | 106 |

Kohorty hybrydy reagowały już wcześniej na **większej** liczbie pikseli niż produkt i z
porównywalną amplitudą. Korekta materiału zmieniła ten sygnał o mniej niż 1%. To, co widziałem
w kadrze golden i opisałem jako „ciemne okna o świcie", było w całości **pustym LOD 0** —
poziom 0 nie miał wtedy ani jednej szyby. Zasługa naprawy należy do defektu 1, nie do materiału.

Dlaczego pierwszy pomiar mnie zmylił: liczyłem średnią luminancję całego prostokąta elewacji,
w którym okna to kilka procent pikseli. Zmiana o 30 jednostek na 4% powierzchni daje 1,2
jednostki średniej — poniżej szumu. Obraz różnicowy pokazuje to od razu: zmieniają się
wyłącznie szyby, cała reszta jest czarna.

**Co z korektą materiału.** Została w połowie. Wyrównanie palety do niezapalonego okna produktu
(`metalness` 0,65) zostaje — jest darmowe i zgodne z produktem. Interpolację `roughness` i
`metalness` do zapalonego końca produktu (0,18 / 0,40) **usunąłem po pomiarze**: kosztowała
11 FPS w kadrze nocnym (60,0 → 49,1, p95 16,8 → 33,4 ms) przy zysku czytelności poniżej 1%.
Rozdzielenie szklistości od czytelności nie jest potrzebne, bo czytelność nigdy nie była zepsuta.

**E3. Nocna delta GPU +15,2 ms była artefaktem przyrządu.** Szczegóły w 3.5; prawdziwa delta to
+5,7 ms i nie jest widoczna dla użytkownika.

Poza tym rewizja 1 twierdziła, że 28 kadrów JPEG nie jest commitowanych, a wszystkie 28 leżały
w indeksie (wciągnął je `git add docs/superpowers/spike` w commicie `cc5fef8`). Teraz naprawdę
nie są: katalog jest w `.gitignore`, ale **blobów w historii gałęzi to nie usuwa** — patrz 10.2.

## 1. Co dodaliśmy w tej rundzie

Poprzedni agent zostawił kadry sprzed poprawki `4c10726`. Odnowione, plus trzy rzeczy,
bez których raport byłby zapewnieniem, a nie dowodem:

1. **Bazowe kadry produktu** (`SPIKE_WORLDS=voxel`). Te same cztery kadry bez podpinania
   fragmentu. Bez nich nie da się odróżnić regresji spike'u od cechy dzisiejszego produktu —
   i okazało się, że trzy rzeczy, które wyglądają na winę hybrydy, są w produkcie od dawna.
2. **TTI per kadr w benchmarku.** Dotychczasowe `readiness` mierzono na wejściu bez `?world=`,
   więc we wszystkich sześciu uruchomieniach raportowało TTI produktu, nigdy hybrydy. To był
   najważniejszy pomiar bramki 2 i był mierzony obok celu.
3. **`lodPixelsPerMetre` w metrykach hybrydy.** Bramka 3 sprawdza teraz miarę, która steruje
   LOD-em, nie tylko jej skutek.

## 2. Bramka 1 — kadry

Dwanaście kadrów hybrydy (2 strategie × {High: overview, street, golden, night-street} ×
{Low: street, overview}) i sześć bazowych. Wszystkie z zielonym `hybridGroundContact()`,
bez błędów w konsoli, w budżetach `renderer.info`.

| Kryterium | Wynik | Dowód |
|---|---|---|
| (a) prawdziwy street-eye ~1,7 m | **spełnione** | `STREET_EYE_SHOT.position[1] = 1.2`, `GROUND_SURFACE_Y = -0.5` → dokładnie **1,70 m** nad nawierzchnią. Liczba z kodu, nie z pikseli. |
| (b) autobus nie stoi na zebrze | **spełnione, z zapasem 6,40 m** | `busDwellEnvelope(BUS_STOPS[0])` = x[−17,80; −9,80], `CROSSWALK` = x[−3,40; −0,60] po przesunięciu (B1-5). Odstęp 6,40 m. Asercja `checkModel` zielona w każdym z 12 kadrów. |
| (c) mieszkaniec jest czytelny | **niespełnione — ale nie z winy spike'u** | Postać to pionowy pasek ~10 px zasłonięty własną ścianą reklamową wiaty. Identyczny pasek i identyczna zasłona są w kadrze bazowym `voxel-high-spike-street.jpg`. Naprawa jest po stronie kadru albo produktu, nie meshingu. Wydzielone jako Streetscape 2.0 (rozdział 11). |
| (d) witryny mają proceduralną treść | **nadal tylko w `hybrid-direct` na High** | Direct/High: trzy bryły towaru za szybą (zielona, różowa, beżowa). Direct/Low: szyba i ciemne wnętrze są teraz w warstwie 0, więc witryna czyta się jako oszklona wnęka pod markizą, ale **towar, pilastry i szyld to warstwa 2 i na Low ich nie ma**. Greedy/High: zamiast towaru gęsta ukośna kraciura z-fightingu. To jedyne kryterium bramki 1, które zostaje otwarte po naszej stronie. |
| (e) ekspozycja nie wypala dalszego planu | **kadr uliczny jest częściowo wypalony — identycznie jak produkt** | W pasie (491,440)–(1371,507) piksele z wszystkimi kanałami ≥250: voxel **6382**, direct **6355**, greedy **6357** z 58 960 (10,8%). Overview, golden i night są czyste. Spike tego nie powoduje i nie pogarsza. |

### 2.1 Co znaleźliśmy poza listą kryteriów

**B1-1 (direct) — na LOD 0 budynek był pustym pudełkiem. NAPRAWIONE.** Bryła to jedno
`E.box(b.tint, …, { layer: 0 })` plus cokół, a wszystkie otwory siedziały w warstwie ≥ 1, więc
każdy klaster spadający do poziomu 0 tracił wszystkie okna: w kadrze overview płyta bloku 3
stała jako gładka szara skrzynia obok voxelowych bloków, które na tej samej odległości nadal
mają pasy okien.

Pierwsza próba naprawy dorysowywała zapasową szybę **za** każdą prawdziwą. Zaostrzona bramka
TTI wyłapała skutek natychmiast: kadr nocny spadł z 60,0 do 49,1 FPS, p95 z 16,8 na 33,4 ms —
bo zapasowa szyba podwaja powierzchnię szkła, którą osiemnaście świateł lokalnych musi
cieniować. Powtórzone trzy razy przy niezmienionej bazie produktu.

Właściwa naprawa nie dodaje nic: **szyba przenosi się do warstwy 0**, bo szyba *jest*
uproszczonym rytmem, a uproszczeniem na poziomie 0 jest brak wszystkiego wokół szyby, nie brak
szyby. Warstwa 1 dokłada wnęki, parapety i nadproża, warstwa 2 ramy, szprosy i towar. Geometria
jest bit w bit taka jak przed zmianą (349 draw calli, 639 515 trójkątów w kadrze nocnym), a
warstwy przesunęły się bez zmiany sumy: [2938, 9158, 8640] → [3304, 8792, 8640]. Wyjątkiem jest
witryna: jej szkło jest przezroczyste, więc w warstwie 0 leży ciemne wnętrze za nim.

Pisanie testu do tego wyłapało jeszcze dwie niespójności: zapasowa szyba klatki schodowej wieży
i szyba witryny zapalałyby się, choć prawdziwe oszklenie tych dwóch nie ma kohorty. Test pilnuje
teraz, że kohorta jest ta sama na każdym poziomie, i że żadna powierzchnia jednej klasy nie jest
rysowana dwa razy w tym samym miejscu.

**B1-2 (greedy) — na LOD 0 przez ten sam budynek widać świat.** Mechanizm, dosłownie:

```js
// GreedyVoxelStrategy.ts, budowa maski
if (here === EMPTY || neighbour !== EMPTY) { mask[n] = EMPTY; maskAo[n] = 0; n++; continue; }
```

Ściankę emitujemy tylko wtedy, gdy sąsiednia komórka jest pusta — **bez patrzenia na warstwę** —
a potem `emitQuad` wkłada ją do bufora swojej warstwy. Gdziekolwiek komórka warstwy 1 (rama,
loggia, wykusz, balkon) styka się z komórką bryły, bryła nie emituje tam ścianki. Ukrycie
warstwy 1 zostawia dziurę. W kadrze overview przez blok 3 widać trawę i dalsze budynki.
Komentarz w tym samym pliku twierdzi, że „LOD layers stay additive" — reguła nadpisywania
faktycznie jest addytywna, ale kulling ścianek nie zna warstw, i to on łamie kontrakt.

**B1-3 (greedy) — dylatacja niszczy wszystko cieńsze niż 25 cm.** Licznik `dilated` = **2957**
wymiarów podniesionych do pełnej komórki (direct: 0). Widać to wprost: dwa rowery i stojak
zlewają się w nieczytelny stos klocków, w którym nie ma ani jednego okrągłego koła; pokrywa
kosza zwisa poza jego bok; balustrada balkonu staje się granatową płytą z dziurami; szprosy
okien puchną do pełnych słupków. Najgorszy przypadek to **pasy przejścia dla pieszych, które
z farby robią się bloki wysokości krawężnika** leżące w poprzek jezdni.

**B1-4 (greedy) — z-fighting tam, gdzie projekt polega na małym offsecie.** Szyba witryny
leży 1,5 cm przed ścianą, skrzydło drzwi 2 cm. Siatka 0,25 m sprowadza jedno i drugie do
płaszczyzny ściany, więc powierzchnie stają się współpłaszczyznowe. Efekt to regularna
kraciura na szybach, drzwiach i rolecie.

**B1-5 (model, obie strategie) — pasy zebry były obrócone o 90°. NAPRAWIONE.** Aleja Południowa to
`ROAD_RECTS[0]` = x[−64; 64] × z[22; 26], więc ruch idzie wzdłuż x. `CROSSWALK` =
x[−3,20; −1,80] × z[22; 26] jest poprawne: chodnik szerokości 1,4 m przez jezdnię szerokości
4 m. Ale `emitStreetscape` kładzie każdy pas jako `2.4 × 0.012 × 0.5` — **2,4 m wzdłuż jezdni
i 0,5 m w poprzek**, powtarzane w poprzek jezdni. Pasy biegły więc równolegle do ruchu,
układały się w drabinę przez jezdnię i wystawały 0,5 m poza chodnik z każdej strony.

Po poprawce pas biegnie w poprzek jezdni i powtarza się wzdłuż niej, a szerokość pasa i przerwy
jest jedna, wyliczana z prostokąta przejścia: `(maxX − minX) / (stripes · 2 − 1)`. Przejście
przeniosłem też z x[−3,20; −1,80] na **x[−3,40; −0,60]** — w lukę osiowej linii produktu, która
maluje `x mod 6 < 3` przy z = 24 (`WorldGenerator.isRoadMarking`), więc kreska nie leży już na
pasach. Zweryfikowane wyliczeniem: żaden malowany voxel osi nie zachodzi na przejście. Test
`emitters.test.ts` pilnuje orientacji (`bar.d > bar.w`), zawarcia w prostokącie i równych przerw.

**B1-6 (produkt, odziedziczone) — chodnik przy przystanku ma metr szerokości.**
`isOnSidewalk` zwraca prawdę tylko w promieniu 1 m od prostokąta drogi, więc wokół Alei
Południowej chodnikiem jest rząd z = 21 i rząd z = 27, i nic więcej. Wiata (z 27,5–28,5),
ławka (z 26,7–27,3) i wszystkie cztery pozycje oczekiwania (z 28,65) stoją na trawie — w
produkcie i w spike'u jednakowo. Dodatkowo listwy krawężnika w komórkach (−14…−10, 27)
przechodzą pod ścianą reklamową, ławką i słupkiem przystanku. Hybryda tego nie zepsuła i nie
mogła naprawić z wnętrza fragmentu: podniesiony chodnik trzeba zrobić razem z przesunięciem
obiektów, które produkt tam stawia.

## 3. Bramka 2 — pomiar apples-to-apples

Sześć uruchomień, sekwencyjnie, po jednym świecie. Progi: ≥ 58 FPS, p95 i p99 ≤ 20,5 ms,
≤ 1400 draw calli, ≤ 500 geometrii, ≤ 80 tekstur, TTI ≤ 1800 ms.

### 3.1 Klatka — z zapasem, wszędzie

| Świat | Jakość | FPS | p95 | p99 | hitch |
|---|---|---|---|---|---|
| voxel | high | 60,0 | 16,7–16,8 | 16,8 | 0 |
| hybrid-direct | high | 60,0 | 16,7–16,8 | 16,8 | 0 |
| hybrid-greedy | high | 60,0 | 16,7–16,8 | 16,8 | 0 |
| voxel / direct / greedy | low | 60,0 | 16,7–16,8 | 16,8 | 0 |

Wszystkie 24 przypadki (3 światy × 2 jakości × 4 kadry) trafiają w klatkę 16,8 ms bez ani
jednego hitcha. **Koszt klatkowy hybrydy jest nieodczuwalny.**

### 3.2 Sceny i pamięć — hybryda jest tańsza niż voxele, które zastępuje

| Kadr, High | Draw calle | Trójkąty całej klatki | Primary | Geometrie | Tekstury | Programy |
|---|---|---|---|---|---|---|
| voxel overview | 565 | 602 951 | 602 948 | 401 | 22 | 146 |
| direct overview | 604 | **575 889** (−4,5%) | 575 886 | 434 | 22 | 156 |
| greedy overview | 603 | **590 641** (−2,0%) | 590 638 | 433 | 22 | 156 |
| voxel street | 417 | 930 275 | 590 322 | 401 | 37 | 142 |
| direct street | 473 | 896 149 | 573 064 | 433 | 37 | 152 |
| greedy street | 473 | 903 575 | 580 608 | 432 | 37 | 152 |

Fragment hybrydy to ~20,7 tys. trójkątów (direct: 2938 / 9158 / 8640 na warstwach 0/1/2)
wobec ~576 tys. całej scenie. Zamiana pięciu bloków i chodników na geometrię architektoniczną
**oszczędza** 27 062 trójkąty w overview. Draw calle rosną o 39, geometrie o 33 — daleko od
limitów 1400 i 500. Tekstury bez zmian: napisy to jedyne `CanvasTexture`.

### 3.3 TTI — i tu greedy przegrywa

TTI mierzone **z podpiętym fragmentem**, per kadr (pole `timeToInteractiveMs` w każdym wyniku):

| Świat | High | Low | Próg | Wynik |
|---|---|---|---|---|
| voxel | 910–1096 ms | 708–1042 ms | 1800 ms | przechodzi |
| hybrid-direct | **1062–1179 ms** | 761–1245 ms | 1800 ms | przechodzi, zapas 555 ms |
| hybrid-greedy | **2061–2245 ms** | 1724–2166 ms | 1800 ms | **nie przechodzi w 7 z 8 kadrów** |

**Asercja jest zaostrzona.** Każdy wynik kadru jest teraz sprawdzany przeciw budżetowi w tym
samym świecie, w którym został zmierzony, i `hybrid-greedy` kończy się kodem 1 na obu jakościach.
Zgodnie z Twoją uwagą: bramka, która wykrywa przekroczenie i zwraca sukces, jest raportem, nie
bramką.

Przy zaostrzaniu wyszła druga wada tego samego miejsca: oczekiwanie na gotowość miało timeout
równy **dokładnie** budżetowi TTI, więc ładowanie marginalne rzucało `TimeoutError` i przerywało
uruchomienie **bez zapisania JSON-a**, na którym asercja mogłaby polec. Tak straciłem cztery
uruchomienia. Oczekiwanie jest teraz hojne (5 × budżet), a budżetu pilnuje asercja, która
potrzebuje istniejącego pomiaru, żeby na nim polec.

### 3.4 Generacja i pamięć GPU

| | Generacja fragmentu | `hybrid.bytes` | `dilated` |
|---|---|---|---|
| direct | **23–26 ms** | 2 985 984 B (2,99 MB) | 0 |
| greedy | **919–1033 ms** | 4 116 096 B (4,12 MB) | 2957 |

Greedy jest ~40× wolniejszy w generacji i zajmuje o 38% więcej pamięci GPU. Płaci tym za
voxelowe AO „za darmo" — którego direct nie potrzebuje, bo wypieka `aAo` na etapie emitera.

### 3.5 Nocny koszt GPU — wyjaśniony

Prosiłeś o wyjaśnienie. Zaczyna się od tego, że **przyrząd mierzył coś innego, niż nazwa
sugerowała**.

Zapytanie timera obejmowało `captureFrame`, które renderuje jedną klatkę kompozytora, a potem
kopiuje bufor ramki do canvasa 2D i **koduje go do JPEG-a**. Odczyt bufora i kodowanie
1440×900 leżały więc w mierzonym czasie GL. Dlatego kadr nocny raportował 43–61 ms dla klatki,
którą to samo uruchomienie mierzy na 16,8 ms — i to w **każdym** świecie, także w nietkniętym
produkcie. Dodałem hook `renderFrame()`, który renderuje i nic więcej, i zapytanie obejmuje
teraz tylko jego. Liczby spadły odpowiednio: voxel 43,6 → 34,5 ms, direct 61,1 → 40,2 ms.

Co delta **jest**, po poprawce przyrządu: produkt 34,5 ms, hybrid-direct 40,2 ms, czyli
**+5,7 ms** — nie +15,2 ms jak w rewizji 1.

Co delta **nie jest**, każde zmierzone osobno przełącznikami diagnostycznymi benchmarku:

| Hipoteza | Pomiar | Wniosek |
|---|---|---|
| światła lokalne (18 w kadrze nocnym) | 40,2 → 39,9 ms przy `BENCH_DISABLE_LOCAL_LIGHTS=1` | nie one |
| cienie | 40,2 → 39,9 ms przy `BENCH_DISABLE_SHADOWS=1` | nie one |
| selektywny bloom (hybryda wpisuje swoje `glow`) | 40,2 → 41,7 ms po wypisaniu | nie on |
| szum proceduralny materiału | 40,2 → 40,2 ms po zaślepieniu | nie on, **nocą** |

Te +5,7 ms zostają **nieprzypisane**. Nie są widoczne dla użytkownika: każdy świat, każda jakość
i każdy kadr trzyma 60,0 FPS przy p95 16,8 ms i zero hitchy. Reszta bezwzględnej wartości
(~34 ms dla klatki 16,8 ms) to nadal właściwość przyrządu — jedna wymuszona klatka poza pętlą
RAF, z `delta = 0`, nie korzysta z tego, co pętla amortyzuje między klatkami.

**Prawdziwe znalezisko GPU jest w dzień**, gdzie ten sam przyrząd jest miarodajny. Trzy oktawy
szumu wartościowego w materiale — **24 wywołania hasza na każdy nieprzezroczysty fragment** —
kosztują:

| Kadr | z szumem | z zaślepionym szumem | koszt szumu |
|---|---|---|---|
| overview | 16,5 ms | 5,2 ms | **11,3 ms** |
| street | 20,6 ms | 11,0 ms | **9,6 ms** |

To dominujący koszt GPU hybrydy i oczywisty cel optymalizacji: mniej oktaw, tańszy hasz albo
wypieczenie szumu do małej tekstury 3D. Nie ruszam tego w tej rundzie — to zmiana wyglądu, a
nie naprawa defektu.

`jsHeapBytes` waha się między 28 i 86 MB niezależnie od świata — to chwilowa próbka sterty
przed GC i nie nadaje się na wniosek. Nie wyciągam z niej żadnego.

### 3.6 Flake, żeby nikt nie gonił widma

W pierwszym przejściu dwa uruchomienia (`voxel-low` i `hybrid-direct-low`) padły na
`waitForFunction` z timeoutem 1800 ms — w tym samym czasie sześciu agentów czytało kadry.
Po powtórzeniu na cichej maszynie **wszystkie sześć wyszło zielone**. `voxel-low` pada na
pierwszym, bezświatowym wejściu, które nie ma nic wspólnego z hybrydą, więc to kontencja
maszyny, nie regresja.

## 4. Bramka 3 — LOD i semantyka

Automatyzacja: `SPIKE_PHASE=gate3 node scripts/spikeSmoke.mjs` → `spike-semantics.json`.

**Przełączenia LOD.** Kamera przejeżdża piętnaście pozycji od 300 m do 4 m. Dla każdego
klastra zapisujemy poziom **i** `lodPixelsPerMetre` — miarę, która nim steruje. Monotoniczność
sprawdzamy względem px/m, nie względem odległości przejazdu: przejazd zbliża się do fragmentu,
ale **oddala** od komina i wieży, więc po odległości przejazdu wieża „spadałaby" o poziom.
To był mój pierwszy, błędny wariant asercji; poprawiony test pilnuje właściwej osi.

Wynik, identyczny dla obu strategii (klastry w kolejności: bloki 3, 4, 5, 24, 25, streetscape,
komin, wieża):

```
00000000  00000001  00000012  11100112  11111112  11111112  12211212  22211212
22212211  22212211  22222211  22222211  22222211  22222211  22222211
```

Żaden klaster nie spada przy rosnącym px/m; żaden nie jest na 0 powyżej 12 px/m ani na 2
poniżej 25 px/m, co obejmuje udokumentowane progi 9/7 i 36/30.

**Histereza.** Kamera nieruchomo, 90 klatek: **0 zmian poziomu** w obu strategiach. Cooldown
0,25 s i podwójne progi robią swoje.

**Addytywność warstw.** Ta sama kamera, jakość ogranicza `maxLevel`:

| | trójkąty klatki na L1 | na L2 | warstwa 2 fragmentu |
|---|---|---|---|
| direct | 309 677 | 889 887 | 8640 na obu jakościach |
| greedy | 309 147 | 894 739 | 8314 na obu jakościach |

Warstwa 2 jest identyczna między jakościami; warstwy 0 i 1 kurczą się na Low tylko dlatego,
że dominanty przechodzą na warianty Low. **Ale dla greedy addytywność jest formalna, nie
faktyczna** — patrz B1-2: na LOD 0 bryła ma dziury. Dlatego bramkę 3 zdaje direct, a greedy
nie zdaje.

**Semantyka.** Każdy efekt mierzony względem własnej referencji, pobranej chwilę wcześniej w
tej samej sesji, na powierzchniach, których ma dotyczyć (motywy i kohorty na elewacjach, śnieg
i mokrość na nawierzchni). Suma odległości |Δluma|+|Δr|+|Δg|+|Δb|:

| Efekt | Powierzchnia | Δ | RGB przed → po |
|---|---|---|---|
| `applyTheme('retro')` | elewacje | 25,4 | 135/151/142 → 145/154/133 |
| `applyTheme('cyberpunk')` | elewacje | 225,9 | 135/151/142 → 88/71/113 |
| `debugSetSnowCover(1)` | nawierzchnia | 106,1 | 120/134/149 → 144/160/180 |
| `setWeather('rain')` | nawierzchnia | 102,8 | 120/134/149 → 124/167/190 |
| noc (t01 = 0,9) | elewacje | 57,1 | 135/151/142 → 125/137/121 |

Pierwsza wersja tego pomiaru była wadliwa: porównywałem wszystko z jedną referencją pobraną
przed zmianą czasu, a mokrość mierzyłem po 10 klatkach — a ona narasta sekundami, nie klatkami.
Wtedy deszcz wychodził na 0,2 i asercja przechodziła tylko dzięki nieświeżej bazie. Po
poprawce (referencja per efekt, 4 s na mokrość, druga ramka pomiarowa na jezdni) deszcz daje
102,8.

**Determinizm.** Dwa świeże wejścia z tym samym seedem dają identyczne `triangles`, `bytes`,
`dilated` i `lodLevels` — w obu strategiach.

### 4.1 Rozjazd semantyki, który trzeba zgłosić

Kohorty okien **liczą się identycznie** — hybryda woła `residentialWindowActivityAt`, tę samą
funkcję, z której korzysta `DayNightCycle`. Zmierzone o 06:43 (t01 = 0,28): aktywność
`[0,00; 0,03; 1,00; 1,00; 1,00]`, czyli trzy z pięciu kohort zapalone, a `emissiveIntensity`
voxelowych okien to 0,02, bo formuła to `activity × (0.02 + night × 1.23)` i `night` jest o tej
porze bliskie zeru. Hybryda używa tej samej formuły.

Rewizja 1 twierdziła dalej, że fragment czyta się o świcie jako niezamieszkany, i przypisywała
to `metalness` szkła. **To twierdzenie jest wycofane — patrz errata E1 i E2.** Wartość była
0,7, nie 0,85, a zmierzona odpowiedź kohort hybrydy była już wtedy na poziomie produktu
(29 722 piksele wobec 27 454 w produkcie, przy porównywalnej amplitudzie). Ciemny wygląd o
świcie brał się w całości z pustego LOD 0 (B1-1), naprawionego w tej rundzie.

Semantyka kohort jest zatem zgodna i była zgodna. Test `emitters.test.ts` pilnuje teraz
dodatkowo, że ta sama kohorta obowiązuje na każdym poziomie LOD — przy przenoszeniu szyb do
warstwy 0 wyłapał dwa oszklenia, które zapalałyby się na poziomie 0, a na wyższych nie.

## 5. Bramka 4 — wysokości i kolizje

Wysokości i działki pilnuje `CityModel.test.ts` bez zmian. Nowe:
`src/world/hybrid/clearance.test.ts`, dziewięć testów.

Test nie powtarza żadnego wysięgu z kodu architektury. Każda bryła przechodzi przez
`geometryFor` — dokładnie tę funkcję, którą strategia direct podaje rendererowi — a AABB
bierzemy z `computeBoundingBox()`. Wysokość pieszego też nie jest wpisana: mierzymy
`Box3.setFromObject(buildPassenger().group).max.y` = **1,9149 m** nad nawierzchnią.

Sprawdzane przeszkody: cztery pozycje oczekiwania, cztery pełne trasy dojścia
(`busStopWalkingPath`, 5 odcinków × 40 próbek), `busShelterColliders` (już rozdmuchane o
`PEDESTRIAN_RADIUS` = 0,32 m), `STATIC_PROP_FOOTPRINTS`, `POSTMAN_ROUTE_CURVE` (601 próbek),
`BUILDING_ACCESS_CELLS` oraz pełne sylwetki obu dominant w obu wariantach LOD.

**Test znalazł dwa prawdziwe błędy — oba naprawione:**

| Co | Zderzenie | Naprawa |
|---|---|---|
| donica `(1,6; 31,1)` | **0,80 m w środku stopni wejściowych** bloku 25 (0,8 × 0,4 × 0,14 m) plus 5 mm w podstawie witryny | przeniesiona na `(2,6; 30,3)` |
| tablica `(2,4; 31,25)` | **3 cm w szybie witryny na szerokości 0,78 m i wysokości 0,8 m** oraz w pilastrze wykuszu; elewacja i tak nosi własną tablicę przy drzwiach (`doorAt(..., board: true)`) | przeniesiona na `(3,4; 29,3)` |

Przesunięcie donicy prosto od ściany wstawiło ją w **korytarz dojścia do budynku**
(`BUILDING_ACCESS_CELLS`, komórka 1,30) — dlatego test sprawdza teraz i to. Potwierdziłem, że
ta asercja nie jest pusta: przy starym x = 1,6 wypada z komunikatem
`planter blocks access cell 1,30`.

Reszta jest czysta i była czysta: żaden wysięg w pasie ciała pieszego nie dotyka trasy,
wiaty, footprintu produktu ani trasy listonosza. Listonosz w ogóle nie wchodzi we fragment —
jego pętla to z ≈ −46…−50, fragment to z 0…40.

Skala tego, co test faktycznie mierzy: **1487 bryły wychodzą poza własną działkę**. Największe
wysięgi, zmierzone a nie przepisane z kodu:

| Element | Wysięg od lica | Pas wysokości nad nawierzchnią |
|---|---|---|
| zadaszenie wejścia (bloki 3 i 5) | **1,400 m** | 2,45–2,59 m |
| płyta loggii, parter (blok 3) | **1,300 m** | 0,00–0,16 m |
| ścianki boczne loggii, parter | **1,300 m** | 0,16–1,20 m |
| balustrada loggii | 1,285 m | 1,21–1,26 m |

Ścianki boczne loggii na parterze są jedynym wysięgiem, który sięga wprost w pas ciała
pieszego (0,16–1,20 m z 1,915 m). Test przechodzi, bo bloki 3 i 4 nie stoją przy żadnej
trasie pieszej ani footprincie produktu — ale przy następnym fragmencie to jest pierwsza
rzecz, która może się zderzyć, i test ją wyłapie.

Styk z ziemią: `hybridGroundContact()` zielony we wszystkich 12 kadrach, także po zmianach LOD.

## 6. Dominanty

| | Miejsce | Wysokość | Azymut z domyślnego overview | `validateDominantSite` |
|---|---|---|---|---|
| komin ciepłowni | (−58, −40) | 46 m | −136,8° | brak zastrzeżeń |
| wieża RTV — **rekomendowane A** | (16, −66) | 56 m | −110,3° | brak zastrzeżeń |
| wieża RTV — alternatywa B | (−70, 22) | — | −157,5° | brak zastrzeżeń |

Rozdział azymutów A i komina to 26,5°, obie sylwetki czytają się w overview i w golden osobno,
żadna nie jest ucinana przez kadr. Wariant Low wieży ma mniej niż połowę prymitywów wariantu
High i zachowuje co najmniej trzy czerwone światła lotnicze. Duet działa: pionowa, smukła
wieża po prawej i cięższy, pasiasty komin po lewej.

## 7. Paczka — nic nie podniesione

| Chunk | Rozmiar | Limit | Zapas |
|---|---|---|---|
| `index-*.js` | **238 662 B** | 240 000 B | 1 338 B |
| `main-*.js` | **33 311 B** | 50 000 B | 16 689 B |
| `hybrid-spike-*.js` | 34 111 B | — (dynamic import) | — |

Dodatek do chunku wejściowego względem stanu przekazania: +73 B (hook `renderFrame` dodał 39 B,
usunięcie greedy z flagi oddało 50 B). Chunk spike'u schudł o 17% po usunięciu greedy.
Żaden budżet nie został podniesiony.

## 8. Rekomendacja

**Kontynuujemy kierunek hybrydowy strategią bezpośrednią. `GreedyVoxelStrategy` została
usunięta** — po Twojej decyzji, w commicie `495ee68`; chunk spike'u spadł z 41 024 na 34 111 B.
Odzyskanie, gdyby decyzja miała kiedyś wrócić:
`git show 7f91e35 -- src/world/hybrid/strategies/GreedyVoxelStrategy.ts`.

Poniższe porównanie jest zapisem tego, co uzasadniło usunięcie; liczby greedy pochodzą z
pomiarów sprzed commita `495ee68`.

Za direct:

- mieści się we wszystkich progach bramki 2, w tym w **zaostrzonym** TTI, z zapasem 555 ms;
- generuje fragment w 24–28 ms, czyli poniżej dwóch klatek;
- oszczędza 26 942 trójkąty względem voxeli, które zastępuje (576 009 wobec 602 951 w overview);
- dotrzymuje kontraktu warstw: bryła jest zamknięta na każdym poziomie, a szyba jest w warstwie 0,
  więc poziom 0 czyta się jako budynek z oknami;
- daje czytelne rowery, balustrady, szprosy i towar w witrynie — dokładnie to, za co
  zatwierdzono ten kierunek.

Przeciw greedy — każdy punkt osobno wystarczy:

- **przekracza budżet TTI** (1724–2245 ms wobec 1800) w siedmiu z ośmiu kadrów, i od teraz
  benchmark się na tym wywala;
- **łamie kontrakt LOD**: na poziomie 0 przez budynek widać świat, i to nie jest do
  poprawienia bez przepisania kullingu ścianek na świadomy warstw;
- **niszczy wszystko cieńsze niż 25 cm**: 2957 zdylatowanych wymiarów, rowery jako stos
  klocków, pasy zebry jako bloki na jezdni;
- **z-fightuje** na każdej płaszczyźnie opartej o mały offset (szyby, drzwi, rolety);
- ~40× dłuższa generacja i +38% pamięci GPU;
- jedyna korzyść — voxelowe AO — jest już dostępna w direct jako wypiekany atrybut `aAo`.

### 8.1 Trzy defekty po naszej stronie — zrobione w tej rundzie

1. **LOD 0 zachowuje rytm okien.** Szyba przeniesiona do warstwy 0; geometria bit w bit jak
   przedtem. Pierwsza próba (zapasowa szyba za prawdziwą) kosztowała 11 FPS nocą i została
   odrzucona przez pomiar, nie przez opinię. (B1-1)
2. **Zebra obrócona i przycięta**, plus przeniesiona w lukę osiowej linii produktu. (B1-5)
3. **Materiał szkła wyrównany do produktu** (`metalness` 0,65 = niezapalone okno produktu).
   Interpolacja do zapalonego końca usunięta po pomiarze: −11 FPS nocą, < 1% zysku. (errata E2)

Zostaje po naszej stronie jedno, mniejsze: **towar w witrynie to warstwa 2, więc na Low go nie
ma** (kryterium d). Do rozstrzygnięcia razem z pytaniem, czy Low ma w ogóle pokazywać treść
witryn.

I jedno techniczne, wskazane pomiarem: **szum proceduralny materiału kosztuje 9,6–11,3 ms GPU
w kadrach dziennych** (3.5). To dominujący koszt GPU hybrydy i najlepszy cel optymalizacji.

### 8.2 Streetscape 2.0 — wydzielone, nie porzucone

Trzy rzeczy odziedziczone z produktu, które spike wyciągnął na wierzch, nie są błędem strategii
direct, ale uderzają dokładnie w cel „zamieszkanego miasta". Zgodnie z Twoją decyzją idą jako
osobna naprawa **Streetscape 2.0**, przed drugim fragmentem — zakres w rozdziale 11.

## 9. Czego świadomie nie zrobiliśmy

Fragmentu nie rozszerzaliśmy. Drzew, kiosku i wiaty w nowym języku nie dodawaliśmy — w kadrach
widać, że zostały voxelowe, i to było w zakresie. Mrugania świateł ani transmisji wieży nie
implementowaliśmy. Budżetów nie podnieśliśmy. `Checkpoints.ts` i `WorldLayout.ts` nietknięte.
Szumu proceduralnego nie optymalizowaliśmy, choć pomiar wskazał go jako główny koszt GPU (3.5) —
to zmiana wyglądu, nie naprawa defektu. Towaru w witrynie nie przenieśliśmy do niższej warstwy,
więc na Low go nie ma (kryterium d). Streetscape 2.0 jest opisany, nie zrobiony (11). Czystego
zestawu do merge'a nie przygotowaliśmy (10.3).

Po Twojej decyzji **zaostrzyliśmy** asercję TTI (3.3) i **usunęliśmy** przegraną strategię
(commit `495ee68`); rewizja 1 mówiła, że nie zrobimy ani jednego, ani drugiego bez Twojego słowa.
## 10. Higiena gałęzi

### 10.1 Stan drzewa

`git status` jest teraz naprawdę pusty. Wcześniej pokazywał nieśledzony `node_modules` —
w linkowanym worktree to symlink, a `.gitignore` ma wzorzec `node_modules/`, który dopasowuje
wyłącznie katalog. Dopisałem `node_modules` do `.git/info/exclude` wspólnego katalogu Gita, czyli
lokalnie i bez commita, żeby nie ruszać pliku produktu na gałęzi eksperymentu. Rewizja 1
nazywała to drzewo czystym, choć nie było — to była nieścisłość, nie tylko drobiazg.

### 10.2 Dwadzieścia osiem JPEG-ów

Katalog `docs/superpowers/spike/frames/` jest wypisany z indeksu i dopisany do `.gitignore`,
więc **na czubku gałęzi nie ma już żadnego kadru**. To przywraca konwencję, którą raport opisywał,
a której commit `cc5fef8` nie dotrzymał.

Czego to **nie** robi: 3,9 MB blobów zostaje w historii gałęzi, w `cc5fef8`. Wypisanie z indeksu
nie usuwa obiektów. Do rozstrzygnięcia razem z punktem 5 Twojej kolejności:

| Opcja | Co daje | Co kosztuje |
|---|---|---|
| zostawić historię jak jest | zero pracy, pełny ślad audytowy | 3,9 MB binariów wchodzi do `main` przy jakimkolwiek merge'u gałęzi |
| przebudować gałąź bez blobów | `main` dostaje tylko kod i pomiary | historia gałęzi zmienia hasze; ślad audytowy trzeba odtworzyć w raporcie |
| zachować wybrane dowody | 4–6 kadrów, na które raport wskazuje wprost, ~0,5 MB | trzeba wybrać i uzasadnić wybór |

**Moja rekomendacja: przebudować.** Punkt 5 Twojej kolejności i tak wymaga świeżego,
direct-only zestawu do merge'a, a ten zestaw naturalnie powstaje jako nowa gałąź z `main` —
wtedy bloby po prostu nigdy do niej nie wchodzą. Dowody wizualne żyją na stronie werdyktu
(wycinki wbudowane jako `data:` URI) i odtwarza je `scripts/spikeSmoke.mjs`; historia Gita nie
jest na nie właściwym miejscem.

### 10.3 Czego jeszcze nie ma

Punkt 5 — czysty, direct-only zestaw do merge'a — **nie jest zrobiony**. Gałąź ma teraz 24
commity nad `main`, w tym całą narrację spike'u: dwie strategie, ich porównanie, usunięcie
przegranej, dwie moje pomyłki i ich korekty. To dobry zapis pracy i zły materiał do merge'a.
Zestaw do merge'a to osobne zadanie i osobna decyzja o kształcie: jeden squash, kilka
tematycznych commitów, czy nowa gałąź z `main` z przeniesionym kodem.

## 11. Streetscape 2.0 — zakres

Zgodnie z Twoją decyzją: nie zostawiamy tego, ale wydzielamy. To nie jest błąd strategii direct —
wszystkie pięć punktów widać identycznie w kadrach bazowych produktu. Uderzają natomiast prosto
w cel „zamieszkanego miasta": wiata, ławka i pasażerowie stojący na trawie psują wiarygodność
dokładnie tam, gdzie próbujemy ją zbudować.

Do zrobienia przed drugim fragmentem, z liczbami, które już mamy:

1. **Poszerzyć chodnik.** `isOnSidewalk` zwraca prawdę tylko w promieniu 1 m od prostokąta drogi,
   więc wokół Alei Południowej chodnikiem jest rząd z = 21 i rząd z = 27, i nic więcej. To
   funkcja produktu, nie fragmentu — zmiana dotknie całego miasta i trzeba ją przemierzyć
   testami `WorldLayout.test.ts` (kolizje, trasy, anchory) i budżetem świateł.
2. **Przenieść wiatę, ławkę i pozycje oczekiwania.** Dziś: wiata z 27,5–28,5, ławka z 26,7–27,3,
   cztery pozycje oczekiwania na z = 28,65 — wszystkie poza chodnikiem. Po poszerzeniu chodnika
   trzeba je posadzić na nim, a `busStopWaitingPositions` i `busShelterColliders` przeliczyć.
3. **Odsłonić pasażera.** Postać to pionowy pasek ~10 px, zasłonięty w dwóch trzecich ścianą
   reklamową własnej wiaty (`localRect(stop, 'poster-wall', -2, 0.5, 0.1, 0.9, …)`). Albo ściana
   idzie na drugi koniec wiaty, albo kadr uliczny przesuwa się ~2 m w lewo. Dopóki to trwa,
   kryterium (c) bramki 1 zostaje niespełnione.
4. **Poprawić przejście i krawężniki.** Przejście jest już obrócone i wpasowane w lukę osi
   (B1-5), ale listwy krawężnika w komórkach (−14…−10, 27) przechodzą pod ścianą reklamową,
   ławką i słupkiem przystanku. Przy podniesionym chodniku krawężnik przestanie być listwą
   0,12 m i trzeba będzie zdecydować, co robi z obiektami, które produkt tam stawia.
5. **Sprawdzić nocne bryły świateł.** Duże przezroczyste stożki wokół latarni są w kadrze
   bazowym produktu tak samo jak w hybrydzie, ale w kadrze ulicznym zalewają całe przejście.
   To osobna sprawa od kosztu GPU (3.5): tam chodziło o milisekundy, tu o czytelność obrazu.

Czego Streetscape 2.0 **nie** obejmuje: drzew, kiosku i wiaty w nowym języku — one zostają
voxelowe i były celowo poza zakresem spike'u.

## 12. Wspólna skala świata — audyt i naprawa

### 12.1 Werdykt

Autobus był za wysoki, rower za cienki, a jedno i drugie mierzyłem dotąd z argumentów
konstruktora, nie z gotowej geometrii. Po naprawie autobus, człowiek i rower należą do jednej
rodziny wielkości; przy przystanku nadal stoją na trawie, i to zostaje otwarte.

**Kluczowa liczba:** autobus jest budowany z `BUS_HEIGHT = 2.6`, a kończył **3,569 m** wysokości
na podwoziu 8,181 m — stosunek wysokości do długości **0,44**, gdzie autobus tej długości ma
około 0,33. Nominalne parametry i wynik nie zgadzały się o 37%.

### 12.2 Geometria czy perspektywa

Najpierw rozdzieliłem jedno od drugiego, bo „wielki autobus, mikroskopijne rowerki" mogło być
efektem obiektywu. Rzut ośmiu wierzchołków bryły otaczającej na ekran, kamera uliczna produktu:

| Pole widzenia | autobus (16,6 m) | rower (12,5 m) | pasażer (20,0 m) |
|---|---|---|---|
| **50°, kamera produktu** | **300 px** | **98 px** | 96 px |
| 40° | 384 px | 126 px | 123 px |
| 35° | 444 px | 145 px | 142 px |

Zwężenie obiektywu powiększa **wszystko tym samym współczynnikiem** (×1,28 i ×1,48) — proporcje
wzajemne nie drgnęły. Do tego autobus stoi **dalej** niż rowery (16,6 m wobec 12,5 m), więc
perspektywa działa przeciw niemu, a nie na jego korzyść. Wniosek: to była geometria. Autobusu nie
zmniejszyłem dlatego, że jest blisko — zmniejszyłem, bo miał złe proporcje własne.

### 12.3 Zmierzone wymiary

Wszystko poniżej to bryły otaczające **gotowej geometrii** w przestrzeni świata — po skalowaniu,
obrocie i osadzeniu — a nie parametry konstruktorów. Mierzy to
`src/world/hybrid/proportions.test.ts`.

| Obiekt | Zmierzone (szer. × wys. × dł.) | Zakres wiarygodny | Ocena |
|---|---|---|---|
| pasażer (skala 0,78) | 0,874 × **1,915** × 0,429 | 1,65–1,90 | +1% ponad; to figura odniesienia produktu |
| **autobus, przed** | 2,453 × **3,569** × 8,181 | h/l ≈ 0,33 | **h/l 0,44** |
| **autobus, po** | 2,45 × **2,95** × 8,18 | | **h/l 0,36** ✓ |
| koło autobusu | średnica 0,90, os na 0,45 | ~1,0 | ✓ |
| **stożek świateł, przed** | 2,20 × 2,99 × **8,18** | — | **8-metrowy klin** |
| **stożek świateł, po** | 0,84 × 0,50 × **2,40** | — | ✓ |
| **rower, przed** | 1,32 × **1,00** × 1,84 | dł. 1,7–1,9 | długość ✓, rurki 4 cm |
| **rower, po** | 1,32 × **1,08** × 1,84 | | ✓, rurki 5,5 cm |
| koło roweru | średnica **0,740** | 0,65–0,75 | ✓ |
| kierownica | 0,97 → **1,08** | 0,95–1,15 | ✓ |
| stojak rowerowy | 1,14 × 0,90 × 1,01 | — | ✓ |
| kosz | 0,56 × 0,96 × 0,56 | — | ✓ |
| drzwi wejściowe | 1,30 × **2,20** | 2,0–2,2 | ✓ |
| witryna (szyba) | 2,15 × 2,30 | — | ✓ |
| okno, płyta / kamienica / punktowiec | 1,50×1,40 / 1,05×1,85 / 1,40×1,30 | — | ✓ |
| kondygnacja, płyta i punktowiec | **2,80** | 2,7–3,3 | ✓ |
| parter kamienicy | **3,70** | 3,3–4,0 | ✓ |
| kondygnacja kamienicy | **3,30** | 2,7–3,3 | ✓ |
| słupek balustrady | **1,00** | 0,9–1,1 | ✓ |
| ławka | 2,80 × 1,20 × 0,58, siedzisko 0,48 | — | ✓ |
| krawężnik | 0,22 × **0,12** × 1,00 | 0,10–0,16 | ✓ |
| jezdnia Alei Południowej | **4,00 m** na dwa kierunki | — | wąska, ale to produkt |
| przejście dla pieszych | **2,80 m** szerokie, pasy 3,70 m | nie symboliczne | ✓ |
| chodnik przy przystanku | **2 komórki (2 m)** | ma pozwalać minąć wiatę | **nadal za wąski** |
| pozycje oczekiwania na chodniku | **nie — wszystkie cztery na trawie** | — | **otwarte** |

Relacje, których pilnuje test:

| Relacja | Przed | Po | Odniesienie |
|---|---|---|---|
| autobus / pasażer | 1,86 | **1,54** | ~1,66 |
| autobus / rower | 3,57 | **2,73** | ~2,64 |
| pasażer / rower | 1,92 | **1,77** | ~1,6 |
| wysokość / długość autobusu | 0,44 | **0,36** | ~0,33 |

### 12.4 Co zmieniłem

**Autobus** (`src/world/Bus.ts`, geometria produktu, więc widać ją też w domyślnym świecie):
korpus 2,32 na cokole 0,45 plus czapa dachu daje 2,95 m; dolna połowa każdej opony czyta się pod
nadwoziem; doszły nadkola, żeby opony nie były przyklejone do płaskiego boku, i tylna szyba,
żeby przód różnił się od tyłu z każdej strony.

**Rower** (`src/world/hybrid/streetscape.ts`): wymiary były już dobre — koła 0,74 m, rozstaw osi
1,10 m, długość 1,84 m — ale każda rurka miała 4 cm, a opona była obręczą 3 cm, czyli dwa–trzy
piksele w kamerze ulicznej. **To cienkość, nie skala, czytała się jako zabawka.** Rurki mają
5,5 cm, opona 4,5 cm z obręczą wewnątrz, kierownica na 1,08 m, doszła dolna rura, mostek,
korba i bagażnik.

**Stożki świateł**: były `ConeGeometry(1.1, 8, 12)` na lampę, additive i dwustronne — twardy,
dwunastokątny klin przez cały nocny kadr. To były **te same bryły, które w rewizji 2 przypisałem
latarniom ulicznym**; przypisanie było błędne, choć wniosek „są też w produkcie" słuszny, bo
autobus jest obiektem produktu. Teraz 0,42 × 2,4 m, dwadzieścia segmentów, jednostronne.

### 12.5 Test, który się wywraca

`proportions.test.ts` mierzy gotowe bryły i relacje między nimi. Po przywróceniu starego
autobusu i starego roweru **wywalają się cztery z dziewięciu przypadków**: proporcje autobusu,
długość stożka świateł, rower i rodzina wielkości. Sprawdzone przez faktyczne przywrócenie
starych wartości, nie przez rozumowanie.

Test złapał też dwie moje własne pomyłki, zanim je zapisałem jako wynik: pierwsza wersja
pomiaru balustrady szukała płyty pod poręczą przez sąsiedztwo i trafiała raz w dolną poprzeczkę
(0,52 m), raz w parapet okna (1,56 m), dla balustrady, która ma 1,00 m. Ostateczna wersja mierzy
wysokość samych słupków, bez szukania punktu odniesienia.

## 13. BLOKADA: hybryda nie trzyma 58 FPS w kadrze nocnym

To najważniejsza rzecz w tej rewizji i zmienia werdykt z rozdziału 8.

Dziewięć izolowanych uruchomień, światy przeplatane, żeby ewentualny dryf maszyny obciążał oba
jednakowo, jedna karta, nic innego na GPU:

| Świat | FPS | p95 | p99 | max | hitch | klatki > 20,5 ms | sonda GPU |
|---|---|---|---|---|---|---|---|
| **voxel** | **60,0** (9/9) | 16,7 | 16,8 | 16,8 | 0 | **0,0%** | 34,7–44,3 ms |
| **hybrid-direct** | **47,4–49,7** (9/9) | **33,4** | **33,4** | 33,5 | 0 | **20,8–26,6%** | 56,1–59,1 ms |

p95 = 33,4 ms to dokładnie dwa okresy odświeżania: hybryda **gubi vsync na co czwartej–piątej
klatce nocnej**. Progi produktu to ≥ 58 FPS i p95 ≤ 20,5 ms — oba niespełnione, przy spełnionych
w tym samym kadrze przez sam produkt.

**Rewizja 2 twierdziła, że każdy świat trzyma 60,0 FPS przy p95 16,8 ms. To było zmierzone, ale
nie jest stabilne.** Ten sam build dawał 60,0 wcześniej w sesji i 47–50 w dziewięciu kolejnych
próbach później. Sonda GPU produktu rosła przez sesję z 31 do 44 ms przy niezmienionym kodzie,
więc maszyna się nagrzewała; produkt ma zapas i tego nie odczuł, hybryda przy 57 ms zapasu nie
ma i spada poniżej progu. Wniosek, który trzeba zapisać wprost: **hybryda nocą stoi na granicy
vsync, a rewizja 2 raportowała szczęśliwą stronę rozkładu dwumodalnego jako wynik.**

### Co zostało wyeliminowane pomiarem

| Hipoteza | Pomiar | Wniosek |
|---|---|---|
| światła lokalne (18 nocą) | 40,2 → 39,9 ms przy `BENCH_DISABLE_LOCAL_LIGHTS=1` | nie one |
| cienie | 40,2 → 39,9 ms przy `BENCH_DISABLE_SHADOWS=1` (globalne wyłączenie, asercja potwierdza) | nie one |
| selektywny bloom | 40,2 → 41,7 ms po wypisaniu `glow` hybrydy | nie on |
| szum proceduralny materiału | 40,2 → 40,2 ms po zaślepieniu | nie on **nocą** (w dzień kosztuje 9,6–11,3 ms) |
| stożki świateł autobusu | kontrolowane A/B: 39,3 → 38,5 ms nocą | nie one nocą (w dzień 4,3 ms w produkcie) |
| piksele fragmentu | **kamera odwrócona o 180°, fragment poza kadrem: delta utrzymuje się, +5,6 ms** | **nie piksele** |
| obręcze kół roweru (nowe) | usunięte → 50,0 FPS, bez zmiany | nie one |

Ostatni wiersz jest najważniejszy: przy kamerze odwróconej tyłem do fragmentu hybryda nadal
kosztuje o tyle samo więcej (30,2 wobec 24,1 ms w produkcie), a mimo braku fragmentu w kadrze
wciąż wystawia **+15 draw calli** (294 wobec 279). To znaczy, że koszt jest **stały na klatkę**
i wynika z samego podpięcia fragmentu do scen, nie z jego pikseli: bryły otaczające scalonych
meshy klastrów są duże (promień klastra streetscape to 32 m), więc nie są odcinane frustumem i
przechodzą przez wszystkie passy kompozytora.

### Co z tym zrobić

Nie rozszerzam fragmentu. Zgodnie z Twoim polecieniem wskazuję blokadę.

Najbliższy trop, jeszcze niesprawdzony: **odcinanie frustumem scalonych meshy**. Każdy klaster
jest jednym meshem z jedną bryłą otaczającą; przy promieniu 32 m dla streetscape'u i wysokich
punktowcach żaden nie wypada z frustuma prawie nigdy, a passów jest kilka. Do sprawdzenia w tej
kolejności:

1. policzyć, ile draw calli i trójkątów fragment wystawia w passie głównym i w passie normalnych
   SSAO osobno, przy kamerze skierowanej na fragment i odwróconej;
2. podzielić klastry na mniejsze meshe albo zawęzić bryły otaczające i zmierzyć ponownie;
3. sprawdzić, czy `glassClear` (przezroczysty, `depthWrite: false`) nie trafia do passu, w którym
   nie powinien się znaleźć — hybryda dodaje 12 programów szaderów wobec produktu;
4. dopiero potem wracać do rozszerzania świata.

Do czasu rozstrzygnięcia werdykt z rozdziału 8 brzmi: **wstrzymane blokadą**, nie „gotowe do
przygotowania merge'a".
