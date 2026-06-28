# Changelog

Всё, что менялось в каждой версии yapper. Сначала на русском (RU),
ниже — перевод на английский (EN).

Everything that changed in each yapper release. Russian (RU) comes first,
English (EN) translation below.

## 0.2.93

### Русский
- Продолжение фикса 0.2.92. Звук других вернулся, но микрофон всё ещё молчал
  после выхода из комнаты, а воспроизведение со временем пропадало. Две причины:
  (1) приём с подменой слушателя `data` на naudiodon «подвешивал» доставку —
  теперь процессор захвата остаётся подключённым к живому потоку постоянно, а
  вход/выход из комнаты лишь переключает флаг (поток не меняет flowing-состояние);
  (2) при выходе микшер полностью останавливался, и выходной поток naudiodon
  голодал без записи и со временем затыкался — теперь при выходе он продолжает
  писать тишину (`pauseMixer`), удерживая устройство живым.

### English
- Follow-up to 0.2.92. Others' audio came back, but the mic was still dead after
  leaving a room and playback vanished after a while. Two causes: (1) swapping
  the `data` listener on naudiodon wedged delivery — the capture processor now
  stays attached to the live stream permanently and join/leave only flips a flag
  (the stream never changes flowing state); (2) leaving fully stopped the mixer,
  starving the naudiodon output until it stalled — leaving now keeps writing
  silence (`pauseMixer`) so the device stays alive.

## 0.2.92

### Русский
- Фикс: после выхода из комнаты и повторного входа переставал работать микрофон
  и не было слышно других. Причина — на бэкенде naudiodon выход звал `quit()`,
  который рвёт общую сессию PortAudio (а с ней и поток воспроизведения) и делает
  `AudioIO` неперезапускаемым. Теперь устройство naudiodon переживает выход из
  комнаты: пока ты вне комнаты, звук отбрасывается, но устройство и
  воспроизведение остаются живыми, а при возврате захват возобновляется. Полное
  освобождение осталось только при смене микрофона. Заодно починился тот же баг
  по цепочке «mic-тест → вход в комнату». SoX это не затрагивало.

### English
- Fix: after leaving a room and re-joining, the mic stopped working and you
  couldn't hear anyone. On the naudiodon backend, leaving called `quit()`, which
  tears down the shared PortAudio session (and with it the playback stream) and
  leaves the `AudioIO` un-restartable. The naudiodon device now survives a room
  leave: while you're outside a room its audio is discarded, but the device and
  playback stay alive, and capture resumes on re-join. A full release now only
  happens on input-device change. This also fixes the same bug via the
  "mic test → join a room" path. SoX was unaffected.

## 0.2.91

### Русский
- Продолжение фикса бесконечного «connect…» после рестарта. Теперь закрытие
  discovery-порта (UDP 4748) тоже дожидается перед перезапуском: `stop()`
  responder'а возвращает промис и резолвится после полного закрытия сокета — так
  оба порта (4747 и 4748) гарантированно свободны к моменту `spawnSync`.
- Важно: сам фикс рестарта живёт в коде ≥ 0.2.90, поэтому он срабатывает только
  при обновлении С версии 0.2.90+ (обновление НА 0.2.90 ещё шло старым кодом —
  отсюда «не помогло»). Эта 0.2.91 даёт цель для апдейта, чтобы проверить фикс.

### English
- Follow-up to the endless "connect…" restart fix. Closing the discovery port
  (UDP 4748) is now awaited too before restart: the responder's `stop()` returns
  a promise that resolves once the socket is fully closed, so both ports (4747
  and 4748) are guaranteed free by the time spawnSync runs.
- Note: the restart fix itself lives in code ≥ 0.2.90, so it only takes effect
  when updating FROM 0.2.90+ (the update INTO 0.2.90 still ran the old code —
  hence "didn't help"). This 0.2.91 gives an update target to verify the fix.

## 0.2.90

### Русский
- Фикс: после обновления и [R] restart больше нет бесконечного «connect…» с
  пустым списком комнат и оффлайном. Причина — если ты был хостом (`127.0.0.1:4747`),
  старый процесс при `spawnSync` оставался жив с замороженным event loop и держал
  занятыми порты 4747 (WS) и 4748 (discovery): новый процесс не мог ни
  подключиться (старый сервер не отвечал), ни сам стать хостом. Теперь перед
  перезапуском хост-порты корректно освобождаются — сервер и discovery-responder
  закрываются, клиентские соединения рвутся через RST (без TIME_WAIT), и закрытие
  слушающего сокета ждётся до конца. Запуск через `yapper` работал и раньше.

### English
- Fix: after an update + [R] restart there's no more endless "connect…" with an
  empty room list and offline state. Cause — if you were the host
  (`127.0.0.1:4747`), the old process stayed alive under spawnSync with a frozen
  event loop, holding ports 4747 (WS) and 4748 (discovery): the new process could
  neither connect (the old server didn't answer) nor become host itself. The host
  ports are now released before restart — the server and discovery responder are
  closed, client sockets are RST-terminated (no TIME_WAIT), and the listening
  socket's close is awaited. Launching via `yapper` worked already.

## 0.2.9

### Русский
- Фикс: после закрытия настроек больше не остаётся висеть голубая «палка»
  (аппаратный курсор терминала) посреди экрана. При delta-отрисовке terminal-kit
  оставлял реальный курсор на последней перерисованной ячейке — в области только
  что закрытой модалки, — и он был виден поверх всего. Приложение свой курсор не
  использует (поля ввода рисуют собственный блок), поэтому теперь после каждого
  кадра курсор принудительно прячется.

### English
- Fix: closing settings no longer leaves a stray blue bar (the hardware terminal
  cursor) floating mid-screen. A delta draw left the real cursor on the last cell
  it repainted — inside the just-closed modal — where it showed on top of
  everything. The app never uses the hardware cursor (edit fields draw their own
  block), so it's now force-hidden after every frame.

## 0.2.8

### Русский
- Кнопка [R] restart теперь корректно перезапускает и при dev-запуске
  (`node bin/yapper.js`), а не только при глобальной установке. Перезапуск
  повторяет исходный вызов — `node` + тот же скрипт и аргументы
  (`process.argv`), — поэтому подхватывается обновлённый код по тому же пути и
  сохраняются аргументы вроде `connect <ip>` (после рестарта переподключишься к
  тому же хосту). Если путь скрипта почему-то недоступен — фолбэк на `yapper` из
  PATH.

### English
- The [R] restart button now works for a dev run (`node bin/yapper.js`), not
  just a global install. Restart re-runs the original invocation — `node` plus
  the same script and args (`process.argv`) — so it picks up the updated code at
  the same path and preserves args like `connect <ip>` (you reconnect to the
  same host after restart). If the script path is somehow unavailable it falls
  back to `yapper` from PATH.

## 0.2.7

### Русский
- Обновление теперь происходит **внутри приложения**, без выхода в обычный
  терминал. Раньше TUI закрывался, npm писал поверх экрана, всё налезало друг
  на друга, а после установки прога просто закрывалась — приходилось вручную
  снова набирать `yapper`. Теперь по [U] открывается аккуратная модалка с
  анимированным прогресс-баром; вывод npm перехватывается (на экран не лезет).
- Когда установка завершилась — кнопка **[R] restart now** сразу перезапускает
  уже новую версию (Esc — перезапустить позже). Микрофон перед перезапуском
  освобождается.
- Полностью убран варнинг `DEP0190` при обновлении: команда запускается строкой
  без массива аргументов, вывод идёт в pipe, а дочернему процессу передаётся
  `NODE_NO_WARNINGS=1` — так что предупреждение не появляется ни от нас, ни от
  npm и не попадает на экран.

### English
- Updating now happens **inside the app**, without dropping to the raw terminal.
  Previously the TUI closed, npm printed over the screen and everything
  overlapped, and afterwards the app just exited — you had to type `yapper`
  again by hand. Now [U] opens a clean modal with an animated progress bar; npm's
  output is captured (never drawn over the UI).
- When the install finishes, an **[R] restart now** button relaunches straight
  into the new version (Esc to restart later). The mic is released first.
- The `DEP0190` warning during updates is gone for good: the command runs as a
  single string (no args array), output is piped, and the child gets
  `NODE_NO_WARNINGS=1` — so the warning is emitted neither by us nor by npm and
  never reaches the screen.

## 0.2.6

### Русский
- Убран варнинг `DEP0190` (DeprecationWarning о `shell: true` с аргументами),
  который выскакивал при обновлении через [U] и при сборке naudiodon в
  `yapper setup`. Причина — массив аргументов вместе с `shell: true`. На Windows
  `shell: true` обязателен (npm — это `npm.cmd`), поэтому команда теперь
  передаётся одной строкой без отдельного массива аргументов; URL/аргументы —
  жёстко зашитые константы, так что инъекций нет. На POSIX используется
  `shell: false` с массивом — тоже без варнинга.

### English
- Removed the `DEP0190` warning (DeprecationWarning about `shell: true` with
  args) that showed up during the [U] self-update and the naudiodon build in
  `yapper setup`. It was caused by passing an args array together with
  `shell: true`. On Windows `shell: true` is required (npm is `npm.cmd`), so the
  command is now passed as a single string with no separate args array; the
  URL/args are hardcoded constants, so nothing is injectable. On POSIX it uses
  `shell: false` with an args array — also warning-free.

## 0.2.5

### Русский
- Шумоподавление на базе RNNoise (нейросеть, как в Discord/Jitsi). Чистит шум
  микрофона — клавиатуру, гул, вентиляторы — перед VAD и кодеком, поэтому и
  индикатор уровня, и собеседник слышат уже очищенный сигнал. Работает на WASM
  (без нативной сборки), нагрузка на CPU ~2 мс на 20 мс кадр. Если WASM по
  какой-то причине не загрузился — звук идёт без обработки, без падения.
- Тумблер в настройках ([S] settings → noise). Включён по умолчанию, выбор
  сохраняется между запусками. Пока WASM грузится, показывается «on (loading…)».

### English
- RNNoise-based noise suppression (neural net, like Discord/Jitsi). Cleans mic
  noise — keyboard, hum, fans — before the VAD and codec, so both the level
  meter and the other person hear the already-cleaned signal. Runs on WASM (no
  native build), costing ~2 ms per 20 ms frame. If the WASM fails to load for
  any reason, audio passes through unprocessed — no crash.
- Toggle in settings ([S] settings → noise). On by default, the choice persists
  across restarts. While the WASM is loading it shows "on (loading…)".

## 0.2.4

### Русский
- Качество голоса в звонках заметно чище. Раньше кадр уходил по сети только
  пока громкость выше порога VAD — это обрезало тихое начало слов («речь
  собеседника начиналась лаганно») и рвало поток в паузах между словами, отчего
  Opus давал артефакты на стыках («лёгкие искажения»). Теперь VAD сглажен:
  pre-roll (~60 мс) подхватывает мягкую атаку слова, а hangover (~300 мс)
  держит поток непрерывным сквозь короткие межсловные провалы, так что приёмный
  джиттер-буфер не опустошается и не заикается.
- Кодек Opus настроен под LAN: битрейт поднят до 64 kbps (было авто ~24–32),
  сложность 10 (макс. качество), сигнал — «голос». На локальной сети это ~8 КБ/с.

### English
- Noticeably cleaner voice quality in calls. Frames used to be sent only while
  the level was above the VAD threshold — that clipped the quiet onset of words
  (a "laggy" start to the other person's speech) and tore the stream apart in
  the gaps between words, so Opus produced artefacts at the seams ("light
  distortions"). The VAD is now smoothed: a pre-roll (~60 ms) captures the soft
  attack of a word, and a hangover (~300 ms) keeps the stream continuous across
  brief inter-word dips, so the receiver's jitter buffer no longer drains and
  stutters.
- Opus codec tuned for LAN: bitrate raised to 64 kbps (was auto ~24–32),
  complexity 10 (max quality), signal set to voice. On a local network that's
  only ~8 KB/s.

## 0.2.3

### Русский
- Фикс: новый системный звук теперь мгновенно прерывает предыдущий. Раньше
  frames копились в очередь — например, звук размута ждал ~2 с окончания звука
  мьюта. Теперь при запуске нового звука буфер SYSTEM_USER очищается,
  а старый teardown-таймер отменяется, так что переключение звучит сразу.
  Бонусом пропал риск того, что «протухший» таймер от первого звука гасил
  микшер прямо посреди второго.

### English
- Fix: a new system sound now interrupts the previous one instantly.  Frames
  used to queue — e.g. the unmute chime waited ~2 s for the mute chime to
  finish.  Starting a new sound now clears the SYSTEM_USER frame buffer and
  cancels the previous teardown timer, so the switch is immediate.  Also fixes
  a latent bug where a stale timer from the first sound could stop the mixer
  mid-way through the second.

## 0.2.2

### Русский
- Звук мьюта: при выключении микрофона играется mus_piano5.wav, при
  включении — mus_piano7.wav (локальный отклик через колонки).
- Звук выхода из румы заменён с mus_doorclose.ogg на snd_arrow.wav
  (теперь работает и без SoX через встроенный JS WAV-декодер).
- Звук нахождения обновления заменён с mus_piano7.wav на snd_textnoise.wav.
- Теперь arrow звучит и при собственном выходе из румы (ESC / смена румы /
  удаление), а не только когда руму покидает кто-то другой

### English
- Mute sound: muting plays mus_piano5.wav, unmuting plays mus_piano7.wav
  (local speaker feedback).
- Leaving a room now uses snd_arrow.wav instead of mus_doorclose.ogg (works
  without SoX via the built-in JS WAV decoder).
- Update-found sound changed from mus_piano7.wav to snd_textnoise.wav.
- The leave chime now also fires on your own leave action (ESC / switching
  rooms / room deleted), not only when someone else departs.

## 0.2.1

### Русский
- Удаление кастомных комнат. Кнопка [D] delete в статус-баре появляется, когда
  выбрана не дефолтная комната; Enter подтверждает, ESC отменяет. Дефолтные
  (general, gaming, music) удалить нельзя — сервер их отклоняет. При удалении
  комнаты все, кто в ней находились, автоматически из неё выходят (им
  приходит `left`, микрофон останавливается).

### English
- Deleting custom rooms. A [D] delete button appears in the status bar when a
  non-default room is selected; Enter confirms, ESC cancels. Default rooms
  (general, gaming, music) can't be deleted — the server rejects them. When a
  room is deleted, everyone still in it is moved out automatically (they get a
  `left` signal and capture stops).

## 0.2.0

### Русский
- Полностью удалены синтезированные PCM-звуки. Только настоящие аудиофайлы
  из audio/ (snd_splash.wav — вход, mus_doorclose.ogg — выход,
  mus_piano7.wav — обновление). Встроен чистый JS WAV-декодер
  (44100→48000, стерео→моно) как фолбек для .wav без SoX.
- Ручная проверка обновлений теперь различает «обновлений нет» и «ошибка
  сети / GitHub rate limit» — в последнем случае показывает
  «× check failed (rate limit / offline)» вместо ложного «✓ up to date».
  Стартовая автопроверка ошибки не показывает (чтобы не раздражать при
  каждом запуске), но молча не врёт — кнопка [U] просто не появляется.

### English
- Removed all synthesised PCM sounds. Only real audio files from audio/
  (snd_splash.wav — join, mus_doorclose.ogg — leave, mus_piano7.wav —
  update). Built-in pure-JS WAV decoder (44100→48000, stereo→mono) as
  fallback for .wav when SoX is unavailable.
- Manual update check now distinguishes "no update" from "network error /
  GitHub rate limit" — shows "× check failed (rate limit / offline)" instead
  of falsely claiming "✓ up to date". Startup auto-check stays silent on
  errors (no false [U] button).

## 0.1.30

### Русский
- Звуки уведомлений теперь загружаются из настоящих аудиофайлов (audio/):
  snd_splash.wav (заход в руму), mus_doorclose.ogg (выход), mus_piano7.wav
  (найдено обновление). Декодирование через SoX — на лету в моно 48 кГц,
  кешируется после первого воспроизведения. Если SoX отсутствует —
  автоматический фолбек на синтезированные PCM-тона.
- Починен обрез буфера системных звуков: длинные файлы (2 с) теперь
  проигрываются полностью, без ограничения 400 мс.
- Файлы audio/ добавлены в npm-пакет.

### English
- Notification sounds now load from real audio files (audio/):
  snd_splash.wav (join), mus_doorclose.ogg (leave), mus_piano7.wav
  (update found). Decoded via SoX to 48 kHz mono on-the-fly, cached after
  first play. Automatic fallback to synthesised PCM tones when SoX is
  unavailable.
- Fixed system-sound buffer truncation: long files (2 s) now play in
  full instead of being capped at 400 ms.
- audio/ directory added to the npm bundle.

## 0.1.29

### Русский
- Звуковые уведомления:
  - короткий восходящий сигнал, когда кто-то заходит в вашу комнату;
  - нисходящий сигнал, когда кто-то выходит из вашей комнаты;
  - тройной мажорный перезвон при обнаружении доступного обновления.
  Все звуки синтезируются на лету (PCM-волны), внешние файлы не нужны.
  Слышны только события в той комнате, где вы находитесь; чужие комнаты
  молчат. При первом входе в комнату существующие участники не
  вызывают сигналов.

### English
- Sound notifications:
  - short rising chime when someone joins your current room;
  - falling chime when someone leaves your current room;
  - three-note ascending chime when an update is found.
  All sounds are synthesised on-the-fly (PCM waveforms), no external files
  needed. You hear only events in the room you're sitting in; other rooms stay
  silent. Existing occupants don't trigger sounds when you first join a room.

## 0.1.28

### Русский
- В настройки (S) добавлена кнопка «проверить обновления». Нажатие заново
  опрашивает GitHub в обход разового за запуск кэша и тут же показывает
  результат в самой строке: «✓ актуальная версия», «! доступно обновление vX»
  (заодно подсвечивает [U] в статус-баре) или «× не удалось проверить». Статус
  «актуальная версия» авто-скрывается через 4 секунды.

### English
- Added a "check for updates" button to the settings dialog (S). Pressing it
  re-queries GitHub, bypassing the once-per-session cache, and shows the result
  inline on the row: "✓ you are up to date", "! update vX available" (also lights
  up the [U] shortcut in the status bar), or "× check failed". The "up to date"
  status auto-hides after 4 seconds.

## 0.1.27

### Русский
- Откат системы обновления к старому варианту: yapper закрывается, ставит
  обновление в консоли и просит запустить его заново. Возвращено, потому что
  прошлый оверлей со спиннером ломал интерфейс (terminal-kit fullscreen
  конфликтовал с выводом npm).

### English
- Reverted the updater to the old flow: yapper exits, installs in the console,
  and asks you to run it again. Rolled back because the previous spinner overlay
  garbled the interface (terminal-kit fullscreen conflicted with npm's output).

## 0.1.26

### Русский
- Technical release to verify the in-place update system.

### English
- Technical release to verify the in-place update system.

## 0.1.25

### Русский
- Обновление больше не закрывает yapper. Вместо exit выводится оверлей с
  анимированным спиннером и последними строками вывода npm; после успешной
  установки появляется кнопка [R] (или Enter / клик), которая перезапускает
  yapper прямо в текущем терминале в новую версию. ESC — остаться в старой
  сессии. В случае ошибки показывается код и команда для ручной установки.

### English
- Updating no longer closes yapper. Instead of exiting, an overlay shows an
  animated spinner and the last npm output lines; once the install succeeds, a
  [R] button (or Enter / click) relaunches yapper in the same terminal into the
  new version. ESC stays in the old session. On failure the exit code and a
  manual install command are shown.

## 0.1.24

### Русский
- Лимит длины ника уменьшен с 32 до 16 символов (так ижеще достаточно для
  ника, но не даёт длиным именам ломать вёрстку правой панели).

### English
- Username length limit lowered from 32 to 16 chars (still plenty for a
  nickname, but long names no longer break the right-panel layout).

## 0.1.23

### Русский
- Ввод ника в настройках и названия комнаты в prompt теперь ограничен по
  длине (32 и 20 символов соответственно). В обоих полях показывается
  счётчик `N/MAX`, который жёлтым загорается у предела; дальше печатать нельзя.
  Раньше лимит был только серверный и скрытый — можно было ввести бесконечно
  длинную строку, которую сервер молча обрезал.

### English
- The username (settings) and room name (prompt) inputs now have a length
  limit (32 and 20 chars respectively). Both fields show an `N/MAX` counter that
  turns yellow at the limit, after which you can't type any more. Previously the
  limit was server-side and invisible — you could type an arbitrarily long
  string that the server silently truncated.

## 0.1.22

### Русский
- Исправлен ASCII-скриншот в README: строка-подчёркивание справа была
  короче на 3 символа, из-за чего правая рамка под заголовком комнаты
  «уезжала» влево. Теперь все стенки ровные.

### English
- Fixed the ASCII screenshot in the README: the underline row on the right
  was 3 columns short, making the right wall under the room header shift
  left. All walls are now straight.

## 0.1.21

### Русский
- Обновлён README: новый скриншот интерфейса отражает текущий UI — список
  участников под каждой комнатой, кнопка `+ new room` внизу сайдбара, статусбар
  с `[C] changelog` и версией. Дописаны горячие клавиши ESC (покиуть комнату) и
  C (changelog).

### English
- Updated README: the new UI screenshot reflects the current interface —
  participants listed under every room, `+ new room` pinned at the sidebar
  bottom, status bar with `[C] changelog` and the version. Added the ESC
  (leave room) and C (changelog) hotkeys to the key list.

## 0.1.20

### Русский
- В левом сайдбаре участники теперь показываются под каждой комнатой, а не
  только под той, в которой вы находитесь. Можно смотреть, кто сидит в music
  или gaming, сидя при этом в general. Себя с пометкой «(you)» видно только в
  текущей комнате.

### English
- The left sidebar now shows participants under every room, not just the
  one you're in. You can see who's in music or gaming while sitting in
  general. Yourself ("(you)") only appears in your current room.

## 0.1.19

### Русский
- В левом сайдбаре под раскрытой текущей комнатой теперь отображаешься и ты
  сам (с пометкой «(you)» и зелёным цветом), а не только другие участники.
  Ты идёшь первым в списке.

### English
- The left sidebar now shows yourself under the expanded current room too
  (marked "(you)" in green), not just other participants. You appear first.

## 0.1.18

### Русский
- Кнопка «+ new room» перенесена в самый низ левого сайдбара (под
  горизонтальный разделитель), а не висит сразу под последней комнатой.
  Навигация стрелками и клик мышью работают как прежде.

### English
- The "+ new room" button moved to the very bottom of the left sidebar
  (below a horizontal divider), instead of sitting right under the last
  room. Arrow-key navigation and mouse clicks work as before.

## 0.1.17

### Русский
- Кнопка «changelog» теперь стоит слева от версии (справа снизу), такого же
  цвета, и автоматически исчезает через 30 секунд. Появляется только после
  обновления до новой версии, а не на чистой установке.
- Исправлен баг, из-за которого кнопка не появлялась вообще (раньше версия
  помечалась «просмотренной» ещё до показа).

### English
- The "changelog" button now sits to the left of the version (bottom-right),
  in the same color, and auto-hides after 30 seconds. It only appears after
  an update to a new version, not on a fresh install.
- Fixed a bug where the button never showed at all (the version was marked
  "seen" before the hint was ever displayed).

## 0.1.16

### Русский
- Добавлена кнопка «changelog» в строке статуса: появляется, когда доступно
  обновление, или сразу после обновления до новой версии. Открывает окно с
  описанием изменений (RU сверху, EN ниже) с прокруткой мышью и стрелками.
- Добавлен выход из текущей комнаты клавишей ESC.
- Команда `--version` теперь берёт версию из package.json (раньше была
  захардкожена как v0.1.0).

### English
- Added a "changelog" button in the status bar: shows up when an update is
  available, or right after updating to a new version. Opens a window with
  the list of changes (RU on top, EN below), scrollable with the mouse and
  arrow keys.
- You can now leave the current room by pressing ESC.
- `--version` now reads the version from package.json (previously hardcoded
  as v0.1.0).

## 0.1.15

### Русский
- Добавлен выход из текущей комнаты клавишей ESC.
- Команда `--version` теперь берёт версию из package.json (раньше была
  захардкожена как v0.1.0).

### English
- You can now leave the current room by pressing ESC.
- `--version` now reads the version from package.json (previously hardcoded
  as v0.1.0).