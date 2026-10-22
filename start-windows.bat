@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.5 yoki undan yangiroq versiyasi topilmadi.
  echo https://nodejs.org saytidan Node.js o'rnating, so'ng qayta urinib ko'ring.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm topilmadi. Node.js o'rnatilishini tekshirib, terminalni qayta oching.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json topilmadi. Ushbu faylni SYNAPTOX papkasidan ishga tushiring.
  pause
  exit /b 1
)
if not exist "server.js" (
  echo server.js topilmadi. Loyiha fayllari to'liq ekanini tekshiring.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$v = [version]::Parse((node -p \"process.versions.node\")); if ($v.Major -gt 22 -or ($v.Major -eq 22 -and $v.Minor -ge 5)) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo Node.js 22.5 yoki undan yangiroq versiya kerak.
  node --version
  pause
  exit /b 1
)

echo SYNAPTOX serveri ishga tushmoqda. Ushbu oynani server ishlashi uchun ochiq qoldiring.
echo Agar 3000-port band bo'lsa, .env faylidan PORT qiymatini o'zgartiring.
call npm start
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo SYNAPTOX serveri xatolik bilan to'xtadi (exit code: %EXITCODE%).
  echo Agar chiqishda "EADDRINUSE" yoki "address already in use" ko'rinadi:
  echo  - 3000-port boshqa ilova tomonidan band qilingan;
  echo  - .env faylida PORT=3001 kabi boshqa port tanlang;
  echo  - yoki ishlayotgan serverni to'xtating.
  pause
  exit /b %EXITCODE%
)

echo.
echo SYNAPTOX serveri to'xtadi. Xatolarni yuqoridagi chiqishdan tekshiring.
pause
