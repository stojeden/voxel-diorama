# Raport ze spike'u hybrydy — Osiedle Centralne

Gałąź `worktree-spike-hybrid-osiedle-centralne`, stan na 2 września 2026.
Spike miał się skończyć renderami, pomiarami i **jedną rekomendacją**. Rekomendacja jest
w rozdziale 8. Decyzja należy do właściciela; żadna strategia nie została usunięta.

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

Kadry (28 plików JPEG) nie są commitowane, zgodnie z konwencją poprzedniego agenta —
odtwarza je pierwsze polecenie. Pomiary są w repo: `spike-smoke.json`,
`spike-smoke-voxel.json`, `spike-semantics.json`, `bench-<świat>-<jakość>.json`.

Strona dla właściciela (ten sam werdykt, wizualnie, po polsku):
**https://claude.ai/code/artifact/77c565b1-517d-4e7d-b1b4-38e8873b2c9c**
Źródło strony leży w `verdict-page/page.html` z placeholderami `{{IMG_*}}`; wycinki kadrów
składa `verdict-page/crops.py`, a potem podstawia się je jako `data:` URI pod te placeholdery.

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
| (b) autobus nie stoi na zebrze | **spełnione, z zapasem 6,60 m** | `busDwellEnvelope(BUS_STOPS[0])` = x[−17,80; −9,80], `CROSSWALK` = x[−3,20; −1,80]. Odstęp 6,60 m. Asercja `checkModel` zielona w każdym z 12 kadrów. |
| (c) mieszkaniec jest czytelny | **niespełnione — ale nie z winy spike'u** | Postać to pionowy pasek ~10 px zasłonięty własną ścianą reklamową wiaty. Identyczny pasek i identyczna zasłona są w kadrze bazowym `voxel-high-spike-street.jpg`. Naprawa jest po stronie kadru albo produktu, nie meshingu. |
| (d) witryny mają proceduralną treść | **spełnione tylko w `hybrid-direct` na High** | Direct/High: trzy bryły towaru za szybą (zielona, różowa, beżowa). Direct/Low: towar to warstwa 2, więc znika — witryna czyta się jak zabity lokal. Greedy/High: zamiast towaru gęsta ukośna kraciura z-fightingu. |
| (e) ekspozycja nie wypala dalszego planu | **kadr uliczny jest częściowo wypalony — identycznie jak produkt** | W pasie (491,440)–(1371,507) piksele z wszystkimi kanałami ≥250: voxel **6382**, direct **6355**, greedy **6357** z 58 960 (10,8%). Overview, golden i night są czyste. Spike tego nie powoduje i nie pogarsza. |

### 2.1 Co znaleźliśmy poza listą kryteriów

**B1-1 (direct) — na LOD 0 budynek jest pustym pudełkiem.** Bryła to jedno
`E.box(b.tint, …, { layer: 0 })` plus cokół; wszystkie otwory są w warstwie ≥ 1
(`architecture.ts:143-144`). Każdy klaster, który spadnie do poziomu 0, traci więc wszystkie
okna. W kadrze overview płyta bloku 3 stoi jako gładka szara skrzynia obok voxelowych bloków,
które na tej samej odległości nadal mają pasy okien. To nie błąd implementacji — to zbyt
pusty najniższy poziom.

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

**B1-5 (model, obie strategie) — pasy zebry są obrócone o 90°.** Aleja Południowa to
`ROAD_RECTS[0]` = x[−64; 64] × z[22; 26], więc ruch idzie wzdłuż x. `CROSSWALK` =
x[−3,20; −1,80] × z[22; 26] jest poprawne: chodnik szerokości 1,4 m przez jezdnię szerokości
4 m. Ale `emitStreetscape` kładzie każdy pas jako `2.4 × 0.012 × 0.5` — **2,4 m wzdłuż jezdni
i 0,5 m w poprzek**, powtarzane w poprzek jezdni. Pasy biegną więc równolegle do ruchu,
układają się w drabinę przez jezdnię i wystają 0,5 m poza chodnik z każdej strony. Prawdziwa
zebra ma pasy wzdłuż kierunku przejścia, powtarzane wzdłuż jezdni.

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

| Świat | High | Low | Próg |
|---|---|---|---|
| voxel | 890–1029 ms | 644–961 ms | 1800 ms |
| hybrid-direct | **988–1266 ms** | 710–1094 ms | 1800 ms |
| hybrid-greedy | **1970–2176 ms** | 1726–2028 ms | 1800 ms |

`hybrid-greedy` przekracza budżet w **każdym** kadrze na High (1970, 2028, 2176, 2130 ms) i w
dwóch z czterech na Low (golden 2028 ms, night 1995 ms; overview i street mieszczą się o
włos, 1727 i 1726 ms). Direct dokłada 100–240 ms i najgorszy jego przypadek — golden 1266 ms —
ma jeszcze 534 ms zapasu.

Uczciwa uwaga o narzędziu: asercja TTI w `performanceBenchmark.mjs` nadal patrzy na stary,
bezświatowy pomiar, więc wszystkie sześć uruchomień kończy się kodem 0, mimo że greedy jest
poza budżetem. Nie zaostrzyłem tej asercji, bo objęłaby też własne kadry produktu, a to
zmiana zakresu i ryzyko flake'u w CI. Zostawiam to jako jawną decyzję do podjęcia.

### 3.4 Generacja i pamięć GPU

| | Generacja fragmentu | `hybrid.bytes` | `dilated` |
|---|---|---|---|
| direct | **23–26 ms** | 2 985 984 B (2,99 MB) | 0 |
| greedy | **919–1033 ms** | 4 116 096 B (4,12 MB) | 2957 |

Greedy jest ~40× wolniejszy w generacji i zajmuje o 38% więcej pamięci GPU. Płaci tym za
voxelowe AO „za darmo" — którego direct nie potrzebuje, bo wypieka `aAo` na etapie emitera.

### 3.5 Jedna anomalia, którą trzeba nazwać

Timer GPU w kadrze nocnym raportuje p90 daleko poza 20,5 ms: voxel 48,9 ms, direct 64,1 ms,
greedy 67,0 ms — przy klatce 16,8 ms i 60 FPS. Sprzeczność jest pozorna: zapytanie obejmuje
jedną jawną klatkę kompozytora razem z aktualizacją cieni świateł lokalnych, których w stanie
ustalonym nie przeliczamy co klatkę. Dwie rzeczy są jednak prawdziwe i warte zapisania:

- próg 20,5 ms jest już przekroczony **w produkcie** (48,9 ms), więc ta metryka nie jest
  bramką spike'u i nie była nią wcześniej;
- delta hybrydy jest realna: **+15,2 ms (direct) i +18,1 ms (greedy)** względem produktu, i nie
  została wyjaśniona. To pass normalnych SSAO plus światła lokalne w kadrze ulicznym. Przed
  jakimkolwiek rozszerzeniem na drugi fragment ten pomiar zasługuje na osobne przyjrzenie się.

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

Mimo tego **fragment czyta się o świcie jako niezamieszkany**, a miasto wokół niego jest
zapalone. Powód nie jest w kohortach, jest w materiale: voxelowe okno nosi stan zapalenia w
kolorze rozproszonym na materiale o `metalness 0.4` (60% udziału diffuse), a szkło hybrydy ma
`metalness 0.85` (15%). W całym pasie dziennym i świtowym, gdzie emisja jest znikoma, cały
efekt „zapalone" niesie diffuse — i hybryda gubi go czterokrotnie.

Poprawka to jedna liczba, ale jest zmianą art directionu, więc jej **nie wprowadziłem**.
Zostaje jako pozycja do decyzji.

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
| `index-*.js` | **238 673 B** | 240 000 B | 1 327 B |
| `main-*.js` | **33 311 B** | 50 000 B | 16 689 B |
| `hybrid-spike-*.js` | 41 008 B | — (dynamic import) | — |

Dodatek do chunku wejściowego względem stanu przekazania: +84 B. `lodPixelsPerMetre` wpadło
do chunku spike'u (40 953 → 41 008 B), nie do wejściowego. Żaden budżet nie został podniesiony.

## 8. Rekomendacja

**Kontynuujemy kierunek hybrydowy strategią bezpośrednią. Do usunięcia jest
`GreedyVoxelStrategy` — ale nie usuwam jej, to decyzja właściciela.**

Za direct:

- mieści się we wszystkich progach bramki 2, w tym w TTI z zapasem ≥ 530 ms;
- generuje fragment w 23–26 ms, czyli poniżej dwóch klatek;
- oszczędza 27 tys. trójkątów względem voxeli, które zastępuje;
- dotrzymuje kontraktu addytywnych warstw: bryła jest zamknięta na każdym poziomie;
- daje czytelne rowery, balustrady, szprosy i towar w witrynie — dokładnie to, za co
  zatwierdzono ten kierunek.

Przeciw greedy — każdy punkt osobno wystarczy:

- **przekracza budżet TTI** (1970–2176 ms wobec 1800) w każdym kadrze na High;
- **łamie kontrakt LOD**: na poziomie 0 przez budynek widać świat, i to nie jest do
  poprawienia bez przepisania kullingu ścianek na świadomy warstw;
- **niszczy wszystko cieńsze niż 25 cm**: 2957 zdylatowanych wymiarów, rowery jako stos
  klocków, pasy zebry jako bloki na jezdni;
- **z-fightuje** na każdej płaszczyźnie opartej o mały offset (szyby, drzwi, rolety);
- 40× dłuższa generacja i +38% pamięci GPU;
- jedyna korzyść — voxelowe AO — jest już dostępna w direct jako wypiekany atrybut `aAo`.

Ale kierunek **nie jest gotowy do wdrożenia w tym stanie**. Trzy rzeczy po naszej stronie do
zrobienia przed drugim fragmentem, w tej kolejności:

1. **Wypełnić LOD 0.** Bryła bez okien czyta się jak niedokończony model obok voxelowych
   bloków, które na tej odległości okna mają. Najtaniej: wypiekany pas okien w warstwie 0.
2. **Obrócić zebrę o 90°** i zawęzić pasy do szerokości przejścia (B1-5).
3. **Zdjąć metalness ze szkła** albo dołożyć diffuse do stanu zapalenia, żeby fragment nie był
   ciemny w pasie dziennym i świtowym (4.1).

I trzy rzeczy odziedziczone z produktu, które spike wyciągnął na wierzch, a których nie może
naprawić z wnętrza fragmentu — do osobnej decyzji:

4. Chodnik przy Osiedlu Centralnym ma metr szerokości; wiata, ławka i pasażerowie stoją na
   trawie (B1-6).
5. Pasażer jest zasłonięty ścianą reklamową własnej wiaty w każdym kadrze ulicznym (kryterium c).
6. Horyzont w kadrze ulicznym jest wypalony na 10,8% pasa (kryterium e).

## 9. Czego świadomie nie zrobiliśmy

Fragmentu nie rozszerzaliśmy. Drzew, kiosku i wiaty w nowym języku nie dodawaliśmy — w kadrach
widać, że zostały voxelowe, i to było w zakresie. Mrugania świateł ani transmisji wieży nie
implementowaliśmy. Budżetów nie podnieśliśmy. `Checkpoints.ts` i `WorldLayout.ts` nietknięte.
Przegranej strategii nie usunęliśmy. Asercji TTI w benchmarku nie zaostrzyliśmy — powód w 3.3.
