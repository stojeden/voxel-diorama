# Changelog

Wszystkie istotne zmiany projektu są dokumentowane w tym pliku. Projekt nie ma
jeszcze publicznych tagów wydań, dlatego prace po wersji początkowej pozostają
w sekcji `Unreleased` i są powiązane z rzeczywistymi commitami.

Format jest oparty na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
a wersjonowanie projektu docelowo stosuje [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Jeden wiatr, który ma kierunek — i sześciu konsumentów, którzy mu odpowiadają.** Świat miał
  trzy wiatry, które wiatrem nie były: drzewa gięły się w zaszytym `(1, 0.55)` na zawsze, dym
  wyprowadzał sobie własny azymut i pisał o tym w komentarzu, a balon czytał z wiatru **tylko
  prędkość** i przelatywał z zachodu na wschód nawet przy wichurze z północy. Nic nie mogło się
  nie zgadzać, bo nic nie miało wspólnego faktu. `src/environment/wind.ts` jest teraz tym faktem:
  azymut skręcający przez 25 minut, czysta funkcja zegara, **swobodnie narastający i nigdzie
  niezawijany**, żeby nic w dole nie odziedziczyło skoku przy π. Wektor wskazuje kierunek, w
  którym powietrze **płynie**, zapisany przy wszystkich pięciu granicach, bo to jest dokładnie ten
  znak, który przeżywa recenzję.
  Odpowiadają mu: drzewa (stałe pochylenie z wiatrem plus dotychczasowe drżenie wokół niego),
  dym, balon (wchodzi krawędzią pod wiatr i dryfuje z nim), chmury, **smugi deszczu i śnieg**.
- **Burza.** Nie pioruny — wyładowania wewnątrzchmurowe, czyli to, co naprawdę oznacza „chmura
  świeci od środka": 0,15 s na wyładowanie, dwa do czterech powtórzeń co 0,11 s (to migotanie
  czyta się jak błyskawica, a nie jak przygaszanie), około pięciu na minutę, cała powała unosi
  się trochę, a najbliższa komórka najmocniej. **Zero nowych draw calli i zero geometrii**, bo
  powała jest już jednym `InstancedMesh` i wystarczy jej kolor instancji — zmierzone po obu
  stronach na rasteryzatorze programowym: 1234 wywołania, 619 457 trójkątów, bez zmian.
  Zmierzone na żywo: **5,1 błysku na minutę**, kolor instancji chmury 1,000 → 1,917 w szczycie,
  średnia kadru +10 %, a prześwietlenie sceny **0 %** z błyskiem i bez — błysk jest widoczny,
  a niczego nie przepala. Deterministyczny z ziarna i zegara, więc checkpoint go odtwarza.
- **Mewy śpią ze złożonymi skrzydłami.** Gałąź odpoczynku miała komentarz „*Asleep: sit still,
  wings folded*", a kod pod nim ustawiał skrzydła 0,13 rad od pozy szybowania — ptak spał w
  pozycji lotu. Skrzydło jest jedną zlepioną bryłą, więc złożenie to skos 16°, opad 24° i
  skrócenie rozpiętości do połowy; koniuszek ląduje 0,079 za ogonem, jak lotki prawdziwej mewy.
  Zmierzone na produkcie: 7 z 11 mew ma `scale.x = 0.500` w nocy, pozostałe cztery jeszcze lecą.

### Fixed

- **Puszczony punkt kontrolny totalności nie zostawia miasta w zaćmieniu.** `?checkpoint=totality`
  i `eclipse-totality-overview` ustawiają oś zaćmienia na totalność, nie uruchamiając go. Puszczenie
  punktu — pierwsze przeciągnięcie, klawisz, przycisk motywu — zwalniało zegar, ale nie cofało osi,
  więc zegar znów chodził, a miasto stało w pełnej totalności: tłum zamrożony, mewy na dachach,
  napis o zaćmieniu, aż do następnego naturalnego zaćmienia albo klawisza E. Po puszczeniu
  zaćmienie toczy się teraz dalej od miejsca, w którym stało, i samo się kończy, a zegar prowadzi
  przez nie jak przez każde zaćmienie. Na zbudowanym produkcie, przeciągnięcie myszą na totalności:
  produkcja — zegar 19:06 → 19:31, zakrycie 1,00 → 1,00 na stałe; po poprawce — +10 s diamentowy
  pierścień (19:12), +20 s zakrycie 0,93, +50 s 0,15, +58 s koniec o 19:37, dalej zwykły dzień.
  Bramka przeglądarkowa puszcza teraz ten punkt i sprawdza, że zaćmienie biegnie i się przesuwa
  (do końca 48 sekund symulacji to za długo na maszynę CI bez GPU). **Scenariusz benchmarku
  `eclipse-totality-overview` mierzył właśnie ten błąd** —
  totalność pod znów chodzącym zegarem, stan, którego żadne zaćmienie nie daje. Po poprawce po cichu
  wychodziłby w trakcie pomiaru z totalności, więc uruchamia teraz prawdziwe biegnące zaćmienie od p = 0,45 widziane
  z kamery przeglądowej i sprawdza, że cały pomiar leży w totalności. Jego wyniki nie są porównywalne
  z pomiarami sprzed tej zmiany.

- **Punkt kontrolny Cyberpunk podnosi miasto.** `?checkpoint=cyberpunk` ustawiał morf Cyberpunka
  na 1 podczas startu, zanim leniwie ładowane miasto hybrydowe w ogóle istniało. Miasto
  podpinało się potem przy wzniesieniu 0 i nikt go już nie pytał, bo pętla klatek dociąga morf
  tylko do celu, którego jeszcze nie osiągnął. W domyślnym świecie wychodziły zwykłe bloki pod
  cyberpunkowym filtrem, z cyberpunkowym autobusem i pociągiem. Hybryda przyjmuje teraz przy
  podpięciu stan morfu, w którym jest scena, i stosuje go przed pierwszą zamianą budynków, więc
  nie rysuje zwykłego miasta nawet przez klatkę. Na zbudowanym produkcie: produkcja — motyw
  Cyberpunk, wzniesienie miasta 0, zastąpionych działek 0; po poprawce — 1 i 36 (34 budynki i dwie
  dominanty). Bramka przeglądarkowa uruchamia teraz ten punkt kontrolny i sprawdza jedno i drugie;
  test jednostkowy pada bez poprawki. Typ `HybridMetrics` deklaruje wreszcie pole `cyber`, które
  bramki od dawna czytały bez typu.

- **Tryb czasu rzeczywistego pokazuje Słońce widza, nie jego strefy czasowej.** Zegar słońca
  dostawał godzinę z zegarka, więc południe słoneczne wypadało o 12:00, a w Warszawie w
  czerwcu jest o 12:38, we wrześniu o 12:29 (godzina czasu letniego, minus 24 min za 6° na
  wschód od południka strefy, minus równanie czasu). Słońce szło pół godziny za wcześnie przez
  cały dzień i zachodziło 40–45 minut przed prawdziwym. Teraz zegar słońca to czas słoneczny
  widza z SunCalc (południe słoneczne = 0,5), a wszystko, co znaczy godzinę — HUD, rozkład
  autobusów, sklepy, okna mieszkań wieczorem — czyta zegarek. Zachód w dioramie wobec
  prawdziwego nad Warszawą: 21.06 — 20:55 wobec 21:02, 23.09 — 18:25 wobec 18:35, 21.12 —
  15:19 wobec 15:26. Resztka 6–10 minut to refrakcja i rozmiar tarczy, których model słońca nie
  ma, plus przybliżenie deklinacji. Test idzie przez `getCycleT` minuta po minucie i na starym
  kodzie pada z odstępem 45 minut. Przy okazji: rozkład autobusu liczył każdy krok zegara
  wstecz jako skok o prawie dobę i resetował tłum na przystankach w każdej klatce cofania.
- **Mewy omijają wieże w poziomie, także komin i wieżę RTV.** Wznosząc się 2,2 m/s, mewa nie
  przeskoczy wieżowca, na który wylosowała cel kilka metrów przed dziobem, ani komina (46 m) czy
  wieży RTV (56 m, platforma o promieniu 5,2 m na 30,5 m), przez które dotąd przelatywała na
  wylot. Teraz sprawdza, czy przewidywany tor da się przelecieć; jeśli nie, próbuje kursów
  odchylonych o 20°, 40°… do 120° w obie strony, bierze najbliższy przelotny (o krok szerszy,
  jeśli też przelotny, dla zapasu) i trzyma go 1,5 s, żeby nie myszkować. Dominanty są tylko
  omijane: nie podnoszą pułapu i nie są grzędami. Lot na grzędę jest planowany tak samo aż do
  ostatnich 20 m, dopiero stamtąd mewa ślizga się prosto w dół na dach. Nowy cel wędrówki jest
  losowany do sześciu razy, dopóki nie da się do niego lecieć wprost, a cel przy dominancie
  odsuwany poza jej strefę — z 10-metrowym zasięgiem osiągnięcia celu i 9-metrowym promieniem
  skrętu mewa potrafiła krążyć wokół niego ponad minutę. Mewo-sekundy wewnątrz budynków i
  dominant na 20 minut dnia, pięć losowań: przed 3,7–5,6 s w budynkach i 2,9–7,4 s w dominantach,
  teraz 0,0 we wszystkich; w cyklach wieczór–poranek jedno losowanie ma 1,1 s, reszta zero.
  Koszt: 36 → 43 µs na wywołanie dla 11 mew. Test na zbudowanym mieście pada bez objazdów
  zarówno na budynkach, jak i na dominantach.
- **Mewy siedzą na dachach i latają nad miastem, które jest narysowane.** Brały dachy z bloków
  świata wokselowego, podczas gdy domyślne miasto jest hybrydowe: śpiące mewy wisiały od
  −1,09 do +2,61 m nad dachami, a trzy wieże punktowe (27,5 m z maszynownią) stały tam, gdzie
  mewy miały sufit lotu na 18 m. Miasto hybrydowe podaje teraz mewom swoje dachy liczone z tej
  samej geometrii, która je rysuje: połacie dwu- i czterospadowe, płyty dachów płaskich, a
  nadbudówki i maszynownie jako przeszkody, bo LOD chowa je z daleka i mewa na nich wisiałaby
  w powietrzu. Brzuch śpiącej mewy jest na dachu z dokładnością ±2 cm; próba promieniem w dół
  na zbudowanym mieście potwierdza wysokości dachów. Druga połowa: sufit lotu był liczony tylko
  w promieniu 6 m, a mewa wznosi się 2,2 m/s, więc o wieży dowiadywała się półtorej sekundy
  przed zderzeniem. Mewa przewiduje teraz swój tor na 48 m, ze skrętem ku celowi i znoszeniem
  przez wiatr, i zaczyna się wznosić dokładnie tak wcześnie, jak musi. Mewo-sekundy wewnątrz
  budynków na 20 minut: 133 na starych dachach, 100 na poprawionych bez patrzenia przed siebie,
  4,8–8,1 teraz (trzy losowania). Resztka to głównie płytkie muśnięcia (mediana 1,17 m) po
  wylosowaniu nowego celu tuż przy wieży; usunięcie jej wymagałoby omijania w poziomie.

### Changed

- **Zegar chodzi przez całe zaćmienie, a naturalne zaćmienie dojeżdża do swojej godziny
  płynnie.** Dotąd zegar stawał na 96 sekund, a przy zaćmieniu naturalnym jeszcze przeskakiwał
  w jednej klatce z godziny, którą wylosował harmonogram, na godzinę zaćmienia — w czerwcu do
  dwunastu godzin naraz, ze Słońcem przeskakującym niebo razem z każdym cieniem. Teraz:
  - **zegar jedzie** do początku zaćmienia krótszą drogą po tarczy, z łagodnym startem i
    hamowaniem, w 1,5–5 s zależnie od odległości; Księżyc czeka, aż dojedzie, więc nie wchodzi na
    Słońce, które jeszcze sunie po niebie;
  - **przez zaćmienie zegar chodzi**, godzina zegara na całe zjawisko: 18:37 → totalność
    **dokładnie 19:07** → 19:37 w czerwcu (Słońce 13,0° → 8,8° → 4,8°), 15:57 → 16:27 → 16:57
    jesienią (na końcu wciąż 2,0° nad horyzontem); potem idzie dalej zwykłym tempem, bez skoku.
    Zwykłego tempa nie da się utrzymać: doba ma 240 s, więc 96 s zaćmienia to 9,6 godziny i
    Słońce zaszłoby w połowie drogi do totalności. Totalność leży dokładnie tam, gdzie było
    strojone jej światło.
  Zmierzone na zbudowanym produkcie, zaćmienie naturalne wywołane o 8:30: zegar dojeżdża w
  około 7 s do 18:36, zaćmienie trwa 96 s z zegarem chodzącym od 18:36 do 19:36 (totalność przy
  19:06), po końcu 19:36 → 19:54 w 3 s. Najgorszy pojedynczy krok zegara to 12,9 min, na klatce z
  przestojem — wcześniej 12 godzin.
  **Ruchome Słońce wypuściło stary błąd w pozach tłumu.** Kod obrotu sylwetek zawijał kierunek do
  Słońca na nowo w każdej klatce i z jego znaku wybierał stronę półobrotu; przy stojącym Słońcu
  nie miało to znaczenia. Z ruchomym sylwetka stojąca niemal przodem albo tyłem do Słońca
  obracała tułów o 138–166° w jednej klatce. Dotychczasowy test sprawdzał 7 ustawień i
  nieruchome Słońce; nowy sprawdza co 5° z ruchomym i pada bez poprawki. Kierunek do Słońca jest
  teraz zapamiętywany w chwili, gdy zaczyna się obrót — tak jak wyjściowe ustawienie sylwetki —
  a ruch Słońca od tej chwili dodawany bez zawijania. Kamera przycisku „Zaćmienie" trzyma
  Słońce w kadrze od pierwszego do ostatniego kontaktu, w obu porach roku i trzech proporcjach.
- **Filtr barwny Cyberpunka działa.** Tablica była pod kluczem `'cyber'`, motyw ma id
  `'cyberpunk'`, więc od pierwszego dnia wpadała w klasyczny brak filtra. W tej samej klatce
  punktu kontrolnego średni niebieski rośnie o 5,5 %, czerwony spada o 2,7 % — chłodne
  przesunięcie zgodne ze wzorem tablicy. Nieznany motyw ostrzega teraz w trybie deweloperskim.

### Fixed

- **Przegląd całości: dziewięć błędów widocznych w działaniu, każdy przypięty testem, który bez
  poprawki pada.** Z recenzji całego repozytorium wzięte tylko rzeczy, które widać na ekranie:
  - **Bloom miasta hybrydowego ginął po przejściu jakości przez Low.** Przebudowa robi nowe
    siatki okien i świateł, a selekcja bloomu trzymała stare — `postprocessing` znakuje warstwę
    obiektu tylko przy dodaniu. Selekcja jest teraz odświeżana po każdej zmianie profilu.
  - **Markizy sklepów wisiały w powietrzu przed megablokiem Cyberpunka** (0,7–0,9 m przed
    ścianą, o każdej porze, bo złożona obudowa też się rysuje). Znikają teraz razem z kamienicą,
    na tym samym progu przekazania, i wracają z nią.
  - **Odrzutowiec w Cyberpunku leciał bokiem albo tyłem**, bo dziedziczył swobodny obrót balonu
    (stary kod: 97° od kierunku lotu). Każdy lot startuje z czystej orientacji, a przechył jest
    przechyłem — obrotem wokół osi kadłuba.
  - **Rolnik chodził metr nad łąką, skrzynka wisiała pół metra, śpiąca krowa unosiła się 0,36 m
    przez całą noc.** Wysokości pisane pod dawny grunt +0,5; konwersja na `GROUND_SURFACE_Y`
    zostawiła część z nich. Krowę porwaną przez UFO promień przeciąga teraz na oś płynnie,
    zamiast skoku o 2,6 m w bok.
  - **Pasażerowie autobusu wznosili się prawie metr nad jezdnią przy drzwiach** — punkt drzwi był
    na +0,5.
  - **Lampa przystanku świeciła na dach, nie pod dach.** Po obniżeniu dachu (`686a6a7`) została
    na 2,24 m, 0,28 m nad nim: przepalona plama na każdym dachu wiaty w nocy i ciemny sufit.
    Wisi teraz pod dachem, a moc spadła z 48 na 27,7, bo 48 × (2,08 / 2,74)² trzyma chodnik pod
    wiatą dokładnie tak jasnym, jak był.
  - **Mewy zostawały na dachach przez kilka dni**, jeśli zaćmienie przewinięto w trakcie (start
    trasy w totalności): postęp 0 czytał się jak faza nadchodząca i zatrzask się nie zwalniał.
  - **Ujęcie „TOTALNOŚĆ" w trasie i dwóch punktach kontrolnych gubiło zaćmione Słońce** — literał
    sprzed pór roku; przy czerwcowej deklinacji tarcza lądowała na x = 1,03 w kadrze 16:9 i poza
    nim przy 16:10 i 4:3. Ujęcie liczy się teraz z tej samej funkcji co przycisk „Zaćmienie".
  - **Ponowny wybór aktywnego motywu wygaszał jego filtr barwny na stałe**, a podwójne kliknięcie
    w trakcie przejścia cięło obraz. Wybór motywu, który już jest, niczego nie zmienia.
- **Automatyczna jakość na ekranie 60 Hz umiała tylko schodzić w dół.** Próg podwyższenia to
  klatka krótsza niż 16,2 ms, a rAF nie wyprzedzi vsync — średnia stoi na 16,67 ms niezależnie od
  zapasu GPU. Jeden wolny odcinek, na przykład noc, kosztował jakość do końca sesji. Poziom
  obniżony poniżej rekomendacji sprzętu wraca teraz o jeden stopień po minucie pracy w pełnym
  tempie ekranu (średnio ≤ 17,5 ms), nigdy powyżej rekomendacji; jeśli nie utrzyma się 45 s,
  czas oczekiwania się podwaja, do ośmiu minut, żeby dzień i noc nie przełączały jakości w kółko.

- **Peron pustoszał na zawsze po jednym pociągu, bo `group.visible` znaczyło dwie rzeczy naraz.**
  Ta sama flaga niosła dwa niezależne fakty: **culling gęstością** (`cad8325`, profil jakości
  wyłącza część figur) i, od `328878a` sprzed pięciu dni, **wynik przenikania** (`visible =
  currentOpacity > 0.01`, oszczędność draw calli na figurach wyblakłych do zera). Pętla `update`
  pomijała `updatePassenger` dla niewidocznych, a `updatePassenger` jest jedynym miejscem, które
  zapisuje `material.opacity` **i** `group.visible`. Fałsz był więc stanem pochłaniającym: raz
  zgaszona figura nie miała już żadnej drogi powrotu. Zbocze opadające postoju podnosi
  `targetOpacity` do 0,92, a nowy postój ustawia `currentOpacity` na 0,92 — obie te wartości
  odczytuje wyłącznie `updatePassenger`, który dla tej figury nigdy więcej nie biegł.
  **Zaćmienie nie było tylko tłem — decyduje, która połowa tłumu ginie.** Przy normalnym tempie
  pochłaniani są **wsiadający**: po dojściu do wagonu dostają zerową przezroczystość i gasną
  poprawnie, ale już nie wracają. Postój na Stacji Zachodniej trwa 5 s, a najdłuższe przejście
  kończy się około 3,9 s (3,4 s marszu, którego ostatnia ćwiartka jest już zanikaniem — 0,75 to
  próg postępu, nie sekundy — plus pół sekundy ogona wygładzania), więc zdąży **każdy**: jeden
  pociąg zabiera trzy z sześciu figur na stałe. Przy zaćmieniu `movementScale` spada do 0,04 i
  ginie **druga połowa**: wysiadający startuje z przezroczystością 0, a jego cel w pierwszym kroku
  to 0,0022–0,0028, co po wygładzeniu daje **3·10⁻⁵ przy progu 0,01**. Gaśnie, zanim ktokolwiek go
  zobaczy — i to jest dokładnie zgłoszony podpis: ludzie wsiadają, peron pustoszeje, nikt nie
  wysiada. Poza zaćmieniem wysiadający przeżywa pierwszy krok (0,014–0,031), więc tej połowy
  objawu nie widać.
  **Tempo ma znaczenie i łatwo je przeoczyć.** `main.ts` nie krokuje tłumu co klatkę, tylko z
  akumulatora przy `optionalActorHz` (20, 20 i 24 w trzech profilach) i podaje **czas
  zakumulowany**, więc najkrótszy krok, jaki ta klasa kiedykolwiek widzi, to 1/20 s — cztery razy
  dłużej niż klatka przy 60 Hz. Próg 0,01 przecina się między 1/30 a 1/24, więc pomiar zrobiony
  przy 1/60 odpowiada na pytanie, którego produkt nie zadaje. Pierwsza wersja tych testów była
  napisana przy 1/60 i została przez to poprawiona.
  Zmierzone na zbudowanym produkcie, A/B, z jedyną różnicą w postaci samego raportera dołożonego do
  starej wersji (`visible` i `opacity` w stanie debugowym, zero zmian w zachowaniu), **z profilem
  przypiętym na wysoki w obu próbach** — adaptacyjny menedżer wybiera profil z mierzonej
  wydajności, więc dwa nieprzypięte biegi potrafią wylądować na różnych gęstościach i przestają
  być porównywalne. Przy `actorDensity` 0,9 pełny peron to **5 z 6**, i tyle pokazują obie próby na
  starcie. **Przed**: Stacja Zachodnia 5 → 3 po pierwszym pociągu → **0** po drugim (t = 58 s) i
  zero przez pozostałe 50 s; Przystanek Wiadukt 5 → 4 → 3 → 1 → **0** (t = 106 s). Oba perony
  pustoszeją i już się nie odbudowują. **Po**: obie stacje trzymają **5 z 6** przez cały bieg, z
  chwilowym spadkiem tylko na czas wymiany pasażerów. Obecność liczona jako flaga rysowania wraz z
  przezroczystością powyżej 0,5, żeby nie policzyć figury, której nikt nie dotknął.
  Naprawa rozdziela dwa znaczenia: `culled` jest osobnym polem ustawianym wyłącznie przez
  `setDensity`, pętla bramkuje się na nim, a `group.visible` zostaje czystą flagą rysowania
  liczoną z przezroczystości. Oszczędność draw calli z `328878a` jest zachowana — figura wyblakła
  do zera dalej się nie rysuje, tylko dalej *liczy*. Bramka budżetowa: **szczyt 1310 z 1400**
  wobec 1290 wcześniej. Tych dwudziestu wywołań nie wolno czytać jako dwudziestu figur: przy
  pięciu siatkach na figurę to około czterech, a stacji jest dwie po sześć osób, z czego bramka
  (profil wysoki, `actorDensity` 0,9) rysuje najwyżej pięć na stację. Geometrie 423 bez zmian.
  Klasa `PassengerCrowd` nie miała **ani jednego** testu na cykl postoju — stąd regresja przeszła.
  Ma teraz cztery, pisane w tempie produktu (1/20 s) i liczące obecność jako flagę rysowania **wraz
  z** przezroczystością pod nią, bo `THREE.Object3D.visible` startuje jako `true` i samo w sobie
  nie odróżnia figury, która się pojawiła, od takiej, której nikt nigdy nie dotknął. Sprawdzone
  sabotażem: stara bramka wywala te dwa testy, które opisują zgłoszony objaw (peron zostaje z
  3 z 6; pod totalnością wysiadających nie widać ani jednego); zamrożona pętla wywala wszystkie
  cztery; tłum zmniejszony do dwóch figur — trzy; wariant, w którym nikt nie wsiada — jeden.

- **Autobus na nocnej przerwie zostawiał dwadzieścia figur w liście rysowania.**
  `setAllPassengersAtStop` zeruje `currentOpacity` i `material.opacity`, ale nie dotykało
  `group.visible`, a `updatePassenger` — jedyny inny zapisujący tę flagę — nie biegnie, bo pętla
  tłumu ma nad sobą wcześniejszy `return` dla trybu `off`. Figura zostawała więc zaznaczona do
  rysowania, całkowicie przezroczysta, aż do wznowienia kursów o 04:50: pięć siatek na figurę w
  przebiegu koloru i normalnych, dokładnie ten koszt, przed którym komentarz w tym samym pliku
  ostrzega. Wchodzi się w to zimnym startem w oknie nocnym albo skokiem czasu (synchronizacja z
  zegarem systemowym po 2:00). Flaga rysowania podróżuje teraz razem z przezroczystością.
  Przypisane przez cofnięcie samej tej jednej linii i powtórzenie pomiaru: **szczyt 1310 → 1110**
  wywołań w oknie bramki (mediana 1290 → 1090), rasteryzator programowy **1234 → 1034** wywołań
  i 619 457 → 617 057 trójkątów. Dwieście wywołań to dokładnie dwadzieścia figur po pięć siatek
  w przebiegu koloru i w przebiegu normalnych. Cały ten commit schodzi więc z 1290 na 1090
  mediany przy budżecie 1400 — budżet zostaje tam, gdzie był.

- **Jasna kula przy wjeździe i wyjeździe to nie było Słońce — to był Księżyc, i nie istnieje na
  żadnym zdjęciu.** Przy zakryciu 0,09–0,31 na ekranie stało jedno koło o promieniu 21 px,
  przesunięte 27→19 px w dół i w prawo od środka Słońca, czyli dokładnie tam, gdzie stoi Księżyc.
  Część nachodząca na Słońce była czarna (luma 8), reszta kremowa (~240), niebo 254. Samo Słońce,
  o promieniu 20,6 px, leżało w środku i było **niewidoczne** — biel na bieli. Oko widziało więc
  jedną kulę rozciętą na dwa tony wzdłuż linii, której nie ma czego dotyczyć, przesuniętą w bok od
  poświaty: nie „Słońce jest zjadane", tylko **błąd cieniowania na kuli**.
  Badanie zrobione pod tę zmianę dało twardą granicę: na zdjęciu z 2024-04-08 przy zakryciu 91,7 %,
  gdzie niebo wokół Słońca jest jasne (~155/255), test parzystych powłok promieniowych po **51 857
  parach pikseli** pokazał, że obszar za Księżycem różni się od lustrzanego nieba o **−0,19 poziomu
  z 255** przy rozrzucie 4,26 — czyli 22 razy poniżej szumu. Księżyc poza tarczą Słońca nie jest na
  zdjęciach słabo widoczny. Jest **nieobecny**, przy każdym zakryciu i każdej ekspozycji.
  Rysowana jest teraz **sama soczewka** — przecięcie obu tarcz, jedyne, co zawiera fotografia — i nic
  poza nią.
  Arytmetyka, która czyni to trudnym, jest zapisana, bo następna osoba sięgnie po jasną stronę, a
  jasnej strony nie ma: sierp jest warstwą dodawaną na niebie stojącym w punkcie obcięcia ACES, więc
  jego kontrast to 255 minus kod nieba, czyli **+0,8 / +1,4 / +4,3 / +13,5 / +47,8 kodu** przy
  zakryciu 0,05 / 0,20 / 0,50 / 0,75 / 0,90 — a w pełni kryjący ciemny znak daje w tych samych
  punktach **251 / 250 / 248 / 238 / 204**. Poniżej trzech czwartych zakrycia jasna strona zaćmienia
  w tej ekspozycji **nie istnieje**.
  **Obrys Słońca był po drodze i został usunięty** — decyzją właściciela, po zobaczeniu go na ekranie.
  Czteropikselowa kryjąca linia na limbie, wyrastająca jako łuk z wygryzienia, dawała soczewce okrąg,
  z którego jest wygryzieniem, i była najczytelniejszym obiektem w kadrze przy zakryciu 0,20 — ale
  była wynalazkiem: żadne zdjęcie nie ma czarnego pierścienia wokół Słońca. Zapisane, bo to
  wiarygodny pomysł, którego ponowne odkrycie kosztuje kompilację.
  Cena wierności jest nazwana wprost: poniżej trzech czwartych zakrycia widać bardzo niewiele, i tak
  właśnie wygląda zaćmienie częściowe w szerokim kadrze. Do tego momentu widzowi mówi o nim światło,
  półksiężyce pod drzewami i tłum sięgający po okulary — nie Słońce.
  **Światło nietknięte**: totalność nadal najciemniejsza klatka, miasto 0,234 i niebo 0,085 tej samej
  godziny bez zaćmienia, pikseli dokładnie czarnych 0,0000 % w każdej fazie, klatki totalności bez
  zmian (najjaśniejszy piksel 246,1 jak w każdym wcześniejszym przebiegu).
- **Miękkie pasmo nie jest słabą linią — jest brakiem linii, a TAA zjada cienkie znaki.** Dwie
  pułapki, obie znalezione pomiarem, obie kosztowały po jednej kompilacji. Pierwsza: obrys napisany
  jako `1.0 - smoothstep(0.0, halfWidth, |d − R|)` to pasmo, którego krycie sięga 1 tylko na osi —
  a **ośmiopikselowe** pasmo narysowało się jako jedna blada pomarańczowa kreska, bo niebo stoi
    w punkcie obcięcia: połowa z 33 to 16,5 — połowa radiancji obcięcia, nie powyżej niej — i wciąż daje
  kod 253, bo krzywa wydaje na ten pierwszy stop około dwóch kodów. Czyta się dopiero pełne
  krycie, przy kodzie 3. Druga: nawet płaska linia o szerokości 2,5 px wychodziła brązowa, bo
  `TemporalResolvePass` drga projekcją o 0,75 px i akumuluje, więc cienki rdzeń nigdy nie osiąga
  krycia 1. Zmierzone na jednym promieniu przez limb przy zakryciu 0,208: linia 2,5 px z TAA — luma
  **99…212**; ta sama linia przy `taa=0` — luma **8**; linia 4,0 px z TAA — luma **8** na 2,25 px.
  Stąd cztery piksele, a nie jeden.

- **Księżyc szedł przez Słońce w złą stronę — i prawie poziomo, gdy niebo każe pod 36°.** Kierunek
  ruchu Księżyca względem Słońca to **wschód niebieski** w miejscu, gdzie Słońce stoi: Księżyc
  okrąża Ziemię i wyprzedza Słońce o jakieś pół stopnia na godzinę. Wschód niebieski to kierunek
  **malejącego kąta godzinnego** przy stałej deklinacji — `H = LST − RA`, więc więcej rektascensji
  to mniej kąta godzinnego — czyli `−d(sunDirectionAt)/dH`, a zróżniczkowanie modelu z `sky.ts`
  daje dokładnie `biegun × kierunek`. To jest teraz `celestialEastAt`, sprawdzone dwoma
  przypadkami kontrolnymi: patrząc na północ wschód jest po prawej, a w południe na półkuli
  północnej Księżyc idzie **w lewo** — czyli zaćmienie z każdej fotografii.
  Rysowane było `vec2(moonOffset, moonOffset * 0.025)` wzdłuż lokalnego +X billboardu, a lokalne
  +X billboardu **jest wektorem „w prawo" kamery** (`lookAt` daje `x = up × z`, a `z` patrzy w
  stronę kamery, co wychodzi na `sunDirection × worldUp`). Przy separacji biegnącej −1 → +1
  Księżyc przechodził więc z lewej na prawą i wgryzał się w **lewą** krawędź Słońca. Wschód
  niebieski przy inscenizowanej godzinie ma składową „w prawo" równą **−0,805** — czyli dokładnie
  na odwrót — i składową „w górę" +0,594, czyli **144° od prawej strony ekranu**, a nie 1,43°.
  Po zmianie Księżyc wchodzi z **prawego dołu** i wychodzi w **lewą górę**. Zmierzone na produkcie
  przez dopasowanie prostej do środka tarczy na dziesięciu klatkach: **142,7°** wobec 143,6°, które
  daje niebo. Pierścień diamentowy jeździ po tej samej cięciwie, więc zapala się teraz w lewej
  górze przy C2 i w prawym dole przy C3. Cięciwa liczy się **co klatkę z pozycji Słońca**, więc idzie
  za motywem (klasyczny 143,6°, jesienny 145,5°) i nie czyta niczego z kamery — bo baza billboardu
  zależy tylko od Słońca i pionu świata, dlatego odpowiedź jest ta sama z każdego miejsca.
  Model nie ma ekliptyki, tylko deklinację i kąt godzinny, więc to jest wschód **wzdłuż równoleżnika
  deklinacji**, a nie wzdłuż orbity Księżyca. Pokrywają się w przesileniu, czyli tam, gdzie
  deklinacja +23,44 domyślnego motywu stawia Słońce; dalej od przesilenia różnią się co najwyżej
  o nachylenie ekliptyki, a oddanie tego znaczyłoby dodanie temu niebu ekliptyki, której nie ma.
  **Nie ruszone, świadomie**: półksiężyce rzucane przez liście na ziemię biorą stronę wygryzienia
  ze znaku separacji w przestrzeni kafla, która nie ma zdefiniowanego związku z osiami ekranu —
  a obraz przez otworek jest w dodatku odwrócony. Przy 13 px to jest osobny temat, nie ten.

- **Księżyc nie przechodził przez Słońce — wykluwał się na nim.** Warstwa Księżyca maskowała się
  tarczą **Słońca** (`moonMask * max(sunMask, uTotality)`), więc przez obie fazy częściowe na
  ekranie było rysowane wyłącznie **przecięcie dwóch okręgów** — soczewka zaostrzona na obu
  końcach. Samego Słońca przy tej ekspozycji nie widać (niebo obok niego prezentuje się jako
  254/255, a tarcza dodaje się do niego), więc nie było jasnego krążka, z którego ten kształt
  byłby wygryzieniem: rodził się w środku białej poświaty i puchł. Właściciel nazwał to jajem.
  Zmierzone na produkcie: prostokąt otaczający ciemny kształt szedł od 10×70 do 82×252 px,
  proporcja 0,14–0,33. Teraz jest **43×43 px, proporcja 0,98–1,00 w każdej fazie częściowej** —
  koło tej samej wielkości przez całe przejście.
  Trzy zmiany, jeden efekt: (1) Księżyc rysuje się jako sylwetka na niebie, a nie tylko tam, gdzie
  zachodzi na Słońce — to **świadome odstępstwo od fizyki**, zapisane jako odstępstwo, bo powietrze
  przed Księżycem świeci tym samym rozproszonym światłem co niebo obok; (2) **odsłania go samo
  Słońce**: przezroczystość sylwetki wisi na **zakryciu**, więc przy zakryciu 0 nie ma czego
  zobaczyć nigdzie, a tam, gdzie tarcza leży na fotosferze, jest zawsze w pełni krystaliczna, bo
  tam nie jest sylwetką, tylko rzeczą, która zabiera światło; (3) przejazd jest **jedną
  monotoniczną krzywą C1** przez te same sześć autorskich momentów.
  Pierwsza wersja punktu (2) była inna i została wycofana **na prośbę właściciela**: rysowała
  sylwetkę w pełnej sile od chwili wejścia w kadr i dokładała przejazd zaczynający się 0,45
  odległości kontaktowej od Słońca. Razem stawiało to kompletną czarną kulę na pustym niebie na
  dziewięć sekund, zanim cokolwiek stało się ze Słońcem — inny zły obraz: planeta, która nadlatuje,
  a nie Księżyc, który zostaje złapany. Po zmianie podejście przestało cokolwiek dawać (przez ten
  czas i tak nic nie widać), więc przejazd wrócił do „kontakt–kontakt" i faza częściowa ma znów
  pełne 32 sekundy zamiast 24.
  Odsłanianie jest **prawem potęgowym, nie rampą**: ACES odwzorowuje niebo 25 na kod 254, a połowę
  tego nieba na 252 — dwa kody za połowę światła — więc liniowa rampa krycia jest niewidoczna aż do
  samego końca. Zmierzone przy pierwszej próbie: 253, 253, 250, 84, 7 na pięciu separacjach, czyli
  przeskok. Teraz spada geometrycznie **przeżywający ułamek nieba** (`pow(0.001, zakrycie / 0.35)`),
  wykładnik nie jest przycinany u góry, a krok jest **poniżej ośmiu poziomów na dziesiątą sekundy**.
  Tarcza jest czytelna jako koło już przy zakryciu 0,1 — 5,7 s z dziewięćdziesięciu — i czarna, nim
  wygryzienie mogłoby wyjść szare.
  Pięć niezależnych `smootherStep` zastąpiła jedna krzywa, bo `smootherStep` ma **zerową pochodną
  na obu końcach**: Księżyc zatrzymywał się na amen przy każdym złączeniu, cztery razy w ciągu
  dziewięćdziesięciu sekund i raz na samym starcie. Na dwóch tysiącach próbek najmniejszy krok
  wynosił 5,6e-9 przy średniej 1,0e-3; teraz 4,5e-5 przy średniej 1,45e-3. **Węzły nie drgnęły** —
  drugi kontakt nadal wypada na 0,42, a totalność nadal zajmuje dokładnie [0,42; 0,58].
  **Światło jest nietknięte**, i to jest sedno: totalność to nadal 0,0956 tej samej godziny bez
  zaćmienia (miasto 0,234, niebo 0,087), totalność jest nadal najciemniejszą klatką, pikseli
  dokładnie czarnych jest nadal 0,0000 % w każdej fazie, a klatki totalności są tym samym obrazem.
- **Dwie kopie tych samych dwóch linijek w dwóch shaderach, które muszą się zgadzać co do bitu.**
  Warstwa Słońca wycina fotosferę przez `1.0 - moonMask`, a warstwa Księżyca rysuje sylwetkę przez
  `moonMask`; rozjazd o jeden znak to obwódka fotosfery za Księżycem albo obwódka Księżyca bez
  Słońca pod spodem, i nic w repozytorium by tego nie złapało. Teraz jest jeden fragment.
  Przy okazji: brzeg tarczy jest **szeroki na piksel wszędzie, gdzie jest rysowany** (`fwidth`), a
  nie 0,003 jednostki billboardu — co było ćwiartką piksela przy tym kadrze i inną liczbą pikseli
  przy każdym innym. Tor Księżyca jest **prostą cięciwą**, a nie sinusem separacji, który zawracał
  przy |separacji| 0,654.
- **Dzwonienie Catmull-Roma w resolwerze czasowym rysowało ciemny łuk pod tarczą Księżyca.** Bufor
  historii jest liniowy HDR: niebo obok zaćmionego Słońca ma rząd 100, a tarcza przed nim 0,9, więc
  ujemne listki jądra schodziły sto pięćdziesiąt poziomów **pod** obiekt, który obrysowywały — i
  przechodziły przez zabezpieczenie (`max(…, 0.0)` nigdy nie strzelało) oraz przez klips sąsiedztwa
  (przy takiej krawędzi sigma jest ogromna). Ograniczenie **samego niedomiaru** do własnych próbek
  usuwa to w całości (szczelina 150 → 12 poziomów, czyli tyle, ile ma własny antyaliasowany brzeg
  tarczy) za **0,8 punktu ostrości**; ograniczenie obu stron kosztuje 2,4 punktu i daje ten sam
  wynik, dlatego obustronna forma pozostaje odrzucona. Zmierzone tą samą sondą co zawsze, w tej
  samej godzinie: bez klipsa −49,5 % drgania / −2,6 % ostrości, z jednostronnym −51,6 % / −3,4 %,
  z obustronnym −52,1 % / −5,0 %.

- **Wiatr wiał prosto wzdłuż osi patrzenia kamery, przy każdym ładowaniu.** Ziarno świata jest
  stałe, więc wylosowany azymut 242,6° wypadał 10,7° od osi widzenia kamery otwierającej —
  balon nie przecinał kadru, tylko się w nim oddalał i malał. Azymut bazowy jest teraz **autorską
  stałą** (320°, dwa stopnie od prostopadłej do obu kamer otwierających), a komentarz mówi wprost,
  że jest autorska, przeciw którym kamerom i dlaczego nic nie wolno czytać z kamery w czasie
  działania. Po zmianie: 69,9° od osi przy starcie, 68,4° po 90 s, a najbliżej **44,3°** dla
  dowolnego azymutu w klinie — czyli blokada jest arytmetycznie nieosiągalna, a nie tylko mało
  prawdopodobna.
- **Drzewa dostały oś wiatru, a nie jego zwrot.** `windGust` jest sumą sinusów o średniej zero,
  więc korony kołysały się symetrycznie i azymut θ dawał ruch identyczny jak θ+π. Teraz jest stałe
  pochylenie z wiatrem plus drżenie wokół niego. Pierwsza próba naprawy **ścięła zamach o 37,5 %**
  (mierzono szczyt, a człowiek widzi rozpiętość skrajni) — zamach wrócił dokładnie do 3,2, czyli
  tego, co było przed całą funkcją.
- **Deszcz i śnieg były piątym i szóstym konsumentem bez kierunku**, w gałęzi, której cała teza
  brzmi „świat ma jeden wiatr". Rysowana smuga była gorsza niż przesunięcie: jej ogon to zaszyte
  `(0.2, -0.9, 0.1)` — 14° od pionu ku azymutowi 26,6° — podczas gdy komentarz obok twierdził, że
  tor jest 9,1° od pionu wzdłuż wiatru. Dwa różne pochyły, żaden nie czytał drugiego.
- **Domyślny parametr na gnieździe determinizmu**: `stormRandom = fallbackRandom('storm')` cicho
  przypinał burzę do domyślnego ziarna niezależnie od tego, o jaki świat prosił wołający — i już
  się to działo w testach tej samej gałęzi. Podobnie `setExternal(kind, windNorm = 0)`, wołane
  jednym argumentem przez `debugSetImmediate`, przez co każdy checkpoint prosił po cichu o ciszę.
- **Trzy komentarze obiecywały więcej, niż kod robi.** Najważniejszy twierdził, że 25-minutowy
  skręt „obnosi wiatr po całej róży" — azymut mieszka w klinie **87,66°**, identycznym dla każdego
  ziarna. Zamiast usunąć zdanie, stała dostała uczciwe uzasadnienie: autoryzuje całą sesję, nie
  pierwsze trzydzieści sekund. Rozszerzenie modelu odrzucono **na piśmie, z powodem**.
- **Deszcz wieje mocniej**: 0,62 → 0,82, i tylko deszcz. Balon i tak nie lata w ulewie — jego
  brama to `cloudCover < 0.4` przy zachmurzeniu 0,92 — co potwierdzono testem, zamiast zmieniać.

- **Burza: chmury błyskają od środka, kiedy pada deszcz.** Nie pioruny — większość wyładowań
  w burzy jest *wewnątrzchmurowych*, więc widz nie widzi rysunku błyskawicy, tylko komórkę,
  która zapala się od środka i gaśnie. Błysk żyje 0,15 s i powtarza się dwa do czterech razy
  co 0,11 s (to migotanie jest tym, co czyta się jako błyskawica, a nie jako rozjaśnienie),
  a burza daje **5,5 błysku na minutę**, nie jeden na sekundę. Rozbłyskuje cała talia trochę,
  a komórka z kanałem najmocniej; niebo i miasto dostają mały dodatek do światła
  wypełniającego, bo burza oświetla też ulicę.
  **Zero nowych draw calli i zero nowych geometrii:** chmury są jedną `InstancedMesh`,
  a `instanceColor` daje jasność na chmurę za darmo. **Determinizm:** harmonogram jest czystą
  funkcją zegara prezentacji i ziarna (`floor(t / 11 s)` wybiera zdarzenie), więc `pinClock`
  potrafi go przeszukać w obie strony, a sekunda, na której fotografowany jest każdy
  checkpoint, leży w gwarantowanej ciszy na początku szczeliny. Poza deszczem burza jest
  **dokładnie** wyłączona — zero, nie „prawie zero" — więc żaden pomiar zaćmienia ani
  bezchmurnego południa się nie rusza.

- **Dwie osie czasu i dwie jednostki kąta są teraz typami, których pilnuje kompilator.**
  `t01` to zegar, którego wschód słońca wędruje z porą roku; faza słoneczna jest kanoniczna
  (0,25 wschód, 0,5 południe, 0,75 zachód). Oba były gołymi `number` w tym samym zakresie 0..1,
  więc zamiana kompilowała się bez szemrania i dawała słońce przesunięte o dwie godziny —
  **sześć razy**, za każdym razem kosztem dnia pracy. Pięć marek: `Clock01`, `WallClock01`,
  `SolarPhase01`, `Radians`, `Degrees`; 612 miejsc w 49 plikach; piętnaście asercji
  `@ts-expect-error`, które wywracają typecheck, jeżeli nazwana przez nie zamiana znów zacznie
  się kompilować.
  **Refaktor jest darmowy co do bajta i to jest sprawdzone, nie zadeklarowane:** chunk wejściowy
  przed i po ma identyczny hash `4057351671d45627` (233 563 B), co potwierdzili niezależnie dwaj
  recenzenci i orkiestrator, budując oba commity osobno. Typy się wymazują, konstruktor by się
  nie wymazał — więc wartości wchodzą w markę przez `as` na granicy, gdzie jednostka jest po raz
  pierwszy znana, a konstruktory dla testów mieszkają w osobnym module, którego nieobecność
  w bundlu pilnuje test grafu importów.
  Siódma instancja siedziała nierozbrojona w `HybridFrame`: `sunT` i `clockT`, dwie sąsiednie
  gołe liczby, których komentarz musiał tłumaczyć, że są różne. Recenzent potwierdził, że zamiana
  jest teraz odrzucana w obie strony.

### Fixed

- **Deszcz i śnieg były piątym i szóstym konsumentem „jednego wiatru świata" bez kierunku.**
  `rainPositions[idx] += slant` i `snowPositions[idx] += (… + wind * 2,4)` ruszały wyłącznie
  w `+x` — dokładnie ta wada, którą ta gałąź naprawiła chmurom — więc przy wichurze podniesionej
  do 0,82 deszcz wiał na wschód, podczas gdy drzewa obok pochylały się 58 stopni gdzie indziej.
  Oba dryfy idą teraz po wspólnym wektorze. **Smuga deszczu to nie sprite, który bywa
  przechylony: to ślad kropli w czasie ekspozycji**, więc geometria odcinka też musiała się
  położyć — i okazało się, że wysyłany odcinek miał na stałe wpisane `(0,2, −0,9, 0,1)`, czyli
  14 stopni od pionu w kierunku 26,6 stopnia, podczas gdy blok dokumentacyjny tej samej gałęzi
  twierdził, że tor ma 9,1 stopnia wzdłuż wiatru. Dwa różne przechyły, żaden nie czytał
  drugiego, i tylko jeden z nich w ogóle się obracał. Odcinek jest teraz równoległy do
  prędkości kropli (iloczyn skalarny z torem 0,99995 zamiast 0,9942; w poziomie 1,000 zamiast
  0,089), a jego **długość została zachowana co do bajta**: 0,927 m, to co wysyłano. Śnieg
  zachowuje własne błądzenie na obu osiach — jest wolniejszy i bardziej błądzi, i to jest to,
  co czyta się jako śnieg — dostał wyłącznie kierunek.

- **Ruch drzew został ścięty o 37,5%, a pochylenie, które za to kupiono, jest podpikselowe.**
  Szczyt wychylenia rzeczywiście się nie zmienił (0,6 + 0,625 · 1,6 = 1,6), ale **szczyt nie
  jest miarą ruchu**: nieprzemieszczony wierzchołek nie jest nigdzie narysowany, więc odległość
  mierzona od niego nie znajduje się na ekranie. To, co widz czyta jako „jak bardzo ruszają się
  drzewa", to **rozpiętość** od dołu do góry wahnięcia — a ta spadła z 3,2 na 2,0. Skala
  fluttera wraca do 1,0: rozpiętość znów wynosi 3,2, dokładnie tyle, ile wysyłano przed
  poprawką kierunku, **i** korona nadal siedzi 0,6 z wiatrem od spoczynku. Te dwie rzeczy nie
  są w konflikcie — pochylenie jest przesunięciem wahnięcia, a rozmiar wahnięcia nie zależy od
  tego, gdzie jest jego środek. Jedyne, co się rusza, to szczyt: 1,6 → 2,2, czyli wierzchołek
  pochylonego drzewa sięgający dalej z wiatrem na szczycie porywu.
  **Zmierzone, nie zadeklarowane** (kamera 50°, klatka 1920×1080, `OPENING_SHOT`, 31 z 46 drzew
  w kadrze, szczyt korony): przy bezchmurnym niebie pochylenie to 0,30 px na medianowym drzewie
  i 0,69 px na najbliższym, przy deszczowej wichurze 1,52 px i 3,55 px (2,76 / 6,44 px na
  szczycie porywu). Pochylenie jest więc naprawdę podpikselowe w ciszy i wyraźne w wichurze —
  i tak ma być: bryza 0,16 nie powinna zginać drzewa w sposób, który widać. Doprowadzenie
  pochylenia do jednego piksela w ciszy wymagałoby wartości około 2,0, czyli **trwałego zgięcia
  większego niż własny szczyt fluttera (1,6)** — drzewa trzymanego mocniej przez ciszę niż
  kiedykolwiek przez poryw. Wybrano wahnięcie: to je właściciel wymienił z nazwy.

- **Domyślny argument na gnieździe determinizmu.** `stormRandom = fallbackRandom('storm')`
  w konstruktorze `Weather` — a `fallbackRandom` to `createWorldRandom()` z
  `DEFAULT_SIMULATION_SEED`, więc **każdy wołający, który pominął czwarty argument, dostawał
  burzę z ziarna domyślnego, niezależnie od tego, o jaki świat prosił**. Działo się to już
  w testach samej gałęzi. Oba źródła losowe są teraz wymagane; ta sama wada raz pozwoliła
  trzem wywołaniom rozgrzewki po cichu wpisać nocną podłogę w gniazdo deklinacji, a objaw
  wypłynął tygodnie później pod cudzą nazwą.

- **Blok dokumentacyjny obiecywał coś, czego model nie potrafi, a test, który to „dowodził",
  mierzył co innego.** Zdanie „25-minutowy zwrot obnosi wiatr po całej róży, więc widz, który
  patrzy, dostaje każdy kierunek" było fałszywe — i to ono kupowało autorskiej stałej licencję.
  `windBearingAt` to baza plus trzy **ograniczone** sinusy, więc namiar jest zamknięty w klinie
  `baza ± 0,765 rad`: **87,7 stopnia, od −83,8° do +3,8°**, zmierzone przez dobę próbkowania
  sześćdziesięciu ziaren przy obu skrajnościach siły, identycznie dla wszystkich z dokładnością
  do 0,05°. Test, który miał to trzymać, mierzył `offViewAxis` — wielkość **składającą** różę
  na zakres 0..90 — i nie odróżniłby wiatru omiatającego 360 stopni od takiego, który nigdy nie
  wychodzi z 88-stopniowego klina; przechodził na obu. Twierdzenie zostało sprowadzone do
  prawdy, a stała dostała uczciwe uzasadnienie: **nie jest namiarem otwarcia, tylko środkiem
  jedynego klina, jaki ten wiatr kiedykolwiek zajmie**, więc autoruje całą sesję, nie pierwsze
  trzydzieści sekund — a każdy namiar w tym klinie leży co najmniej 44,3° od osi widzenia obu
  autorskich kamer, przez co balon cofający się środkiem obrazu jest arytmetycznie nieosiągalny,
  a nie tylko mało prawdopodobny. Cena jest nazwana wprost: wiatr nigdy nie powieje z drugiej
  strony dioramy. Poszerzenie modelu rozważono i odrzucono świadomie — jedyny sposób na całą
  różę przy czystej funkcji zegara to powolny człon o wahnięciu ≥ π, a taki człon przeprowadza
  wiatr przez oś widzenia według rozkładu jazdy, czyli wstawia pierwotny blokujący defekt
  z powrotem, tyle że później.

- **Talia chmur rzedła nad miastem, a własny test gałęzi nie mógł tego zobaczyć.** Powrót na
  dysk losował przesunięcie w poprzek wiatru **jednostajnie** po ±0,75 R — a jednostajny profil
  wejścia to jednostajna gęstość powierzchniowa w stanie ustalonym, więc talia rozlewała się
  z pudełka, w którym jest rozkładana (260 × 240 m, 62 400 m²), na cały omiatany pas dysku
  (87 104 m²) i **rozcieńczała się przy tym o 28%**. Test asertował `spanX > 120 && spanZ > 120`,
  czyli jedyną statystykę, która nie odróżnia „rozłożone szerzej" od „rozłożone rzadziej":
  jedno i drugie ją powiększa. Losowanie jest teraz zaginane do rozkładu **trójkątnego** —
  `sign(u)·(1 − √(1 − |u|))`, monotoniczne, z punktami stałymi w −1, 0 i +1 — więc talia jest
  najgęstsza wzdłuż linii przez miasto i przerzedza się ku krawędzi nieba, czyli wygląda jak
  autorskie pudełko, tyle że jako stan ustalony, a nie jako układ początkowy, który się
  rozpada. Zmierzony udział rysowanych kłębów nad miastem, godzina na ziarno, dwanaście ziaren:
  **0,233 przed (0,72 gęstości autorskiej), 0,320 po (0,99)**. Jedno losowanie na recykling,
  tak jak było — strumień pogody jest pozycyjny.

- **Listonosz wyjeżdżał o 6:43 niezależnie od pory roku — ósma instancja, pierwsza znaleziona
  przez typy, a nie przez człowieka.** `MORNING_START = 0,28` pod nagłówkiem modułu „codziennie
  o świcie", porównywane z zegarem. 0,28 to ten sam autorski literał, którego rozdział trasy
  „golden hour" używa jako **fazy**. Czytane jako zegar: w czerwcu wyjazd trzy godziny po
  wschodzie o 3:44, w październiku po ciemku przed wschodem o 6:50. Teraz trasa czyta fazę:
  czerwiec 4:43, jesień 7:27.
- **Cztery marki były przybite pod wołającego, a nie pod znaczenie, i jedna odrzucała poprawny
  kod.** `CityRhythm` planuje **godzinę** — jego stałe to minuty zegara ściennego, 390 do 430 to
  6:30–7:10 — a brał `Clock01`, przez co `residentialWindowActivityAt(clockT, cohort)`, czyli
  wywołanie prawidłowe, było błędem typu. Marka, która kieruje czytelnika w stronę błędu, jest
  gorsza niż jej brak. Trzy przejścia między osiami są teraz jawne i do wygrepowania, zapisane
  idiomem `as number as`, którego `RealTimeSync.getCycleT` już używał.
- **Cień słońca miał dwóch właścicieli.** `setQuality` pisał `castShadow` bramką, która nie wie
  o chmurach ani o zaćmieniu, a pętla klatki bramką, która wie — więc między zmianą jakości
  a następną klatką dało się dostać twardy cień południa w deszczu albo w totalności. Jakość
  może teraz cień tylko zgasić.
- **Dwa komentarze obiecywały strażników, których nikt nie napisał.** `units.testing.ts`
  twierdził, że jego nieobecność w bundlu pilnuje hash chunku wejściowego — a żaden hash
  odniesienia nie jest nigdzie w repozytorium przechowywany. Pilnują tego teraz trzy prawdziwe
  testy, każdy dowiedziony przez wstawienie defektu z powrotem.

- **Zaćmienie, którego naprawdę widać.** Cztery rzeczy zmierzone na zbudowanym produkcie
  z przyszpiloną pogodą, kamerą `focusEclipseView`, bezstratnym PNG.
  - **Niebo traci światło, zamiast być domalowane na ciemno.** Kopuła była przenikaniem
    (`mix`), a przenikanie nie potrafi przygasić nieba: przy totalności zostawało **14,2 %**
    pełnej jasności dziennej kopuły, a ta jedna siódma nieba niosła **cztery piąte** światła
    kadru. Teraz to tłumienie plus dodawana łuna, a kopuła jest mnożona przez przetrwały
    strumień słoneczny.
  - **Cień ma kierunek.** Obręcz przy horyzoncie była jednakowa we wszystkich azymutach.
    Ślad umbry to elipsa 159 km w poprzek azymutu słońca na 159/sin(wysokość) wzdłuż niego —
    **6,5:1** przy tutejszym słońcu 8,83° — i jedna odległość do ściany cienia na azymut
    prowadzi teraz barwę, jasność i wysokość obręczy naraz, przez `exp(-beta*L - L*tan(θ)/8 km)`.
    Jasna łuna obraca się o 180° między drugim a trzecim kontaktem, bo obserwator przechodzi
    przez cień. Niezależny recenzent przeskanował 130 tys. kierunków w czterech fazach: nic
    nie dochodzi do bieli i nic nie jest `rgb(0,0,0)`.
  - **Korona dodaje światło, zamiast wycinać dziurę.** Warstwa słoneczna była
    `NormalBlending`, więc korona nie dodawała się do nieba, tylko je zastępowała — a że
    profil szedł i w kolor, i w alfę, emitowane światło leciało jak **kwadrat**: 48× autorskiego
    spadku stawało się 2301×, a wszystko poza 2,6 promienia słonecznego znikało.
  - **Ludziki patrzą na słońce.** Średni kąt między twarzą a kierunkiem na słońce spadł
    z **82,9° do 3,8°** w kohorcie z okularami; wszystkie miały wcześniej ten sam zaszyty
    pochył 33,2° przy słońcu na 8,8°. Okulary spadają na totalność i wracają na pierścień
    diamentowy, zgodnie z jedyną regułą, którą zna każdy obserwator.

### Fixed

- **`MINIMUM_IRRADIANCE` trzymał zaćmienie jasnym, na dwa sposoby.** Przez *całą* rampę
  totalności — zakrycie 0,985 do 1,0 — naświetlenie spadało tylko z 0,02915 do 0,02500,
  czternaście procent, bo podłoga dominowała człon `(1-zakrycie)^1,3` na długo przed końcem.
  Każdy człon dodawany, bramkowany `totality`, idzie w tym samym przedziale od 0 do 1, więc
  świat **jaśniał o 35 %**, gdy księżyc kończył zakrywać słońce, a najciemniejszą klatką
  zaćmienia był drugi kontakt. Drugi skutek: z ukrytym billboardem niebo tuż przy słońcu nadal
  czytało **236 z 255** przy totalności, bo lob rozproszeniowy Preethama przy niskim słońcu
  jest rzędu 1000 w jednostkach liniowych, a 2,5 % z tysiąca to wciąż biel. Korona nie była za
  słaba — niebo za nią było za jasne.

  | totalność ÷ ta sama godzina bez zaćmienia | przed | po |
  |---|---|---|
  | cały kadr | 0,274 | **0,096** |
  | miasto | 0,243 | **0,239** |
  | niebo | 0,333 | **0,087** |
  | niebo tuż przy słońcu (poziomy) | 234,7 | **108,9** |
  | tarcza względem nieba obok niej | 1,08× | **1,53×** |
  | piksele dosłownie czarne | 0,0000 % | **0,0000 %** |

  Miasto prawie nie drgnęło, bo `eclipseDiffuseFraction` ma własną podłogę 0,13: to gasi niebo
  i wiązkę bezpośrednią, która przy totalności i tak jest geometrycznie zerowa.

- **Księżyc był w dziesięciu procentach przezroczysty.** Jego alfa niosła człon zachmurzenia,
  `mix(0.35, 1.0, uTransmittance)`, a „czysta" pogoda w tym świecie to zachmurzenie 0,12 — więc
  w bezchmurny dzień tarcza była przepuszczalna, a dziesięć procent obciętego nieba wypełniało
  kęs do **218** przy niebie 254. To było całe wyjaśnienie, dlaczego faza częściowa nie miała
  widocznego kęsa. Po naprawie: **7**. Chmura przed księżycem nie robi księżyca przezroczystym.

- **Chunk `atmosphere-physics` przekraczał swój próg od 1431376.** Przeniesienie
  `RainbowAtmosphere` do chunku ładowanego eagerly zdjęło 11 521 bajtów z bramki, która patrzy,
  i położyło je pod bramkę, której nie sprawdzono: pierwsze ładowanie ważyło 252 577 B przed
  i 252 635 B po, czyli podział nie oszczędził niczego, a smoke stał czerwony na **pierwszej**
  asercji, więc nic za nią nie chodziło. Tęcza pojawia się dopiero po deszczu, więc nie
  należy do pierwszego ładowania: jest pobierana przy pierwszej wilgoci w powietrzu, za
  uśpionym obiektem zastępczym.

  | | entry | atmosphere-physics | pierwsze ładowanie |
  |---|---|---|---|
  | przed | 238 049 | 17 978 (próg 9 000) | 1 281 381 |
  | po | **230 562** | **6 457** | **1 271 863** |

- **Rozgrzewka tęczy nie rozgrzewała niczego.** `ensureRainbow` składało jedną klatkę poza
  pętlą, żeby zbudować program atmosfery przed pojawieniem się łuku. Nie mogło:
  `presentWorld` ustawia `setAtmosphereEnabled(rainbow.isEffectActive())` co klatkę, uśpiony
  obiekt odpowiada `false`, więc przebieg był dodany już wyłączony, a kompozytor `postprocessing`
  otwiera pętlę od `if (!pass.enabled) continue`. Shader kompilował się i tak na pierwszej
  klatce z tęczą. Dodatkowa kompozycja nie była darmowa: drugi pełny łańcuch na już
  wyświetlonym stanie świata, duplikat wmieszany w historię rozdzielczości czasowej i liczniki
  przebiegu metryk nadpisane poza kolejnością.

- **Tułów skakał o 343,71° w jednej klatce na pierścieniu diamentowym.** Ujednolicenie azymutu
  kohorty z kartką sprawiło, że zaczął przemiatać — wewnątrz `wrapPi`, które jest nieciągłe.
  Żaden istniejący test nie mógł tego zobaczyć: wszystkie próbkowały dwa statyczne stany
  i sprawdzały kąt twarzy do słońca, z którego tułów i głowa dokładnie się skracają.

- **Promień pionowy nie miał ściany cienia.** `direction.xz / (length + 1e-4)` daje `vec2(0)`
  dla promienia o dokładnie zerowej składowej poziomej, więc odległość do ściany wychodziła
  zerowa — obserwator *stojący na ścianie umbry*, jedyny stan, którego `UMBRA_TRAVERSE_LIMIT`
  ma zabraniać, gdzie `exp(-0*x)` to 1 i obręcz osiąga pełne wzmocnienie. Granica przy promieniu
  pionowym to ściana nieskończenie daleka, więc kod zwracał jej przeciwieństwo.

- **Zmierzch na kopule nieba: cień Ziemi i Pas Wenus, przejęte dokładnie tam, gdzie
  Preetham gaśnie.** Three.js liczy całe rozpraszanie z `vSunE`, które przy
  `cutoffAngle = 1.6110731556870734` jest **dokładnie zerem od 2,30769 stopnia pod
  horyzontem** — 61% zmierzchu cywilnego bez kopuły. Trzecia łatka na tym samym znaczniku
  (`withTwilightDome`, nakładana **przed** `withRadianceCeiling`, bo jako jedyna z trzech
  *dodaje* radiancję; łatka odmawia założenia po zacisku) dokłada model ozonowy z
  `SunlightSpectrum`: barwa zenitu z `twilightSkyColorCached` (0,231 0,541 1,000 przez cały
  zmierzch cywilny), barwa pasa z `beamTransmittanceColor(0)` (1,0000 0,1881 0,0000 — jedyna
  droga zmierzchowa, która przechodzi *pod* ozonem). Przekazanie jest dokładnym dopełnieniem
  `1 − vSunE(e)/vSunE(0)`: 0 na horyzoncie, 0,430 przy −1°, 0,865 przy −2°, 1 przy −2,30769°,
  a nad horyzontem **dokładnie zero**, więc dzień jest bit w bit ten sam.
- **Gradient pionowy nad antysłonecznym horyzontem wreszcie właściwą stroną.** Zmierzone na
  żywej kopule, słońce −3,00°, radiancja liniowa: R/B **0,588 na 3°** i **1,413 na 12°**
  (przedtem 0,588 i 2,190; odniesienie z audytu przy słońcu +0,5°: 3,96 i 1,14 — tu
  odtworzone niezależnie jako 3,74 i 0,94). Poniżej 3° człon nie dokłada nic: to cień Ziemi.
  Horyzont po stronie słońca zyskał 13,5× jasności i się ocieplił (R/B 0,596 → 1,522) —
  łuk zmierzchowy, którego Preetham w ogóle nie rysował.
- **Czego to nie naprawiło, i to jest ta połowa, którą widać.** Prezentowana klatka przy
  zmierzchu cywilnym dalej jest czarna, ale już nie przez kopułę: przy słońcu −3,79° pas
  nieba w kadrze daje 0,0296 z członem i 0,0302 bez, czyli poniżej szumu przyrządu, przy
  czym ten sam pas z członem wymuszonym na czerwono daje 49,3. Kopuła musiałaby być około
  **pięćdziesiąt razy** jaśniejsza od fizycznej, żeby ACES plus grade dały jeden poziom
  luminancji — to rejon punktu 13 (`sceneExposure` 0,362 przy −3,8° wobec 0,394 w południe).
  Szczegóły i krzywa przenoszenia w `docs/next-steps.md`, punkt 12.
- **Akumulacja czasowa za flagą `?taa=1`, domyślnie wyłączona i na razie nieskuteczna.**
  Jitter projekcji po sekwencji Haltona, reprojekcja z bufora głębi po macierzy poprzedniej
  klatki, zaciskanie historii do sąsiedztwa 3×3, historia w ping-pongu, wstawione po
  okluzji i przed bloomem. Powód, dla którego w ogóle powstała: w konfiguracji właściciela
  (bufor 1584×722 rozciągany na 2880×1314, profil `medium`, domyślny kadr 96 m, czyli
  8 pikseli na metr) **nic tańszego nie ruszyło migotania** — rozdzielczość jest płaska w
  całym zakresie (reszta 2,75 przy 1,15; 3,04 przy 2,0; 2,78 przy 2,6), okluzja 0,00,
  bloom 0,00, MSAA 3% za +1,9 ms, preset SMAA 0,7%. Najgorętszy kafel to jedna ukośna
  linia szerokości 1–2 pikseli na tle nieba.
- **I nie działa, co też jest zmierzone, nie podejrzewane.** Przy nieruchomej kamerze i
  dziewięćdziesięciu klatkach na zbieżność udział pikseli pośrednich na tej krawędzi —
  sygnatura wygładzenia — zmienił się z 2,337% na 2,367%, czyli o nic. Przebieg działa
  (309 klatek, 1 reset, ~+3 ms), tylko rozwiązuje się do niemal dokładnie klatki bieżącej.
  Diagnoza, na ile doszła: historia próbkowana dwuliniowo rozmywa się z każdą klatką, a
  zaciskanie do sąsiedztwa ściąga rozmytą historię z powrotem do bieżącego piksela.
  Lekarstwa są znane — próbkowanie Catmulla-Roma zamiast dwuliniowego i zaciskanie po
  wariancji zamiast min/max — i żadne z nich nie jest tu zrobione. Zostaje za flagą,
  z budżetem nietkniętym (własny chunk `temporal-resolve`, wiązka wejściowa 243,12 kB).
- Wycofany przyrząd: **reszta po kompensacji ruchu nie nadaje się do oceny obrazu
  akumulowanego.** Porównuje klatkę N z N−1 przesuniętą o znany wektor, a klatka
  akumulowana zawiera mieszankę dziesięciu klatek o dziesięciu różnych przesunięciach.
  Punktowała ten przebieg gorzej przy obrazie nie mniej stabilnym.

### Changed

- **Chmury odpowiadają wiatrowi, a w deszczu wieje wichura.** Talia była czwartym
  konsumentem bez kierunku: `cloud.x += ...` znosiło każdą chmurę ku +x, w każdej pogodzie,
  na zawsze — więc przy wietrze z północy drzewa, dym i balon szły na południe, a niebo
  dalej przecinało kadr z zachodu na wschód. Teraz talia jedzie po tym samym wektorze,
  z zachowaniem własnej prędkości każdej chmury, a zawracanie jest **niezależne od
  kierunku**: świat chmur to koło o promieniu 180 m, a chmura wraca na jego nawietrzną
  krawędź ze świeżym przesunięciem w poprzek wiatru. Stare zawijanie było napisane dla
  osi +x i na każdym innym kursie zsypałoby talię w róg.
  Wiatr w deszczu: **0,62 → 0,82** (pozostałe cztery pogody bez zmian). To 32 % mocniej
  wszędzie: liście, smuga z komina i znoszenie strug deszczu (ślad kropli 6,9° → 9,1° od
  pionu, 16,2° w szczycie porywu). Balon i tak nie lata w deszczu — bramkuje go zachmurzenie
  0,92 przy progu 0,4 — i teraz pilnuje tego test, zamiast zbiegu okoliczności.
- **Plac zabaw nad jeziorem zamiast placeholdera.** Stało tam pięć na pięć wokseli w
  kolorze `accent`, jeden niebieski słupek i cztery różowe kostki po przekątnej, które
  miały być zjeżdżalnią; płyta siedziała na całym wokselu, więc jej wierzch był 0,5 m nad
  chodnikiem. Teraz: rurowa zjeżdżalnia — podest 1,20 m, wybieg 2,00 m, czyli **31°** i
  ślizg 2,33 m, drabinka o trzech szczeblach, pałąk do trzymania, burty z rurki ∅ 50 mm
  przy krawędzi ślizgu — oraz huśtawka z belką 2,20 m i dwoma siedziskami na 0,45 m.
  Wszystko na gruncie, na piaskowej strefie upadku równo z trawą.
- **Huśtawki bujają się wiatrem, z okresem wahadła.** Nie dowolna sinusoida: łańcuch ma
  1,75 m, więc T = 2π√(L/g) = **2,65 s**, i oba siedziska dzielą ten okres dokładnie —
  różni je faza, nie prędkość. Amplituda do 6° przy pełnym wietrze, czyli 18 cm; w pogodzie,
  którą świat naprawdę produkuje, wychodzi 0,96° pogodnie, 1,80° w śniegu i 3,72° w deszczu.
  Ruch liczy się z zegara symulacji, więc checkpoint go zamraża.
- Plac zabaw mieści się w istniejącej rezerwacji 6×4 m i to jest wymóg, nie zbieg
  okoliczności: `isPlaceableProp` odrzuca kandydatów na drzewa bliżej niż 3,5 m od
  rezerwacji, a 46 pozycji drzew jest przez niego generowanych — szersza działka
  przelosowałaby cały park. Sprzęt dopasowano do działki, nie odwrotnie.
- W Cyberpunku ten sam stelaż świeci: rurki na cyjan, ślizg na magentę. Bez dodatkowej
  geometrii i bez drugiego zestawu bryły — zmienia się emisja materiałów, a moduł neonu
  ładuje się dopiero przy pierwszym morfie i siedzi w chunku `cyber-style`.
- Cały plac to **dwie geometrie** (jedna rurka, jedno pudełko) i sześć wywołań rysowania.
  Nic cieńszego od tekstela mapy cieni nie rzuca cienia: rurka ∅ 50 mm to jedna trzecia
  tekstela, czyli dokładnie ta klasa artefaktu, którą usunięto spod parapetów.
- Nowa grupa chunków `playground`: moduł ma 5,6 kB, a wiązce wejściowej zostało 1,1 kB
  z 244 000 B. Budżet **nie został podniesiony** — wzrost jest widoczny w osobnym pliku,
  tak samo jak przy `cyber-style` i `experience-signals`.

### Fixed

- **Zęby pod parapetami.** Cień parapetu to jedna trzecia tekstela mapy cieni, więc mapa
  nie potrafi go narysować: na ścianie pod każdym oknem leżał rząd odklejonych, ukośnych
  schodków. `normalBias` liczy się teraz z rozmiaru tekstela (1,5 tekstela), a nie ze
  stałej w metrach. Zmierzone przy teksteli 0,136 m: 0,05 m nie ruszało zębów, 0,12 m je
  osłabiało, 0,2 m usuwało; duże cienie — drzewa, bloki na trawie — zostały, kosztem 2,1%
  pikseli widoku ulicy i 0,24 z 255 średniej jasności. To usunięcie cienia, którego nie da
  się narysować, a nie zakup rozdzielczości, która by go narysowała: żaden budżet się nie
  ruszył.
- **Siatka cieni przestaje płynąć po świecie.** Ognisko mapy cieni jest zaokrąglane do
  całych teksteli w bazie światła, więc krawędź, która jest schodkowa, pozostaje schodkowa
  w tym samym miejscu, zamiast przesuwać się przy ruchu kamery. Własność geometryczna ma
  test: ognisko przesuwane co dziesiątą tekstela albo nie rusza się wcale, albo skacze o
  cały tekstel, i nigdy pomiędzy.
- **Spoiny płyt nie migoczą na dystansie.** Przejście spoiny było stałe w metrach (5 cm),
  a piksel przeglądu obejmuje 0,2 m, więc wzór był próbkowany raz na kilka swoich szerokości.
  Szerokość przejścia bierze się teraz z pochodnej na piksel i wygasza wzór, gdy piksel
  obejmuje kilka szerokości spoiny. Dotyczy spoin elewacji i fugowania chodnika.
- **Daleki widok nadpróbkowuje: do 1,3× rozdzielczości ekranu na osi, w granicach
  zmierzonego budżetu pikseli (patrz punkt niżej).** Był mnożony
  przez 0,8, czyli na High spadał do 1,0 i Retina rozciągała go dwukrotnie — najbardziej
  rozmyty obraz w produkcie dokładnie w widoku o najdrobniejszym detalu. Samo zrównanie do
  ekranu (2,0) też nie jest odpowiedzią i to jest korekta wcześniejszej wersji tej zmiany:
  wygląda dobrze, ale jest **mniej stabilne** niż rozmycie, które zastąpiło, bo upscaling
  nie potrafi migotać, a rozdzielone szczegóły podpikselowego miasta potrafią. Mierzone na
  obrazie prezentowanym, przy obrocie kamery o cztery piksele ekranu, pikseli skaczących
  >24 poziomy: 0,50% przy 1,0, 0,89% przy 2,0, znów 0,50% przy 2,6 — i to ostatnie jest
  zarazem ostre. 2,6 to miejsce, w którym krzywa przestaje się opłacać: 3,2 daje 2,6%
  stabilności więcej za trzykrotność klatki. Mediana GPU 12,35 ms w dzień, 11,18 ms w nocy,
  11,78 ms o zmierzchu, przy budżecie 16,7 ms; 5 z 5 parowanych stanów lepszych.
- **Bufor dalekiego widoku jest ograniczony liczbą pikseli, nie tylko współczynnikiem.**
  Sam współczynnik nie jest budżetem i traktowanie go tak było defektem poprzedniej
  rewizji: 2,6 zmierzono przy jednym kadrze — 1440×900 i dSF 2, czyli 8,76 Mpx i 12,35 ms
  — a ten sam 2,6 zamawia w oknie 2560×1440 **24,9 Mpx**, a na iPadzie w pionie 9,45 Mpx.
  Żadnej z tych liczb nikt nie postawił przed kartą. Teraz obowiązuje reguła „nigdy więcej
  pikseli niż zmierzono": przy 1440×900 wychodzi 2,60 i nie zmienia się nic, a wszystko
  większe schodzi do tego pułapu. Ograniczenie pilnuje pamięci i ilości pracy — nie wie
  nic o wydajności karty.
- Bliski widok zostaje przy 1,15 i nie jest to przeoczenie: przy 1,6 dzienna ulica kosztuje
  15,14 ms z 16,7, zbliżenie 17,87 ms, a nocna ulica 58,84 ms, bo jest ograniczona
  wypełnieniem szesnastu świateł. Jego niestabilność jest realna i zmierzona — 0,89%
  pikseli elewacji przy 1,15 wobec 0,20% przy 1,6 — i zostaje do czasu, gdy bliska klatka
  stanieje.
- MSAA i presety SMAA rozważone i odrzucone z pomiarem parowanym, nie z przekonania.
  MSAA 4 poprawia resztę po kompensacji ruchu o 3,1% w dzień i 3,8% w nocy w dalekim
  widoku, a na elewacji nie poprawia wcale — za +1,9 ms; na nocnej ulicy podnosi klatkę z
  24,4 do 37–44 ms. SMAA ULTRA daje 0,7%. `msaaSamples` pozostaje 0 we wszystkich profilach.
  Ablacja: cienie odpowiadają za 3% reszty, dithering za 0,8%, `PCFSoftShadowMap` za nic —
  żadna pojedyncza przyczyna nie dominuje, dominuje rozdzielczość.

### Removed

- **Suwak prędkości i wszystko, co go dotyczyło**: kontrolka w panelu, jej styl, obsługa
  `←`/`→`, `speedSetting`, `onSpeedChange`, mnożnik prędkości w pętli klatki, parametr
  `speedMultiplier` w `Train.update` oraz nieużywane `getSpeedFactor`. Prędkość przelotowa
  pociągu została taka, jaka była: domyślne 58/100 dawało 1,254 × 10 m/s, więc bazowa
  prędkość to teraz 12,5 m/s. Usunięto kontrolkę, nie spowolniono miasta.

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
