# Changelog

Wszystkie istotne zmiany projektu są dokumentowane w tym pliku. Projekt nie ma
jeszcze publicznych tagów wydań, dlatego prace po wersji początkowej pozostają
w sekcji `Unreleased` i są powiązane z rzeczywistymi commitami.

Format jest oparty na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
a wersjonowanie projektu docelowo stosuje [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Tęcza po deszczu oparta na optyce geometrycznej jako pojedynczy efekt
  postprocessingu: obserwatorowa oś antysłoneczna, dyspersja Snella 400–700 nm,
  D65/CIE/Fresnel, histogram rodzin promieni pierwszego i drugiego rzędu
  wypiekany do proceduralnego LUT, lokalne kurtyny wilgoci po opadzie oraz
  przycinanie drogi optycznej do bufora głębokości i gruntu.
- Deterministyczne checkpointy tęczy OFF/ON, bramka browser smoke sprawdzająca
  chromatyczność, zasięg i ciągłość łuku, testy optyki i wilgoci oraz
  pięciokrotny benchmark AB/BA z limitami p95, CPU, timera GPU i zasobów.
- High-only słaba tęcza wtórna i pas Aleksandra wynikający z przerwy między
  rodzinami promieni, bez sztucznego kątowego przyciemniania tła; Low/Medium
  pomijają w shaderze odczyt i wkład wtórnego łuku.
- Osobny deterministyczny strumień RNG wybiera po każdym opadzie naturalną
  kurtynę wilgoci nad jeziorem, łąką albo północnym parkiem. Pozorny początek
  i koniec łuku wynikają z kamery, Słońca, objętości kropel oraz głębokości
  sceny, a nie z zapisanych punktów świata.
- Wilgoć optyczna została oddzielona od mokrości nawierzchni. Kurtyna zachowuje
  tłumienie Beer–Lamberta również po zasłonięciu Słońca, nie raportując wtedy
  kolorowej tęczy, i otrzymała szybką ścieżkę shadera bez obliczeń widmowych.
- Minimalne `ExperienceDirector`, `CameraDirector` i współdzielony,
  bezalokacyjny `FrameContext`; `main.ts` pozostaje composition rootem zamiast
  zmieniać się w nowy framework dla samego refaktoru.
- Jawny seed symulacji, oddzielny seed statycznego layoutu, niezależne strumienie
  RNG oraz 12 wersjonowanych checkpointów narracyjnych i benchmarkowych.
- Testy deterministycznego startu, kontraktu checkpointów, sekwencji touru oraz
  przejmowania kamery pierwszym gestem użytkownika.
- Siedmiorozdziałowy filmowy tour pokazujący kolejno pociąg, autobus, jezioro,
  mieszkańców, golden hour, totalność i Cyberpunk.
- `EclipseTimeline` z deterministycznymi kontaktami C1-C4, dokładnym polem
  przecięcia tarcz, irradiancją, totalnością, koroną i perłami Baily'ego.
- Proceduralny `EclipseVisual`: widoczne z dalekiej kamery Słońce i Księżyc,
  korona z promieniami, chromosfera, pierścień diamentowy i gwiazdy bez
  zewnętrznych modeli ani tekstur.
- Sterowanie `E` i przycisk „Zaćmienie”, szerokie kadrowanie zjawiska oraz HUD
  z fazą, pokryciem, paskiem postępu i komunikatem bezpieczeństwa.
- Reakcje mew na zaćmienie: od 85% pokrycia dolatują do najbliższych dachów,
  pozostają tam przez totalność i startują po spadku pokrycia do 65%.
- Proceduralne protuberancje, projekcje sierpów pod drzewami, High-only shadow
  bands przy kontakcie oraz odbicie korony na jeziorze.
- Reakcje mieszkańców i psa na pokrycie Słońca: spowolnienie miasta, patrzenie
  w górę, okulary zaćmieniowe i karty do bezpiecznej projekcji obrazu Słońca.
- Testowalny `CityRhythm` sterujący ostatnią pętlą autobusu, nocną przerwą,
  porannym rozwożeniem pasażerów i sekwencjami świateł mieszkań.
- Pięć deterministycznych grup okien mieszkalnych, które gasną etapami od
  północy do 02:45 i zapalają się ponownie od 04:00.
- `StationNavigation` z koliderami oraz wielopunktowymi trasami pasażerów na
  dworcach kolejowych.
- Nocne oświetlenie dworców, oprawy pod dachami wiat i dwustronne lightboxy
  plakatowe osadzone poza ścianami przystanków.
- Rozszerzone API diagnostyczne `window.__diorama` dla rytmu okien, stanu usługi
  autobusowej, pasażerów stacji i testów aktorów.
- Testy regresji dla rytmu miasta, autobusu, płynnych przejść środowiska,
  nawigacji stacji i pozy wędkarza.

### Changed

- `CameraDirector` jest jedynym produkcyjnym właścicielem automatycznych ujęć;
  `pointerdown`, dotyk i kółko przerywają tour, kamery pojazdów, panoramę lub
  kadr zaćmienia w fazie capture, nie połykając pierwszego gestu.
- Warm-up renderera nie przesuwa zegara symulacji ani strumieni losowych, a
  debug API ładuje checkpoint przez świeże uruchomienie z zachowaniem seeda.
- Tour korzysta z jednego zestawu definicji kadrów i ustawia deterministyczne
  pozycje pociągu oraz autobusu na wejściu do odpowiednich rozdziałów.
- Usunięto relikty nazewnictwa dylatacji czasu z aktywnego produktu: panel
  sterowania ma neutralne selektory, a grading filmowy znajduje się w
  `CinematicGrade.ts`.
- Pętla animacji korzysta z `THREE.Timer` połączonego z Page Visibility API,
  renderer używa wspieranego `PCFShadowMap`, a dokument deklaruje język polski.
- Zaćmienie trwa 96 sekund, zatrzymuje symulowaną pozycję Słońca, ale nie życie
  miasta, i płynnie steruje niebem, ekspozycją, światłami oraz widocznością
  gwiazd. Swobodna kamera nadal może przerwać automatyczne kadrowanie.
- Wbudowana tarcza Słońca z shadera nieba jest ukrywana podczas zaćmienia, aby
  na scenie nie pojawiały się dwa Słońca.
- Wszystkie fazy dnia i nocy przechodzą płynnie; bezpośrednie słońce, ambient,
  księżyc i ekspozycja nie zmieniają się już skokowo.
- Neutralna mapa PMREM jest generowana raz podczas preloadu; ciągłe zmiany
  nieba, świateł, pogody i mokrości nie wywołują kosztownych regeneracji GPU.
- Preloader ma deterministyczny, monotoniczny pasek `0–100%` zamiast animacji
  udającej ładowanie. Raportuje rzeczywiste etapy budowy świata, aktorów,
  pogody, kompilacji wariantów dnia, golden hour, nocy i totalności, ukrytych
  klatek composera oraz synchronizacji kolejki GPU przed sygnałem gotowości.
- Autobus wykonuje o 23:30 ostatnią pętlę zbierając pasażerów, znika po kursie
  i wraca o 04:50, kolejno wysadzając ludzi na przystankach.
- Nocny kurs autobusu porusza się szybciej na pustych ulicach, aby pełna pętla
  mieściła się w skompresowanym czasie dobowym dioramy.
- Wędkarz korzysta z osobnej pozy siedzącej, dopasowanego stołka i skrzynki;
  zgięte nogi nie przecinają siedziska ani podłoża.
- Profile jakości otrzymały osobny budżet dynamicznych świateł dworcowych.
- Listonosz ma dedykowany, nieprzezroczysty model w niebieskim uniformie z
  czapką, odznaką i torbą na ramieniu zamiast losowego stroju pasażera.

### Fixed

- HMR anuluje własny `requestAnimationFrame`, dzięki czemu nie zostawia drugiej
  pętli renderującej. Zakończenie i przerwanie touru sprząta blokady zegara,
  pogodę, totalność i stan kamery w jednym miejscu.
- Checkpoint Cyberpunk ustawia docelowy morph przed zamrożeniem, a kadr
  totalności jest wyliczony względem rzeczywistego kierunku Słońca.
- Zwinięty panel `TRANS CITY EXPRESS` zachowuje szerokość wersji rozwiniętej
  i nie nachodzi na centralny status zaćmienia.
- Pasażerowie autobusowi i kolejowi nie przenikają przez wiaty, ławki, słupy,
  barierki ani bryły stacji.
- Plakaty nie są zatopione w voxelowych ścianach przystanków.
- Autobus wykrywa minięcie punktu postoju pomiędzy klatkami i nie pomija
  przystanku przy większej prędkości lub spadku FPS.
- Wędkarz nie lewituje nad lodem i nie przenika nogami przez stołek.
- PMREM oraz przejścia oświetlenia nie powodują krótkiego, nienaturalnego
  przyciemniania i rozjaśniania sceny.
- Okulary zaćmieniowe dziedziczą macierz głowy, nie stoją w miejscu ani nie
  przecinają twarzy; mieszkańcy patrzą ku Słońcu zamiast w podłoże.
- Rower listonosza nie odwraca już postaci pod jezdnię podczas pościgu psa ani
  na zakrętach. Kierunek i przechył korzystają ze stabilnej rotacji `YXZ`
  zamiast połączenia `lookAt()` z podatnym na gimbal lock obrotem Eulera.
- Punkty doręczeń listonosza są odwiedzane w kolejności trasy, jego kurs nie
  restartuje się po cofnięciu zegara, a zaćmienie nie wznawia starego pościgu psa.

### Performance

- Benchmark wydajności ma wyłączną blokadę procesu i twardo wymusza jeden
  kontekst przeglądarki oraz jedną kartę. Równoległe instancje Dioramy nie mogą
  już bezgłośnie zaniżać wyniku.
- Serwer deweloperski nie otwiera automatycznie nowej zakładki przy każdym
  uruchomieniu; sesje QA tworzą i sprzątają dokładnie jedną kartę.
- Kamera autobusu ma dedykowany bliski LOD: ogranicza koszt SSAO, DPR i
  nakładających się fizycznych świateł, zachowując reflektory autobusu, najbliższe
  światła miasta, emissive'y, glow, bloom, grading oraz cienie.
- Budżety bundla obejmują teraz osobno bootstrap aplikacji, kod aplikacyjny,
  `three`, `camera-controls` i `postprocessing`.
- Warstwa zaćmienia jest pojedynczym billboardem proceduralnym z profilem
  jakości, nie wymusza regenerowania PMREM w każdej klatce i ma osobny
  scenariusz `eclipse-totality-overview` w benchmarku High.
- Dodano adaptacyjne profile Low, Medium, High i Auto, budżety świateł,
  dynamiczne ładowanie profilera oraz metryki `renderer.info` (`cad8325`).
- Rendering P1 wykorzystuje profilowane SMAA/SSAO, selektywny bloom, LUT-y,
  PBR jeziora i ograniczone aktualizacje opcjonalnych aktorów (`f30c922`).
- Instancjonowane płaszczyzny gruntu redukują liczbę trójkątów powierzchni
  sześciokrotnie bez zmiany układu dróg, chodników i trawy.
- Odległościowy LOD ogranicza w panoramie SSAO, bloom, lampy punktowe, DPR i
  rozdzielczość cieni; bliskie ujęcia zachowują pełny detal.
- Historyczne trzy czyste, sekwencyjne serie M1 Pro dla pięciu scenariuszy
  poprzedniego wydania osiągnęły minimum 58,67 FPS, najgorsze p95 17,7 ms oraz
  TTI 1,56–1,62 s.

### Validation

- 159 testów w 26 plikach testowych.
- Przechodzą `npm run typecheck`, `npm test` i `npm run build`.
- Pełny benchmark obejmuje siedem stanów, w tym pięć naprzemiennych par
  tęczy OFF/ON. Finalna seria na M1 Pro utrzymuje około 120 FPS bez hitchy,
  z medianą delty p95 +0,2 ms, CPU +0,1 pp i timera GPU +0,4 ms.
- Smoke test sprawdza desktop/mobile, monotoniczny preloader kończący na 100%,
  totalność i warstwy zaćmienia, canvas, luminancję, kolizje, oświetlenie, rytm
  miasta, aktorów i budżety renderera. Dodatkowo wykonuje rzeczywisty pierwszy
  drag i wheel przerywający automatykę oraz dwa świeże starty tego samego
  seeda/checkpointu, porównując stan sceny.

### Commits

- `2f8e115` — `feat: complete living-city P1 polish`
- `d6fe5a8` — `merge: living-city P1 polish`
- `f30c922` — `feat: complete P1 rendering and city polish`
- `cad8325` — `perf: add adaptive quality and 60fps benchmarks`

## [1.0.0] - 2026-06-10

### Added

- Początkowa proceduralna diorama Three.js z voxelowym miastem, jeziorem,
  pociągiem, tunelem portalowym, wiaduktem i pętlą autobusową.
- Cykl dnia i nocy, pogoda, motywy wizualne, kamera swobodna i kamery pojazdów.
- Aktorzy i scenki środowiskowe: pasażerowie, ptaki, ryby, wędkarz, listonosz,
  pies, krowa, farmer, UFO i balon.
- Panel sterowania pociągiem, testy Vitest, build Vite, CI oraz wdrożenie
  GitHub Pages.
