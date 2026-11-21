@echo off
setlocal
set "bridge_directory=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
set "PARASELF_BRIDGE_PATH=%bridge_directory%paraself-bridge.cmd"
for %%I in ("%bridge_directory%..\..\..") do if exist "%%~fI\Update.exe" if exist "%%~fI\paraself-bridge.cmd" set "PARASELF_BRIDGE_PATH=%%~fI\paraself-bridge.cmd"
"%bridge_directory%..\..\Paraself.exe" "%bridge_directory%paraself-bridge.mjs" %*
exit /b %errorlevel%
