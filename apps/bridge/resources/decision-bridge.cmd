@echo off
setlocal
set "bridge_directory=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
set "DECISION_BRIDGE_PATH=%bridge_directory%decision-bridge.cmd"
for %%I in ("%bridge_directory%..\..\..") do if exist "%%~fI\Update.exe" if exist "%%~fI\decision-bridge.cmd" set "DECISION_BRIDGE_PATH=%%~fI\decision-bridge.cmd"
"%bridge_directory%..\..\Decision.exe" "%bridge_directory%decision-bridge.mjs" %*
exit /b %errorlevel%
