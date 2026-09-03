# Historyczne wyniki benchmarku

Pomiary z rewizji **przed `a89af98`**, zachowane dla śladu, nie jako aktualny wynik.
Nie zawierają pola `revision` ani `conditions`, bo benchmark ich wtedy nie zapisywał,
a ich liczby GPU pochodzą ze starej sondy, która mierzyła wymuszony render razem z
odczytem bufora i kodowaniem JPEG — patrz errata E3 w raporcie.

`bench-voxel-low.json` z tamtego zestawu **nie istnieje**: driver przekierowywał stdout
do pliku docelowego, więc powłoka obcinała go przed startem node'a i każdy błąd
zostawiał 0 bajtów w miejscu poprawnego wyniku. Aktualne pomiary zapisuje
`writeReport()` przez plik tymczasowy i walidację, więc odrzucony raport nie niszczy
poprzedniego.
