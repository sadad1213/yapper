# yapper

Fast, low-memory **CLI voice chat** for the terminal. No server to start, no
accounts — run it on a LAN (or a Hamachi/Radmin VPN) and start talking. Mouse-
driven TUI with rooms, a live mic meter, and a built-in audio setup wizard.

```
╭ yapper ──────────────────────────────────────────── ● 192.168.1.5:4747 ╮
│ ROOMS                 │ general                               2 online │
│ ───────────────────── │ ────────────────────────────────────────────── │
│ ▸ general           2 │ ◉ you (you)      speaking                      │
│ ├─ me (you)           │ ○ alice          idle                          │
│ └─ alice              │                                                │
│   gaming            2 │                                                │
│ ├─ bob                │                                                │
│ └─ cara               │                                                │
│   music             0 │                                                │
│ ───────────────────── │ your mic   ████████░░░░░░                      │
│ + new room            │                                                │
├───────────────────────┴────────────────────────────────────────────────┤
│[M] mute  [N] new room  [S] settings  [C] changelog  [Q] quit    v0.1.22│
╰────────────────────────────────────────────────────────────────────────╯
```

The left sidebar lists **every room and who's in it** — not just your current
one — so you can see who's hanging out in `music` while you sit in `general`.
You show up under your own room marked `(you)`. After an update, a transient
`[C] changelog` hint appears next to the version (bottom-right) with what
changed in RU + EN, and auto-hides after 30 seconds.

## Install

From GitHub tarball (no npm account needed):

```bash
npm install -g https://github.com/sadad1213/yapper/archive/refs/heads/main.tar.gz
```

Then run:

```bash
yapper
```

> First run shows a one-time audio setup wizard (installs SoX automatically, or
> builds native `naudiodon` if you prefer). Press `3` to skip and run without audio.

## How it works

There is **no separate server**. Each `yapper` instance discovers a host on the
local network; if none exists, it becomes the host itself. Everyone shares the
host's rooms. If the host leaves, a remaining peer takes over automatically.

Discovery uses UDP broadcast across every network interface (including VPN
adapters), which works where mDNS/multicast usually doesn't.

## Usage

```bash
yapper                  # join the LAN: find a host, or become one
yapper connect <ip>     # connect to a specific peer (e.g. a Hamachi/Radmin IP)
yapper server           # run a dedicated headless host (no UI)
yapper setup            # (re)configure the audio backend
yapper --help
```

### In the TUI

- **Arrows / mouse** — navigate and click rooms / users
- **Enter / click** — join a room (or open a user's volume popup)
- **ESC** — leave the current room (or close any open popup/modal)
- **M** — mute / unmute yourself
- **N** — create a new room (`+ new room` lives at the bottom of the sidebar)
- **S** — settings (username, microphone, mic test, VAD sensitivity)
- **C** — open the changelog (shown after an update, to the left of the version; auto-hides after 30s)
- **U** — install the latest update (shown in the status bar when one is available)
- **Q** — quit

### Over Hamachi / Radmin

Usually auto-discovery works. If broadcast is blocked by the VPN, one person
shares their VPN IP and the other runs:

```bash
yapper connect 26.92.195.35
```

## Audio backends

| Backend | Quality | Install |
|---------|---------|---------|
| **SoX** | good | auto-installed by the setup wizard (winget / scoop / choco / direct) |
| **naudiodon** | best, lets you pick a device | needs Visual Studio Build Tools; `npm i naudiodon --build-from-source` |

Audio is OPUS-encoded at 48 kHz with voice-activity detection and a jitter
buffer for smooth playback.

## Requirements

- Node.js ≥ 18
- A terminal with mouse support (Windows Terminal, most modern terminals)

## License

MIT
