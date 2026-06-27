# Changelog

Всё, что менялось в каждой версии yapper. Сначала на русском (RU),
ниже — перевод на английский (EN).

Everything that changed in each yapper release. Russian (RU) comes first,
English (EN) translation below.

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