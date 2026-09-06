# Changelog

Wszystkie istotne zmiany projektu są dokumentowane w tym pliku. Projekt nie ma
jeszcze publicznych tagów wydań, dlatego prace po wersji początkowej pozostają
w sekcji `Unreleased` i są powiązane z rzeczywistymi commitami.

Format jest oparty na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
a wersjonowanie projektu docelowo stosuje [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Cyberpunk jest podmianą reprezentacji miasta, nie warstwą nad nim.** 34 działki
  mieszkalne i oba dominanty ustępują własnej reprezentacji budowanej z tego samego
  `CityModel`, więc megablok stoi na swojej działce i nic ze zwykłego budynku przez niego
  nie wystaje. Role bierze się z modelu: `family` mówi, które działki są mieszkalne, a
  `DominantSpec.kind` rozdziela ciepłownię z kominem od wieży transmisyjnej. Ulice,
  chodniki, latarnie, drzewa i spożywczak zostają — to układ miasta, wspólny dla obu stylów.
- Megabloki: bryły stopniowane, nadwieszenia ograniczone do metra na stronę i nie niżej niż
  12 m nad ziemią, piony instalacyjne, żebra, techniczne korony i trzy rodzaje stref okien.
  Całość to instancje trzech współdzielonych geometrii.
- Ciepłownia jako zakład: hale trzech wysokości, chłodnie, rurociąg na trestlach i
  oświetlenie techniczne. Komin zostaje kominem. Wieża RTV zostaje smukłą wieżą
  transmisyjną z platformami, pierścieniami i oszczędnymi światłami przeszkodowymi.
- **Dym z komina w obu stylach**: cienka smuga przy wylocie, unosi się, odchyla wspólnym
  wiatrem świata, rozprasza się i zanika. Cały cykl życia liczy shader z jednej liczby na
  cząstkę — brak alokacji w pętli klatki; Low rysuje 9 cząstek zamiast 26. Deterministyczny
  z zegara symulacji, więc checkpoint zamraża też smugę.
- Pociąg w Cyberpunku: aerodynamiczne czoło wewnątrz dwóch metrów, które lokomotywa już
  rezerwowała, ciągły pas szyb, fazowania i fartuch. Nic nie zostało wydłużone, więc łuki,
  perony i tunele bez zmian.
- Autobus w Cyberpunku: LED-y pod progami plus ślad, który zostawiają na asfalcie, a na
  mokrej jezdni węższe odbicie przy linii nadwozia. Jedna addytywna płaszczyzna, zero
  nowych świateł dynamicznych; siła rośnie z nocą i z wilgotnością drogi.
- Deterministyczny kalendarz naturalnych zaćmień: pierwszy dzień sesji jest
  zawsze spokojny, pierwsze zjawisko przypada losowo na dzień 2–5, a kolejne po
  2–6 dniach. Ręczne zaćmienie anuluje automatyczne tego dnia i również wymusza
  co najmniej jeden pełny dzień przerwy. Naturalne zjawisko nie przejmuje kamery.
- Dyskretne „Co dzieje się teraz" w prawym dolnym rogu HUD-u: czysta, testowalna
  projekcja `AmbientEvents` wybiera najwyżej jedno rzeczywiście trwające
  wydarzenie (aktywne zaćmienie → rozdział touru uruchomiony przez użytkownika →
  widoczna tęcza → postój pociągu → postój autobusu). Kiedy nic się nie dzieje,
  komponent nie wyświetla niczego — bez tekstów zastępczych i bez podpowiedzi.
- Projekcja raportuje wyłącznie wydarzenia, w które świat *wszedł*: stan prawdziwy
  już przy pierwszym odczycie (np. pociąg stojący na peronie startowym) jest
  warunkiem początkowym, nie wydarzeniem, więc diorama otwiera się pustym statusem.
- Stabilizacja 2,5 s dla rodzaju komunikatu chroni przed migotaniem między
  równoczesnymi zdarzeniami, ale nigdy nie utrzymuje komunikatu po faktycznym
  zakończeniu wydarzenia.
- Opcjonalny przycisk „Pokaż" przy trwającym wydarzeniu. Dopiero świadome
  kliknięcie prosi `CameraDirector` o miękki kadr (zaćmienie, tęcza po
  antysłonecznym azymucie, stojący pociąg lub autobus); samo pojawienie się
  komunikatu nigdy nie rusza kamerą, a wydarzenie w świecie pozostaje nietknięte.
  Przycisk nie pojawia się, gdy kamera i tak już kadruje dane wydarzenie.
- Bramki akceptacyjne kontraktu wejścia P1 w smoke teście: brak panelu startowego
  i jego zamienników, brak stanu pierwszej wizyty w `localStorage`/`sessionStorage`,
  odsłonięte centrum sceny, wolna i włączona kamera oraz pusty status natychmiast
  po preloaderze, brak automatycznego touru, zaćmienia pierwszego dnia i ruchu
  kamery przy naturalnym zjawisku, dokładnie jeden canvas i dokładnie jedno
  `requestAnimationFrame` na wyrenderowaną klatkę.
- Bramki dostępności i wejścia dla statusu: „Pokaż" jako prawdziwy przycisk
  osiągalny klawiaturą (`Enter` i spacja), `role="status"` zamiast `role="alert"`,
  brak przechwytywania fokusu, kadr dopiero po kliknięciu, oddanie kamery przy
  pierwszym `pointerdown`, scrollu, dotyku i klawiszu sterowania, layout mobilny
  poza centrum sceny i cel dotykowy co najmniej 24 px.
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

- Publiczna nazwa produktu została zmieniona z „Trans City Express” na
  **„Miasto”** — w tytule strony, nagłówku HUD-u, dostępnej nazwie panelu oraz
  dokumentacji. Techniczny klucz ustawień jakości pozostaje bez zmian dla
  zgodności z zapisanymi preferencjami użytkowników.
- Kadr „Pokaż” ma teraz osobnego właściciela dla tęczy, postoju pociągu i postoju
  autobusu, więc przycisk znika po wybraniu kadru i nie restartuje przejścia.
- Wyjście touru z rozdziału totalności zeruje linię zaćmienia przed Cyberpunkiem,
  zamiast zamrażać ostatni stan całkowitego pokrycia Słońca.
- Spacja nie przechwytuje już aktywacji sfokusowanego przycisku: globalny skrót
  pauzy ustępuje, gdy fokus jest na `<button>`.
- Suwak prędkości i klawisze `←`/`→` oddają kamerę użytkownikowi tak samo jak
  pozostałe elementy sterowania.
- Wygaszany preloader dostał `pointer-events: none`, więc 420 ms cross-fade nie
  połyka już pierwszego gestu użytkownika.
- Wadliwy, codzienny wyzwalacz zaćmienia został zastąpiony osobnym
  `EclipseSchedule`, opartym na indeksowanych próbkach seeda świata. Zjawisko
  może rozpocząć się naturalnie bez decyzji użytkownika, ale tylko ręczne
  uruchomienie kadruje Słońce; automat pozostawia kamerę dokładnie tam, gdzie
  ustawił ją użytkownik.
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

- Ślad LED-ów autobusu nie schodzi na nieutwardzone. Pierwsza wersja miała 5,2 × 10,6 m i
  malowała krawężniki oraz chodnik; istniejące testy skrajni i proporcji zmierzyły wtedy
  autobus jako pojazd o szerokości 6,2 m. Sama szerokość niczego jednak nie dowodzi na
  zakręcie, bo sztywny prostokąt na krzywej wychyla narożniki dalej niż własna półszerokość
  — więc cztery narożniki obeszły całą trasę w 1 600 pozycjach i w każdym z przystanków.
  Przy 3,6 × 8,8 m trzy próbki wypadały na trawie obok ciepłowni; przy **3,4 × 8,4 m** ani
  jedna. Ślad sięga chodnika — tak jak samo nadwozie w jedynym miejscu, gdzie trasa
  nadwiesza krawężnik — i to jest w porządku: światło padające na utwardzony krawężnik robi
  to, co światło. Leżące na trawie nie.

- Delta klatki nie może być ujemna. `timer.reset()` wykonuje się synchronicznie
  bezpośrednio przed pierwszym `animate()`, a pierwszy znacznik czasu z `rAF`
  może wtedy poprzedzać ten reset nawet o pełny okres klatki. Przy 60 Hz to
  −16 ms i jedna klatka na wyrównanie, ale przy renderze programowym delta
  wynosiła około −2 s i cofała zegar symulacji, pogodę, wygaszanie kamery oraz
  kadencję HUD-u na kilkanaście klatek — zegar, status stacji, etykieta pogody
  i status zaćmienia zamierały wtedy na kilka sekund po preloaderze.
- Przerwanie touru w rozdziale totalności nie zostawia już miasta w wiecznym
  zaćmieniu całkowitym. `endTourOverrides` wywoływał `eclipseTimeline.stop()`,
  co czyściło wyłącznie `running` i pozostawiało linię czasu zaparkowaną na
  postępie rozdziału, więc pokrycie 100%, otwarty HUD zaćmienia i biegnący zegar
  utrzymywały się bez końca. Inscenizowane zaćmienie touru jest teraz cofane.
- Przycisk „Zaćmienie" wciśnięty w trakcie touru faktycznie uruchamia zjawisko.
  Wcześniej `startEclipse` startowało linię czasu, a następnie `focusEclipseView`
  wywoływało `endTourOverrides`, które to zjawisko natychmiast zatrzymywało.
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

- **Cyberpunk mierzony instrumentem GPU aplikacji, i opisany dokładnie tak, jak na to
  pozwalają dane.** Panorama nocą, `debugStartFrameTiming`, 240 próbek na scenę: mediany
  wszystkich zmierzonych stanów mieszczą się w przedziale 4,7–7,2 ms, czyli z zapasem
  wewnątrz klatki 16,7 ms. Ten sam stan (Cyberpunk noc, High) w trzech przebiegach dał 5,86,
  5,55 i 4,70 ms — rozrzut 1,16 ms jest **tego samego rzędu co różnice między scenami**,
  więc z tych danych **nie wynika żadne uszeregowanie scen** i nie twierdzimy, że któraś
  jest tańsza. Deszcz dodaje około 1,5 ms, co również leży na granicy rozdzielczości tego
  pomiaru. p95 dla tych samych scen wahało się między przebiegami od 7,3 do 15,2 ms —
  także w scenach klasycznych — więc p95 opisuje tu stan maszyny, nie zawartość scen, i nie
  jest podawane jako właściwość zmiany.
- Budżety utrzymane, nie podniesione: szczyt geometrii w Cyberpunku 577 przy limicie 600
  (pierwsza wersja sięgała 606, dopóki powłoki pojazdów nie zostały scalone materiałowo),
  chunk wejściowy 242 418 B przy 244 000 B, warstwa stylizacji w osobnym chunku
  `cyber-style`.
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
