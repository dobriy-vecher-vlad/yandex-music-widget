; Дополнения к установщику electron-builder (nsis.include в package.json).
; Установка всегда для текущего пользователя: без выбора «для всех / только для меня» и без прав
; администратора. Этот выбор перезапускал установщик с повышенными правами, и кнопка «Назад»
; со страницы выбора папки закрывала его целиком.

!include LogicLib.nsh ; файл подключается раньше шаблонов electron-builder

!ifndef BUILD_UNINSTALLER

  ; После «Обзора» NSIS дописывает к выбранной папке последнюю часть InstallDir. electron-builder
  ; InstallDir не задаёт, и в поле оставался голый путь вроде «Downloads\» без папки программы.
  ; Значение по умолчанию всё равно выставляет electron-builder при запуске.
  InstallDir "$LOCALAPPDATA\Programs\${APP_FILENAME}"

  ; Приветствие — первая страница: с выбора папки «Назад» ведёт сюда.
  !macro customWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Установка Yandex Music Widget"
    ; Строки переносим вручную: подпись страницы переносит русский текст посреди слов.
    !define MUI_WELCOMEPAGE_TEXT "Yandex Music Widget — виджет плеера$\r$\nдля Яндекс Музыки: обложка, управление,$\r$\nочередь и текст песни в небольшом окне$\r$\nповерх остальных.$\r$\n$\r$\nДля работы нужна установленная$\r$\nЯндекс Музыка для Windows.$\r$\n$\r$\nВиджет ставится только для вашей учётной$\r$\nзаписи, права администратора не нужны.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
    !insertmacro MUI_PAGE_WELCOME
    !define MUI_DIRECTORYPAGE_TEXT_TOP "Подойдёт любая папка, в которую у вас есть право записи.$\r$\nProgram Files и папка Windows не подходят: там нужны права$\r$\nадминистратора."
    !define MUI_FINISHPAGE_TITLE "Yandex Music Widget установлен"
    !define MUI_FINISHPAGE_TEXT "Виджет появится поверх окон и сам$\r$\nподключится к Яндекс Музыке.$\r$\n$\r$\nПоказать или скрыть его — Ctrl+Alt+M$\r$\nили значок в трее."
  !macroend

  ; Страница выбора режима установки всегда пропускается: только текущий пользователь.
  !macro customInstallMode
    StrCpy $isForceCurrentInstall "1"
  !macroend

  ; Сборки до 1.0.0 назывались иначе (другой appId) и стояли в %LOCALAPPDATA%\Programs\yandex-music-widget.
  ; Удаляем их тихо, чтобы не осталось двух виджетов и двух ярлыков. Настройки в %APPDATA% не трогаем.
  ; Версии от 1.0.0 стоят в той же папке, но записаны в реестре под текущим appId — их не трогаем,
  ; обновление выполняет сам electron-builder и сохраняет автозапуск.
  !macro customInit
    StrCpy $R0 "$LOCALAPPDATA\Programs\yandex-music-widget"
    ReadRegStr $R3 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R3 == ""
    ${AndIf} ${FileExists} "$R0\*.exe"
      nsExec::Exec 'taskkill /F /IM "yandex-music-widget.exe"'
      Pop $R1
      nsExec::Exec 'taskkill /F /IM "ym-mini-player.exe"'
      Pop $R1
      Sleep 500
      FindFirst $R1 $R2 "$R0\Uninstall *.exe"
      ${If} $R2 != ""
        ExecWait '"$R0\$R2" /S _?=$R0'
      ${EndIf}
      FindClose $R1
      RMDir /r "$R0"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ru.local.yandex-music-widget"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.electron.yandex-music-widget"
    ${EndIf}
  !macroend

  ; Проверка папки при каждом её изменении: если без прав администратора туда не записать
  ; или диска нет, кнопка «Установить» неактивна, а установщик не падает с ошибкой записи.
  Var ymwReject

  !macro ymwRejectUnder DIR
    StrLen $R1 "${DIR}"
    StrCpy $R2 $INSTDIR $R1
    ${If} $R1 > 0
    ${AndIf} $R2 == "${DIR}"
      StrCpy $R3 $INSTDIR 1 $R1
      ${If} $R3 == ""
      ${OrIf} $R3 == "\"
        StrCpy $ymwReject "1"
      ${EndIf}
    ${EndIf}
  !macroend

  Function .onVerifyInstDir
    Push $R1
    Push $R2
    Push $R3
    StrCpy $ymwReject ""
    !insertmacro ymwRejectUnder "$PROGRAMFILES"
    !insertmacro ymwRejectUnder "$PROGRAMFILES64"
    !insertmacro ymwRejectUnder "$WINDIR"
    ; путь должен начинаться с буквы существующего диска
    StrCpy $R1 $INSTDIR 3
    StrCpy $R2 $R1 1 1
    ${If} $R2 != ":"
    ${OrIfNot} ${FileExists} "$R1*.*"
      StrCpy $ymwReject "1"
    ${EndIf}
    Pop $R3
    Pop $R2
    Pop $R1
    ${If} $ymwReject == "1"
      Abort
    ${EndIf}
  FunctionEnd

!else

  ; Тексты удаления с ручными переносами — по той же причине, что и при установке.
  !macro customUnWelcomePage
    !define MUI_WELCOMEPAGE_TITLE "Удаление Yandex Music Widget"
    !define MUI_WELCOMEPAGE_TEXT "Виджет будет удалён с компьютера.$\r$\nНастройки останутся: при повторной$\r$\nустановке всё будет как раньше.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
    !insertmacro MUI_UNPAGE_WELCOME
    !define MUI_FINISHPAGE_TITLE "Yandex Music Widget удалён"
    !define MUI_FINISHPAGE_TEXT "Нажмите «Готово», чтобы закрыть мастер."
  !macroend

  ; При обновлении старая версия удаляется с флагом --updated — тогда автозапуск оставляем.
  ; При обычном удалении убираем запись автозапуска, которую виджет создаёт из меню в трее
  ; (Electron называет её по AppUserModelId = appId).
  !macro customUnInstall
    ${ifNot} ${isUpdated}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    ${endIf}
  !macroend

!endif
