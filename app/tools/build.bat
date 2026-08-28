@echo off
REM build.bat - package AquaPlay IPTV as a Tizen .wgt and optionally install it.
REM
REM   tools\build.bat                  build the .wgt only
REM   tools\build.bat 192.168.1.50     build, connect to that TV, install
REM
REM Needs Tizen Studio's CLI on PATH (tizen, sdb) and a signing profile named
REM in TIZEN_PROFILE (default: dev).

setlocal enabledelayedexpansion
cd /d "%~dp0.."

if "%TIZEN_PROFILE%"=="" set "TIZEN_PROFILE=dev"
set "TV_IP=%~1"

where tizen >nul 2>nul
if errorlevel 1 (
  echo.
  echo   'tizen' CLI not found on PATH.
  echo   Add ^<tizen-studio^>\tools\ide\bin to your PATH and try again.
  echo.
  exit /b 1
)

echo ==^> staging
if exist ".dist" rmdir /s /q ".dist"
mkdir ".dist"
copy /y "index.html" ".dist\" >nul
copy /y "config.xml" ".dist\" >nul
copy /y "icon.png"   ".dist\" >nul
xcopy /e /i /q /y "css" ".dist\css" >nul
xcopy /e /i /q /y "js"  ".dist\js"  >nul

echo ==^> building
call tizen build-web -e ".*" -e "node_modules/*" -e "tools/*" -- ".dist"
if errorlevel 1 exit /b 1

echo ==^> packaging (profile: %TIZEN_PROFILE%)
call tizen package -t wgt -s "%TIZEN_PROFILE%" -- ".dist\.buildResult"
if errorlevel 1 exit /b 1

set "WGT="
for %%f in (".dist\.buildResult\*.wgt") do set "WGT=%%~nxf"
if "%WGT%"=="" (
  echo   No .wgt was produced.
  exit /b 1
)
copy /y ".dist\.buildResult\%WGT%" "%WGT%" >nul
echo ==^> built: %CD%\%WGT%

if "%TV_IP%"=="" goto :done

echo ==^> connecting to %TV_IP%
call sdb connect %TV_IP%
set "TARGET="
for /f "skip=1 tokens=3" %%d in ('sdb devices') do if not defined TARGET set "TARGET=%%d"
if "%TARGET%"=="" (
  echo   TV not listed by sdb. Is Developer Mode on and the IP correct?
  exit /b 1
)
echo ==^> installing to %TARGET%
call tizen install -n "%WGT%" -t "%TARGET%" -- ".dist\.buildResult"
echo ==^> done. Launch "AquaPlay IPTV" from the TV's Apps row.

:done
endlocal
