!include "LogicLib.nsh"

!define RIGHTDATA_WINDOWS_DEPLOY_DIR "${__FILEDIR__}"

!macro RIGHTDATA_RUN_SERVICE_LIFECYCLE ACTION
  SetOutPath "$PLUGINSDIR"
  File /oname=rightdata-service-lifecycle.ps1 "${RIGHTDATA_WINDOWS_DEPLOY_DIR}\service-lifecycle.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\rightdata-service-lifecycle.ps1" -Action "${ACTION}" -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "RightData network service ${ACTION} failed: $1"
    FileOpen $2 "$INSTDIR\rightdata-install-error.log" w
    FileWrite $2 "RightData network service ${ACTION} failed ($0): $1$\r$\n"
    FileClose $2
    MessageBox MB_ICONSTOP|MB_OK "网络服务安装步骤失败，安装程序未继续。$\r$\n$1" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RIGHTDATA_RUN_SERVICE_LIFECYCLE "PreInstall"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RIGHTDATA_RUN_SERVICE_LIFECYCLE "PostInstall"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RIGHTDATA_RUN_SERVICE_LIFECYCLE "Uninstall"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
