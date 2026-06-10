# 🚂 Trans City Express — Voxel Diorama

> Żywa, voxelowa diorama miasta w przeglądarce: pociąg przejeżdżający przez kwantowe portale, pełny cykl dnia z prawdziwym golden hour, losowa pogoda z zalegającym śniegiem, a do tego krowa porywana nocą przez UFO. Three.js + TypeScript, 60 FPS na MacBooku M1.
>
> *A living voxel city diorama in the browser — day/night cycle, weather, themed morphing (including a full Cyberpunk transformation) and a cast of tiny story actors.*

| Zmierzch nad miastem | Morfing Cyberpunk |
|---|---|
| ![Golden hour](docs/screenshot-golden-hour.jpg) | ![Cyberpunk](docs/screenshot-cyberpunk.jpg) |

## ✨ Co tu żyje

### Świat i pojazdy
- **Pociąg** na gładkiej trasie (krzywizna pilnowana testami — zero „łamania" wagonów), z wózkami wagonowymi, reflektorami oświetlającymi tory nocą i przystankami, na których pasażerowie wsiadają do wagonów.
- **Tunele-portale** — skład wjeżdża do wschodniego tunelu i *w tym samym momencie* jego czoło wyjeżdża z zachodniego (każdy wagon zawija trasę niezależnie). Portale zdobią pulsujące, kwantowe pierścienie.
- **Wiadukt** z podniesioną estakadą i peronem na wysokości — autobus przejeżdża pod spodem.
- **Autobus miejski** na pętli przez całe miasto: 5 przystanków (w tym nad jeziorem), kolejki pasażerów przy wiatach, a na przejeździe kolejowym ustępuje pociągowi.
- **Prawdziwe tory**: ciągłe stalowe szyny, drewniane podkłady, tłuczniowa podsypka.

### Światło i atmosfera
- Fizyczne niebo (rozpraszanie Rayleigha/Mie) — **efektowne wschody słońca i golden hour**, odbicia nieba i słońca w szybach budynków (PMREM environment).
- **Fazy księżyca**, gwiazdy, spadające gwiazdy, **zorza polarna** w pogodne noce.
- **Zaćmienia słońca** — w losowe dni księżyc nasuwa się na słońce: świat ciemnieje, zapalają się latarnie, mewy w popłochu siadają.
- **Automat pogodowy**: chmury voxelowe, deszcz (mokry, lustrzany asfalt), śnieg z **zalegającą zimą** (białe dachy, oszronione drzewa, **zamarzające jezioro**), mgła i wiatr kołyszący drzewami.
- **Zegar 1× / 2× / 3×** oraz tryb **⏱ REAL TIME** — pora dnia i pogoda synchronizują się z lokalizacją widza (geolokalizacja + SunCalc + Open-Meteo).

### Motywy (🎭) z morfingiem
| Motyw | Klimat |
|---|---|
| Klasyczny | bazowa diorama |
| Retro PRL | sepia, wyblakłe tynki, pociąg w liverze retro |
| Złota jesień | rude korony drzew, niskie słońce |
| Zabawkowy | cukierkowa paleta makiety |
| **Cyberpunk** | pełny morfing: z ziemi **wyrastają neonowe megabloki**, pociąg staje się nocnym ekspressem, autobus dostaje cyberlakier, balon zamienia się w kosmiczny odrzutowiec, wędkarz w hologram, a mewy/krowa/UFO znikają. Powrót = morfing wsteczny. |

### Smaczki fabularne
- 🐄 **Krowa i UFO** — krowa pasie się nad jeziorem; co drugą noc latający spodek wciąga ją wiązką, a następnej nocy odstawia. Rankiem po porwaniu **rolnik** szuka jej, drapie się po głowie i wygraża kosmitom — a po powrocie radośnie ją klepie.
- 👽 Czasem kosmici robią zamiast tego **nalot na kiosk** (rano stoi zapora „zamknięte").
- 🎣 **Wędkarz** w czapeczce, ze skrzynką: rano wychodzi z bloku, łowi nad brzegiem (raz na kilka brań wyciąga rybę wielką jak on sam — zawsze ucieka), zimą **łowi w przeręblu na środku zamarzniętego jeziora**, wieczorem wraca do domu.
- 📮 **Listonosz** na rowerze objeżdża rano południową dzielnicę — czasem goni go pies.
- 🎈 **Balon** na ogrzane powietrze przelatuje w pogodne dni i o zmierzchu, pięknie podświetlony ogniem palnika.
- 🕊️ **Mewy** szybują, bankują w zakrętach i nocą śpią na dachach.

## 🎮 Sterowanie

| Akcja | Klawisz / UI |
|---|---|
| Obrót / przesuwanie / zoom kamery | mysz (drag / PPM / scroll) |
| Kamera TPP za pociągiem | `T` lub 🚆 |
| Kamera TPP za autobusem | `B` lub 🚌 |
| Filmowy oblot dioramy (wschód→zachód) | „Pokaż dioramę" |
| Prędkość zegara | `1` `2` `3` |
| Tryb czasu rzeczywistego | `R` lub ⏱ REAL TIME |
| Pogoda (auto → słońce → chmury → deszcz → śnieg → mgła) | `W` lub przycisk pogody |
| Motyw dioramy | 🎭 |
| Prędkość pociągu | suwak / `←` `→` |
| Pauza | spacja |

## 🚀 Szybki start

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 39 testów (vitest): geometria trasy, skrajnia tunelu,
                 # testy antykolizyjne wszystkich aktorów, model słońca…
npx tsc --noEmit # typy
npm run build    # produkcja → dist/
```

Wymagania: Node 18+, przeglądarka z WebGL2. Cel wydajnościowy: **60 FPS na Apple M1** (4× MSAA, pełna rozdzielczość Retina).

## 🏗️ Architektura

```
src/
├── main.ts                  # pętla animacji i orkiestracja wszystkiego
├── bootstrap.ts             # renderer, composer (MSAA+HDR), kamera
├── ui.ts                    # panel sterowania
├── CinematicTour.ts         # filmowy oblot
├── experience/
│   ├── Themes.ts            # motywy (palety + światło + morfing cyber)
│   └── RouteChapters.ts     # narracyjne etykiety trasy
├── environment/
│   ├── sky.ts               # czysty model słońca/kolorów (testowalny)
│   ├── DayNightCycle.ts     # niebo, księżyc, gwiazdy, zorza, zaćmienia, PMREM
│   ├── Weather.ts           # automat pogodowy, chmury, śnieg, wiatr, mokro
│   └── RealTime.ts          # geolokalizacja + SunCalc + Open-Meteo
├── effects/
│   ├── PortalGlow.ts        # kwantowe pierścienie tuneli
│   ├── Balloon.ts           # balon / kosmiczny odrzutowiec
│   └── GlitchTimeDilation.ts# grading filmowy (golden hour, sepia, vibrance)
└── world/
    ├── WorldLayout.ts       # ŹRÓDŁO PRAWDY: trasy, drogi, kotwice aktorów
    ├── WorldGenerator.ts    # voxelowe miasto, tory, zima, cyber-wieże
    ├── Train.ts / Bus.ts    # pojazdy z maszynami stanów
    ├── Birds.ts             # mewy (szybowanie/bankowanie/sen)
    ├── LakesideCow.ts       # krowa + UFO + rolnik + nalot na kiosk
    ├── Fisherman.ts         # wędkarz (brzeg/przerębel/hologram)
    ├── Postman.ts           # listonosz + pies
    ├── PassengerCrowd.ts    # pasażerowie na peronach
    └── LakeLife.ts          # skaczące ryby
```

Zasada projektu: **cała geometria świata mieszka w `WorldLayout.ts`**, a testy w `WorldLayout.test.ts` pilnują, by nic na nic nie nachodziło (trasy na asfalcie, aktorzy poza wodą/torami/budynkami, skrajnia tunelu większa od obwiedni pociągu, krzywizna trasy poniżej progu „łamania").

## 🛠️ Stack

[Three.js](https://threejs.org/) · TypeScript · Vite · Vitest · [SunCalc](https://github.com/mourner/suncalc) · [Open-Meteo](https://open-meteo.com/) (pogoda na żywo, bez klucza API)

## 📄 Licencja

MIT — patrz [LICENSE](LICENSE).
