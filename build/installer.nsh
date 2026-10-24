; Registers InstantCognition as a web browser that Windows Default Apps can offer
; for http/https. electron-builder's NSIS template includes this file (package.json
; build.nsis.include). SHELL_CONTEXT is HKCU for a per-user install and HKLM for a
; per-machine one, matching where the rest of the install is recorded.

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_NAME}URL" "" "${PRODUCT_NAME} URL"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_NAME}URL\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_NAME}URL\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}" "" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities" "ApplicationDescription" "Instant access to AI models and the web."
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities" "ApplicationIcon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\StartMenu" "StartMenuInternet" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\URLAssociations" "http" "${PRODUCT_NAME}URL"
  WriteRegStr SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities\URLAssociations" "https" "${PRODUCT_NAME}URL"

  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}" "Software\Clients\StartMenuInternet\${PRODUCT_NAME}\Capabilities"

  ; SHCNE_ASSOCCHANGED: Default Apps re-reads the registered browsers.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller before customInstall re-registers; skip
  ; it so the user's default-browser choice is not dropped on every update.
  ${ifNot} ${isUpdated}
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}"
    DeleteRegKey SHELL_CONTEXT "Software\Clients\StartMenuInternet\${PRODUCT_NAME}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\${PRODUCT_NAME}URL"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
