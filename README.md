# yapper

Fast, low-memory **CLI voice chat** for the terminal. No server to start, no
accounts — run it on a LAN (or a Hamachi/Radmin VPN) and start talking. Mouse-
driven TUI with rooms, a live mic meter, and a built-in audio setup wizard.

```
╭ yapper ─────────────────────────── ● 192.168.1.5:4747 ─╮
│ ROOMS               │ general                  2 online │
│ ─────────────       │ ──────────────────────────────────│
│ ▸ general    2      │  ◉ you (you)        speaking       │
│   gaming     0      │  ○ alice            idle           │
│   music      0      │                                    │
│   + new room        │  your mic   ████████░░░░░░          │
├─────────────────────┴────────────────────────────────────┤
│ [M] mute  [N] new room  [S] settings  [Q] quit          │
╰──────────────────────────────────────────────────────────╯
```

## Install

From GitHub (no npm account needed):

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

- **Arrows / mouse** — navigate and click rooms
- **Enter / click** — join a room
- **M** — mute / unmute
- **N** — create a new room
- **S** — settings (username, microphone, mic test)
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
