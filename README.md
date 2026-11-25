# MediaDesk

MediaDesk is a cross-platform desktop GUI for FFmpeg. The interface is built with web technologies and packaged as a native desktop app with Tauri. Media files are processed locally by the FFmpeg executable on the user's computer.

## Features

- **Select or Drop Media**: Choose local video or audio files via native file picker or drag and drop.
- **Visual Thumbnail Preview & Metadata**: Inspect duration, dimensions, codecs, file size, and preview a poster frame thumbnail.
- **Broad Format Conversion**: Convert to MP4, MKV, MOV, WebM, animated GIF, MP3, WAV, or FLAC.
- **High-Quality Animated GIF Export**: Two-pass palette generation for smooth, crisp GIF animation from video clips.
- **Audio Strip / Mute**: Toggle to remove audio tracks for silent video exports.
- **Compression & Quality Controls**: Fine-tune H.264/VP9 video quality, MP3 bitrate quality, or FLAC compression level.
- **Flexible Trimming**: Set start and duration using seconds or standard timecode (`MM:SS`, `HH:MM:SS`).
- **Video Adjustment**: Resize to 1080p, 720p, 480p, custom dimensions, or rotate (90°, 180°, 270°) while preserving aspect ratio.
- **Audio Extraction**: Extract soundtracks directly to MP3, WAV, or FLAC.
- **Hardware Acceleration**: Automatic GPU encoder detection (NVENC, QuickSync, AMF, VideoToolbox) with graceful CPU fallback.
- **Live Progress & Speed/ETA**: Track conversion percentage with real-time encoding speed and estimated remaining time.
- **Process Cancellation**: Cancel ongoing conversions at any time with immediate process termination and cleanup.
- **Post-Export Quick Actions & History**: One-click "Play exported file" and "Show in folder" from the notification card or recent exports list.

## Requirements

- Node.js 20 or newer and npm.
- Rust and Cargo.
- Tauri's platform build dependencies (WebView2 on Windows, WebKitGTK on Linux, and Xcode command line tools on macOS).
- FFmpeg and FFprobe installed and available on `PATH`.

FFmpeg is not bundled in this initial version. This keeps the installer small and avoids redistributing a particular FFmpeg build. The app checks for FFmpeg when it starts. Hardware encoding is used only when the installed FFmpeg exposes an encoder supported by the operating system and the user's drivers/hardware support it; otherwise video conversion uses the CPU.

## Run in development

```sh
npm install
npm run tauri dev
```

## Build installers for Windows, macOS, and Linux

Build on each target operating system with its matching command:

```sh
npm install
npm run icons
npm run tauri build -- --bundles nsis,msi # Windows
npm run tauri build -- --bundles dmg     # macOS
npm run tauri build -- --bundles deb,appimage # Linux
```

Windows creates MSI and NSIS installers, macOS creates a DMG, and Linux creates Debian and AppImage packages. The GitHub Actions workflow builds all three on matching hosted runners, makes a universal macOS build, and saves each installer as a workflow artifact. macOS distribution outside local development may also require signing and notarization; Windows may require signing to avoid publisher warnings.

## Notes

- FFmpeg is launched with direct process arguments, not through a shell.
- The quality control changes H.264/VP9 video quality, MP3 quality, or FLAC's lossless compression level. WAV is uncompressed.
- Hardware encoding is available for H.264 outputs. Actual support depends on the FFmpeg build, device, and driver. A failed hardware attempt is retried with the CPU encoder.
