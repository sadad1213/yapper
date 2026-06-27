# Changelog

Всё, что менялось в каждой версии yapper. Сначала на русском (RU),
ниже — перевод на английский (EN).

Everything that changed in each yapper release. Russian (RU) comes first,
English (EN) translation below.

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