# ClipForge

A WinForms + ffmpeg media toolbox for Windows.

## Features

- A/V merge (single / batch)
- Audio extraction
- Video cutting (visual range selection)
- Video joining
- Picture adjustments (rotate / crop / color)
- Format conversion (including GIF export)
- Video download (m3u8 / direct links)

## Project Structure

```text
.
├─ src/                  # C# source
│  ├─ ClipForge.cs
│  └─ Snapshot.cs
├─ lib/                  # Third-party tools (e.g. N_m3u8DL-CLI)
├─ docs/
│  └─ 使用说明.txt
├─ dist/                 # Build output (gitignored)
├─ build.ps1             # Build script
└─ README.md
```

## Build

Requirements: Windows + .NET Framework 4.x (`csc.exe`).

```powershell
./build.ps1
```

Output: `dist/ClipForge.exe` (third-party tools from `lib/` are copied to `dist/lib/`).

## Dependencies

- [ffmpeg / ffprobe](https://ffmpeg.org/) - core processing (auto-detected at runtime, can be set manually)
- [N_m3u8DL-CLI](https://github.com/nilaoda/N_m3u8DL-CLI) - optional, for m3u8 downloads

## Usage

Run `dist/ClipForge.exe`. See [docs/使用说明.txt](docs/使用说明.txt) (Chinese).
