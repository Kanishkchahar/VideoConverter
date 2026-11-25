use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct ProgressEvent {
    percent: f64,
    message: String,
}

#[derive(Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    duration_seconds: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    size_bytes: Option<u64>,
}

#[tauri::command]
fn ffmpeg_info() -> Result<String, String> {
    let output = Command::new(resolve_tool("ffmpeg"))
        .arg("-version")
        .output()
        .map_err(|_| "FFmpeg was not found. Install FFmpeg and make sure it is on your PATH.".to_string())?;

    if !output.status.success() {
        return Err("FFmpeg could not start. Check your installation.".into());
    }

    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("FFmpeg ready")
        .split_whitespace()
        .nth(2)
        .unwrap_or("ready")
        .to_string();
    Ok(version)
}

#[tauri::command]
fn inspect_media(input_path: String) -> Result<MediaInfo, String> {
    if !std::path::Path::new(&input_path).is_file() {
        return Err("The selected file could not be found.".into());
    }
    let output = Command::new(resolve_tool("ffprobe"))
        .args([
            "-v", "error", "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height", "-of", "json",
        ])
        .arg(input_path)
        .output()
        .map_err(|_| "FFprobe was not found. Install FFmpeg with FFprobe and make sure it is on your PATH.".to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let probe: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read media details: {error}"))?;
    let video = probe.streams.iter().find(|stream| stream.codec_type.as_deref() == Some("video"));
    let audio = probe.streams.iter().find(|stream| stream.codec_type.as_deref() == Some("audio"));
    let duration_seconds = probe.format.as_ref()
        .and_then(|format| format.duration.as_deref())
        .and_then(|duration| duration.parse().ok());
    let size_bytes = probe.format.as_ref()
        .and_then(|format| format.size.as_deref())
        .and_then(|size| size.parse().ok());

    Ok(MediaInfo {
        duration_seconds,
        width: video.and_then(|stream| stream.width),
        height: video.and_then(|stream| stream.height),
        video_codec: video.and_then(|stream| stream.codec_name.clone()),
        audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
        size_bytes,
    })
}

#[tauri::command]
async fn convert_media(
    app: AppHandle,
    input_path: String,
    output_path: String,
    output_format: String,
    operation: String,
    quality: u8,
    use_hardware: bool,
    trim_start: Option<f64>,
    trim_duration: Option<f64>,
    resize_preset: Option<String>,
    resize_width: Option<u32>,
    resize_height: Option<u32>,
    rotation: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        convert_media_blocking(
            app, input_path, output_path, output_format, operation, quality, use_hardware,
            trim_start, trim_duration, resize_preset, resize_width, resize_height, rotation,
        )
    })
    .await
    .map_err(|error| format!("Conversion worker failed: {error}"))?
}

fn convert_media_blocking(
    app: AppHandle,
    input_path: String,
    output_path: String,
    output_format: String,
    operation: String,
    quality: u8,
    use_hardware: bool,
    trim_start: Option<f64>,
    trim_duration: Option<f64>,
    resize_preset: Option<String>,
    resize_width: Option<u32>,
    resize_height: Option<u32>,
    rotation: String,
) -> Result<(), String> {
    let allowed = ["mp4", "mkv", "mov", "webm", "mp3", "wav", "flac"];
    if !allowed.contains(&output_format.as_str()) {
        return Err("That output format is not supported by this app yet.".into());
    }
    if !["convert", "compress", "trim", "resize", "extract-audio"].contains(&operation.as_str()) {
        return Err("Choose a supported media action.".into());
    }
    if operation == "extract-audio" && !["mp3", "wav", "flac"].contains(&output_format.as_str()) {
        return Err("Choose MP3, WAV, or FLAC for audio extraction.".into());
    }
    if operation == "resize" && !["mp4", "mkv", "mov", "webm"].contains(&output_format.as_str()) {
        return Err("Choose a video format when resizing.".into());
    }
    if operation == "trim" && trim_start.is_some_and(|start| !start.is_finite() || start < 0.0) {
        return Err("The start time must be zero or greater.".into());
    }
    if operation == "trim" && trim_duration.is_some_and(|duration| !duration.is_finite() || duration <= 0.0) {
        return Err("The trim duration must be greater than zero.".into());
    }
    if operation == "resize" && !["1080p", "720p", "480p", "original", "custom"].contains(&resize_preset.as_deref().unwrap_or("")) {
        return Err("Choose a supported resize preset.".into());
    }
    if operation == "resize" && !["none", "clockwise", "half", "counterclockwise"].contains(&rotation.as_str()) {
        return Err("Choose a supported rotation.".into());
    }
    if operation == "resize" && resize_preset.as_deref() == Some("custom") {
        let valid_dimension = |dimension: Option<u32>| dimension.is_some_and(|value| (16..=7680).contains(&value));
        if !valid_dimension(resize_width) || !valid_dimension(resize_height) {
            return Err("Custom width and height must be between 16 and 7680 pixels.".into());
        }
    }
    if input_path == output_path {
        return Err("Choose a different output file so the source is kept safe.".into());
    }
    if !std::path::Path::new(&input_path).is_file() {
        return Err("The selected input file could not be found.".into());
    }

    let quality = quality.clamp(1, 10);
    let source_duration = probe_duration(&input_path).unwrap_or(0.0);
    let trim_start = if operation == "trim" { trim_start.unwrap_or(0.0) } else { 0.0 };
    if operation == "trim" && source_duration > 0.0 && trim_start >= source_duration {
        return Err("The start time is past the end of this file.".into());
    }
    let trim_duration = if operation == "trim" { trim_duration } else { None };
    let progress_duration = if operation == "trim" {
        trim_duration.unwrap_or_else(|| (source_duration - trim_start).max(0.0))
    } else {
        source_duration
    };
    let resize_preset = if operation == "resize" { resize_preset.as_deref() } else { None };
    let resize_width = if resize_preset == Some("custom") { resize_width } else { None };
    let resize_height = if resize_preset == Some("custom") { resize_height } else { None };
    let rotation = if operation == "resize" { rotation.as_str() } else { "none" };
    let encoders = available_video_encoders();
    let hardware_encoder = if use_hardware && is_h264_output(&output_format) {
        preferred_hardware_encoder(&encoders)
    } else {
        None
    };

    let result = if let Some(encoder) = hardware_encoder.as_deref() {
        emit_progress(&app, 0.0, format!("Trying {encoder} hardware encoding…"));
        let hardware_result = run_ffmpeg(
            &app,
            &input_path,
            &output_path,
            &output_format,
            &operation,
            quality,
            Some(encoder),
            trim_start,
            trim_duration,
            resize_preset,
            resize_width,
            resize_height,
            rotation,
            progress_duration,
        );
        if hardware_result.is_ok() {
            hardware_result
        } else {
            let _ = std::fs::remove_file(&output_path);
            emit_progress(&app, 0.0, "Hardware encoding unavailable; retrying with CPU…".into());
            run_ffmpeg(
                &app, &input_path, &output_path, &output_format, &operation, quality, None,
                trim_start, trim_duration, resize_preset, resize_width, resize_height, rotation,
                progress_duration,
            )
        }
    } else {
        if use_hardware && is_h264_output(&output_format) {
            emit_progress(&app, 0.0, "No supported hardware encoder found; using CPU…".into());
        } else {
            emit_progress(&app, 0.0, "Preparing conversion…".into());
        }
        run_ffmpeg(
            &app, &input_path, &output_path, &output_format, &operation, quality, None,
            trim_start, trim_duration, resize_preset, resize_width, resize_height, rotation,
            progress_duration,
        )
    };

    match result {
        Ok(()) => {
            emit_progress(&app, 100.0, "Conversion complete".into());
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::remove_file(&output_path);
            Err(error)
        }
    }
}

fn is_h264_output(format: &str) -> bool {
    matches!(format, "mp4" | "mkv" | "mov")
}

fn available_video_encoders() -> HashSet<String> {
    let output = match Command::new(resolve_tool("ffmpeg")).args(["-hide_banner", "-encoders"]).output() {
        Ok(output) if output.status.success() => output,
        _ => return HashSet::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let flags = parts.next()?;
            if !flags.starts_with('V') || flags.len() < 6 {
                return None;
            }
            parts.next().map(str::to_string)
        })
        .collect()
}

fn preferred_hardware_encoder(encoders: &HashSet<String>) -> Option<String> {
    #[cfg(target_os = "windows")]
    let candidates = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];
    #[cfg(target_os = "macos")]
    let candidates = ["h264_videotoolbox"];
    #[cfg(target_os = "linux")]
    let candidates = ["h264_nvenc", "h264_qsv", "h264_amf"];
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let candidates: [&str; 0] = [];

    candidates
        .iter()
        .find(|candidate| encoders.contains(**candidate))
        .map(|candidate| (*candidate).to_string())
}

fn probe_duration(input_path: &str) -> Option<f64> {
    let output = Command::new(resolve_tool("ffprobe"))
        .args([
            "-v", "error", "-show_entries", "format=duration", "-of",
            "default=noprint_wrappers=1:nokey=1", input_path,
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn run_ffmpeg(
    app: &AppHandle,
    input_path: &str,
    output_path: &str,
    output_format: &str,
    operation: &str,
    quality: u8,
    hardware_encoder: Option<&str>,
    trim_start: f64,
    trim_duration: Option<f64>,
    resize_preset: Option<&str>,
    resize_width: Option<u32>,
    resize_height: Option<u32>,
    rotation: &str,
    duration: f64,
) -> Result<(), String> {
    let mut command = Command::new(resolve_tool("ffmpeg"));
    command.args(["-y", "-hide_banner", "-v", "error", "-progress", "pipe:1"]);
    if operation == "trim" && trim_start > 0.0 {
        command.arg("-ss").arg(format!("{trim_start:.3}"));
    }
    command.arg("-i").arg(input_path);
    if operation == "trim" {
        if let Some(seconds) = trim_duration {
            command.arg("-t").arg(format!("{seconds:.3}"));
        }
    }

    match output_format {
        "mp3" => {
            command.args(["-map", "0:a:0?", "-vn", "-c:a", "libmp3lame", "-q:a"])
                .arg(audio_quality(quality));
        }
        "wav" => {
            command.args(["-map", "0:a:0?", "-vn", "-c:a", "pcm_s16le"]);
        }
        "flac" => {
            command.args(["-map", "0:a:0?", "-vn", "-c:a", "flac", "-compression_level"])
                .arg(flac_level(quality));
        }
        "webm" => {
            let vp9_crf = (55_i16 - (i16::from(quality) - 1) * 3).clamp(25, 55).to_string();
            command.args([
                "-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "libvpx-vp9", "-crf",
            ]);
            command.arg(vp9_crf).args(["-b:v", "0", "-c:a", "libopus", "-b:a", "160k"]);
        }
        _ => {
            command.args(["-map", "0:v:0?", "-map", "0:a:0?"]);
            if let Some(encoder) = hardware_encoder {
                command.args(["-c:v", encoder]);
                if encoder == "h264_mf" {
                    command.args(["-hw_encoding", "1"]);
                }
                let bitrate = (2.0 + f32::from(quality) * 0.8).round().to_string() + "M";
                command.arg("-b:v").arg(bitrate);
            } else {
                let crf = (33_i16 - (i16::from(quality) - 1) * 2).clamp(18, 33).to_string();
                command.args(["-c:v", "libx264", "-preset", "medium", "-crf"]).arg(crf);
            }
            command.args(["-c:a", "aac", "-b:a", "192k"]);
            if output_format == "mp4" {
                command.args(["-movflags", "+faststart"]);
            }
        }
    }

    if operation == "resize" {
        let mut filters = Vec::new();
        match rotation {
            "clockwise" => filters.push("transpose=clock".to_string()),
            "half" => filters.push("hflip,vflip".to_string()),
            "counterclockwise" => filters.push("transpose=cclock".to_string()),
            "none" => {}
            _ => return Err("Choose a supported rotation.".into()),
        }

        let size_filter = match resize_preset.unwrap_or("720p") {
            "1080p" => Some("scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2".to_string()),
            "720p" => Some("scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2".to_string()),
            "480p" => Some("scale=w='min(854,iw)':h='min(480,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2".to_string()),
            "custom" => {
                let width = resize_width.ok_or("Enter a custom width.")?;
                let height = resize_height.ok_or("Enter a custom height.")?;
                Some(format!("scale=w='min({width},iw)':h='min({height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"))
            }
            "original" => None,
            _ => return Err("Choose a supported resize preset.".into()),
        };
        if let Some(filter) = size_filter {
            filters.push(filter);
        }
        if !filters.is_empty() {
            command.arg("-vf").arg(filters.join(","));
        }
    }

    let muxer = if output_format == "mkv" { "matroska" } else { output_format };
    command.args(["-f", muxer, output_path]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        format!("Could not start FFmpeg: {error}. Install FFmpeg and make sure it is on your PATH.")
    })?;
    let stderr = child.stderr.take().ok_or("Could not read FFmpeg errors.")?;
    let stderr_reader = thread::spawn(move || {
        let mut message = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut message);
        message
    });

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().flatten() {
            if let Some(value) = line.strip_prefix("out_time=") {
                if let Some(seconds) = parse_ffmpeg_time(value) {
                    if duration > 0.0 {
                        let percent = (seconds / duration * 100.0).clamp(0.0, 99.0);
                        emit_progress(app, percent, "Converting media…".into());
                    }
                }
            } else if line == "progress=end" {
                emit_progress(app, 99.0, "Finishing output file…".into());
            }
        }
    }

    let status = child.wait().map_err(|error| format!("Could not wait for FFmpeg: {error}"))?;
    let error_text = stderr_reader.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let detail = error_text.trim();
        if detail.is_empty() {
            Err(format!("FFmpeg exited with status {status}."))
        } else {
            Err(detail.to_string())
        }
    }
}

fn parse_ffmpeg_time(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

fn audio_quality(quality: u8) -> String {
    let value = (10_i16 - i16::from(quality)).clamp(0, 9);
    value.to_string()
}

fn flac_level(quality: u8) -> String {
    let value = (u16::from(quality) - 1) * 8 / 9;
    value.to_string()
}

fn emit_progress(app: &AppHandle, percent: f64, message: String) {
    let _ = app.emit("conversion-progress", ProgressEvent { percent, message });
}

fn resolve_tool(name: &str) -> PathBuf {
    let override_key = if name == "ffprobe" { "FFPROBE_PATH" } else { "FFMPEG_PATH" };
    if let Some(path) = env::var_os(override_key).map(PathBuf::from).filter(|path| path.is_file()) {
        return path;
    }

    let executable = if cfg!(target_os = "windows") && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            let candidate = directory.join(&executable);
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    #[cfg(target_os = "macos")]
    let common_paths = [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
    ];
    #[cfg(target_os = "linux")]
    let common_paths = [
        format!("/usr/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/snap/bin/{name}"),
    ];
    #[cfg(target_os = "windows")]
    let common_paths = [
        format!(r"C:\ffmpeg\bin\{executable}"),
        format!(r"C:\Program Files\FFmpeg\bin\{executable}"),
        executable.clone(),
    ];
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let common_paths = [executable.clone()];

    common_paths
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(executable))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ffmpeg_info, inspect_media, convert_media])
        .run(tauri::generate_context!())
        .expect("error while running MediaDesk");
}
