# DJ Mix

A DJ-style track analysis and BPM-based mixing application built with Electron, React, and TypeScript.

## Tech Stack Decision

**Electron + React + TypeScript** was chosen over a web-only approach because:

1. **File System Access**: DJs need seamless access to their local music library. Electron provides native file dialogs and direct file system access, while web browsers require user interaction for each file selection.

2. **Audio Processing**: While Web Audio API works in browsers, Electron allows better integration with audio processing libraries and provides more reliable performance for real-time audio manipulation.

3. **Persistent Storage**: Local caching of BPM analysis results is simpler and more reliable with file-based storage in Electron's user data directory.

4. **No Server Required**: The app runs entirely locally without needing a backend server.

## Features

- **Import & Analyze**: Load multiple audio files (MP3, WAV, FLAC, OGG, AAC, M4A, AIFF)
- **Beat Grid Analysis**: Tempo to a thousandth of a BPM, downbeats, and drifting-tempo tracking (runs in a Web Worker)
- **Phrase Structure**: Intro / build / drop / breakdown / outro on the 8-bar grid, shown on the waveform
- **Loudness**: Integrated LUFS and true peak per track (ITU-R BS.1770)
- **BPM Normalization**: Handles double-time/half-time detection errors
- **Manual BPM Override**: Correct detected BPM when needed
- **Track Library**: Sort and filter tracks by BPM, name, or duration
- **Reference Track**: Select a track and see others sorted by BPM similarity
- **Dual Decks**: Load tracks to Deck A or Deck B
- **Playback Controls**: Play, pause, seek with waveform visualization
- **Tempo Sync**: Match a track's tempo to a target BPM
- **Two Playback Modes**:
  - **Rate Mode**: Changes playback speed (affects both tempo and pitch)
  - **Stretch Mode**: Attempts to preserve pitch while changing tempo
- **Crossfader**: Equal-power blend between Deck A and Deck B
- **Volume Controls**: Per-deck volume and master volume
- **Analysis Caching**: BPM results are cached locally to avoid recomputation

## Setup

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
# Install dependencies
npm install

# Start development mode
npm run dev
```

### Build for Production

```bash
npm run build:electron
```

### Build a Windows Installer

This app is an Electron desktop app, so the simplest way to share it with a Windows user is to send them the packaged installer.

```bash
# Build a Windows x64 installer
npm run build:win
```

The installer is written to:

```text
dist/djmix Setup 1.0.0.exe
```

Upload that `.exe` to a file-sharing service or a GitHub Release and send your friend the link. Because the app is not code-signed, Windows may show a SmartScreen warning; for a private test build your friend can choose "More info" and then "Run anyway". For public distribution, use a Windows code-signing certificate.

If your friend wants to run the project from source instead, they need Node.js 18+ and npm, then:

```bash
npm install
npm run dev
```

## Libraries Used

| Library                     | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| **Electron**                | Desktop app framework with native file access |
| **React**                   | UI framework                                  |
| **TypeScript**              | Type safety                                   |
| **Vite**                    | Fast development bundler                      |
| **SoundTouchJS**            | Time-stretching with pitch preservation       |
| **uuid**                    | Unique track identifiers                      |

## Architecture

```
src/
├── audio/              # Audio processing modules
│   ├── analysis/       # Beat grid, downbeats, phrases, loudness (pure; worker + Node CLI)
│   ├── engine/         # Mix graph, deck player, audio-clock transport (shared by app and offline tests)
│   ├── decoder.ts      # Audio file decoding
│   ├── fileImporter.ts # File import & metadata
│   ├── playbackEngine.ts # Deck playback control
│   ├── mixingEngine.ts # Crossfader & mixing
│   ├── stretchEngine.ts # Pitch-preserving stretch
│   └── persistence.ts  # Analysis caching
├── components/         # React UI components
│   ├── Deck.tsx        # Deck controls
│   ├── Mixer.tsx       # Crossfader & master
│   ├── TrackLibrary.tsx # Track list & filters
│   └── Waveform.tsx    # Waveform visualization
├── store/              # State management
│   └── AppContext.tsx  # React Context + reducer
├── types/              # TypeScript type definitions
└── styles/             # CSS styles
```

## Tradeoffs

### Track Analysis

- Tuned for 4/4 music with a kick on the beat; tracks without a steady kick get a low confidence
- The grid locks to the kick's attack; tempo drift is followed with measured beat positions
- Downbeats come from chord/energy changes and claps on 2 and 4, so very minimal loops can be ambiguous
- BPM is normalized to 85-175 range to handle double/half-time errors
- Users can manually override detected BPM

### Pitch-Preserving Stretch

- Uses SoundTouchJS which provides basic time-stretching
- Quality is acceptable but not studio-grade
- Rate mode (pitch changes with tempo) is more reliable

### Waveform

- Shows amplitude overview, not full frequency analysis
- Good enough for visual navigation
- Not a substitute for proper beat grid display

### Caching

- Uses file name + size + duration as cache key
- Not as robust as audio fingerprinting but works for most cases
- Cache is stored in Electron's user data directory

## Known Limitations

1. **Drifting Tempo Sync**: Drifting-tempo tracks are analysed, but deck sync still assumes a constant tempo
2. **No Key Detection**: Musical key analysis not implemented
3. **No Effects**: No EQ, filters, or audio effects
4. **Crossfader Curve**: Equal-power only, no curve options
5. **No Cue Points**: Cannot set/recall cue points
6. **Stretch Quality**: Pitch-preserving stretch may have artifacts at extreme tempo changes
7. **Large Files**: Very long audio files may take time to decode and analyze

## Next Steps

### Short Term

- [ ] Add keyboard shortcuts for transport controls
- [ ] Improve waveform with beat markers
- [ ] Add cue point support
- [ ] Implement EQ (low/mid/high) per deck

### Medium Term

- [ ] Beat grid detection and display
- [ ] Key detection (Camelot/Open Key notation)
- [ ] Crossfader curve options
- [ ] Loop mode (set loop in/out points)

### Long Term

- [ ] Warp markers for flexible beat alignment
- [ ] Audio effects (filter, delay, reverb)
- [ ] Recording/export mix
- [ ] MIDI controller support

## Development

```bash
# Type check
npm run typecheck

# Unit + offline-render tests (Vitest, Web Audio via node-web-audio-api)
npm test

# Analyse audio files or folders and print grid, downbeat, loudness and phrases
npm run analyze -- ~/Music/some-folder

# Development with hot reload
npm run dev

# Build production app
npm run build:electron
```

## License

MIT
