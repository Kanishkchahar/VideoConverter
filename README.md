# MediaDesk

MediaDesk is a cross-platform desktop GUI for FFmpeg. The interface is built with web technologies and packaged as a native desktop app with Tauri. Media files are processed locally by the FFmpeg executable on the user's computer.

## Current features

- Choose a local audio or video file with a native file picker.
- Drop a media file onto the app and view its duration, dimensions, codecs, and file size.
- Convert to MP4, MKV, MOV, WebM, MP3, WAV, or FLAC.
- Compress video or MP3 audio with a quality control.
- Trim a clip by start time and duration.
- Resize video to 1080p, 720p, or 480p, set custom bounds, or rotate it while preserving its aspect ratio.
- Extract audio to MP3, WAV, or FLAC.
- Adjust H.264/VP9 video quality, MP3 audio quality, or FLAC compression level.
- Try an available H.264 hardware encoder on Windows, macOS, or Linux, with CPU fallback.
- Show conversion progress and save to a chosen local path.

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
