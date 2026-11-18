@echo off
rem HorosHub — Desktop-App (Electron). Startet Backend + natives Fenster.
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" "."