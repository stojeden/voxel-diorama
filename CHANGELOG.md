# Changelog

Wszystkie istotne zmiany projektu są dokumentowane w tym pliku. Projekt nie ma
jeszcze publicznych tagów wydań, dlatego prace po wersji początkowej pozostają
w sekcji `Unreleased` i są powiązane z rzeczywistymi commitami.

Format jest oparty na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
a wersjonowanie projektu docelowo stosuje [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `EclipseTimeline` z deterministycznymi kontaktami C1-C4, dokładnym polem
  przecięcia tarcz, irradiancją, totalnością, koroną i perłami Baily'ego.
- Proceduralny `EclipseVisual`: widoczne z dalekiej kamery Słońce i Księżyc,
  korona z promieniami, chromosfera, pierścień diamentowy i gwiazdy bez
  zewnętrznych modeli ani tekstur.
- Sterowanie `E` i przycisk „Zaćmienie”, szerokie kadrowanie zjawiska oraz HUD
  z fazą, pokryciem, paskiem postępu i komunikatem bezpieczeństwa.
- Reakcje mew na zaćmienie: od 85% pokrycia dolatują do najbliższych dachów,
  pozostają tam przez totalność i startują po spadku pokrycia do 65%.
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

- Zaćmienie trwa 96 sekund, zatrzymuje symulowaną pozycję Słońca, ale nie życie
  miasta, i płynnie steruje niebem, ekspozycją, światłami oraz widocznością
  gwiazd. Swobodna kamera nadal może przerwać automatyczne kadrowanie.
- Wbudowana tarcza Słońca z shadera nieba jest ukrywana podczas zaćmienia, aby
  na scenie nie pojawiały się dwa Słońca.
- Wszystkie fazy dnia i nocy przechodzą płynnie; bezpośrednie słońce, ambient,
  księżyc i ekspozycja nie zmieniają się już skokowo.
- PMREM korzysta z GPU crossfade przy stałej intensywności środowiska.
- Preloader kompiluje dzienne i nocne warianty materiałów, rozgrzewa composer
  ukrytymi klatkami i synchronizuje kolejkę GPU przed sygnałem gotowości.
- Autobus wykonuje o 23:30 ostatnią pętlę zbierając pasażerów, znika po kursie
  i wraca o 04:50, kolejno wysadzając ludzi na przystankach.
- Nocny kurs autobusu porusza się szybciej na pustych ulicach, aby pełna pętla
  mieściła się w skompresowanym czasie dobowym dioramy.
- Wędkarz korzysta z osobnej pozy siedzącej, dopasowanego stołka i skrzynki;
  zgięte nogi nie przecinają siedziska ani podłoża.
- Profile jakości otrzymały osobny budżet dynamicznych świateł dworcowych.

### Fixed

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

### Performance

- Warstwa zaćmienia jest pojedynczym billboardem proceduralnym z profilem
  jakości, nie wymusza regenerowania PMREM w każdej klatce i ma osobny
  scenariusz `eclipse-totality-overview` w benchmarku High.
- Dodano adaptacyjne profile Low, Medium, High i Auto, budżety świateł,
  dynamiczne ładowanie profilera oraz metryki `renderer.info` (`cad8325`).
- Rendering P1 wykorzystuje profilowane SMAA/SSAO, selektywny bloom, LUT-y,
  PBR jeziora i ograniczone aktualizacje opcjonalnych aktorów (`f30c922`).
- Twardy benchmark zachowuje próg 58 FPS. Po rozszerzeniu sceny kamera pociągu
  przekraczała 60 FPS, ale szeroki overview pozostaje niestabilny i wymaga
  dalszego profilowania na chłodnym M1 Pro.

### Validation

- 97 testów w 14 plikach testowych.
- Przechodzą `npm run typecheck`, `npm test` i `npm run build`.
- Smoke test sprawdza desktop/mobile, totalność i warstwy zaćmienia, canvas,
  luminancję, kolizje, oświetlenie, rytm miasta, aktorów i budżety renderera.

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
- UI narracji o dylatacji czasu, testy Vitest, build Vite, CI oraz wdrożenie
  GitHub Pages.
