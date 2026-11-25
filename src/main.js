import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./style.css";

const formats = {
  mp4: { label: "MP4", extension: "mp4", kind: "video" },
  mkv: { label: "MKV", extension: "mkv", kind: "video" },
  mov: { label: "MOV", extension: "mov", kind: "video" },
  webm: { label: "WebM", extension: "webm", kind: "video" },
  mp3: { label: "MP3", extension: "mp3", kind: "audio" },
  wav: { label: "WAV", extension: "wav", kind: "audio" },
  flac: { label: "FLAC", extension: "flac", kind: "audio" },
};

const operationCopy = {
  convert: "Change the file format while keeping its video and audio.",
  compress: "Make a smaller file by choosing a more compact quality setting.",
  trim: "Keep a section of the file. Enter times in seconds; leave duration blank to keep the rest.",
  resize: "Resize, set custom dimensions, or rotate the video while preserving its shape.",
  "extract-audio": "Save the soundtrack as an MP3, WAV, or FLAC file.",
};

const inputExtensions = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "ts", "mts",
  "m2ts", "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff",
  "3gp", "3g2", "wmv", "flv", "vob", "mxf", "mpg", "amr",
];

const els = Object.fromEntries(
  [
    "file-picker", "file-name", "file-path", "file-details", "detail-duration",
    "detail-resolution", "detail-codecs", "detail-size", "format-select", "quality-range",
    "quality-name", "quality-field", "quality-caption", "quality-low", "quality-high", "hardware-row", "hardware-toggle",
    "operation-description", "trim-controls", "trim-start", "trim-duration",
    "resize-controls", "resize-preset", "custom-size-fields", "resize-width", "resize-height",
    "rotation-select", "convert-button", "notice", "progress-panel",
    "progress-message", "progress-percent", "progress-bar", "progress-track", "ffmpeg-badge", "ffmpeg-status",
  ].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]),
);

const operationTabs = [...document.querySelectorAll(".action-tab")];
let inputPath = null;
let ffmpegReady = false;
let converting = false;
let activeOperation = "convert";
let lastVideoFormat = "mp4";
let lastAudioFormat = "mp3";
let inputRequestId = 0;
const desktopAvailable = Boolean(window.__TAURI_INTERNALS__?.invoke);

function showNotice(message, kind = "info") {
  els.notice.textContent = message;
  els.notice.className = `notice ${kind}`;
  els.notice.hidden = false;
}

function setEngine(ready, message) {
  ffmpegReady = ready;
  els.ffmpeg_badge.className = `engine-badge ${ready ? "ready" : "missing"}`;
  els.ffmpeg_status.textContent = message;
  updateButton();
}

function basename(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Duration unavailable";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function renderFileDetails(info) {
  const codecs = [
    info.videoCodec ? `Video: ${info.videoCodec}` : null,
    info.audioCodec ? `Audio: ${info.audioCodec}` : null,
  ].filter(Boolean).join(" · ");
  const details = [
    [els.detail_duration, info.durationSeconds == null ? null : `Duration ${formatDuration(info.durationSeconds)}`],
    [els.detail_resolution, info.width && info.height ? `Resolution ${info.width} × ${info.height}` : null],
    [els.detail_codecs, codecs || null],
    [els.detail_size, info.sizeBytes == null ? null : `File size ${formatBytes(info.sizeBytes)}`],
  ];
  for (const [element, value] of details) {
    element.textContent = value || "";
    element.hidden = !value;
  }
  els.file_details.hidden = details.every(([, value]) => !value);
}

function updateButton() {
  els.file_picker.disabled = !desktopAvailable || converting;
  els.convert_button.disabled = !desktopAvailable || !ffmpegReady || !inputPath || converting;
  els.format_select.disabled = converting;
  els.quality_range.disabled = converting || els.quality_field.hidden;
  els.hardware_toggle.disabled = converting || els.hardware_row.hidden || els.hardware_row.classList.contains("disabled");
  els.trim_start.disabled = converting;
  els.trim_duration.disabled = converting;
  els.resize_preset.disabled = converting;
  els.resize_width.disabled = converting;
  els.resize_height.disabled = converting;
  els.rotation_select.disabled = converting;
  operationTabs.forEach((tab) => { tab.disabled = converting; });
}

function updateFormatControls() {
  const formatKey = els.format_select.value;
  const audioMode = activeOperation === "extract-audio";
  const videoMode = activeOperation === "resize";

  for (const option of els.format_select.options) {
    option.disabled = (audioMode && formats[option.value].kind !== "audio")
      || (videoMode && formats[option.value].kind !== "video");
  }
  if (els.format_select.selectedOptions[0]?.disabled) {
    els.format_select.value = audioMode ? lastAudioFormat : lastVideoFormat;
  }

  const activeFormatKey = els.format_select.value;
  const activeFormat = formats[activeFormatKey];
  const qualitySupported = activeFormatKey !== "wav";
  els.quality_field.hidden = !qualitySupported;
  els.quality_range.disabled = !qualitySupported || converting;
  els.quality_caption.textContent = activeFormat.kind === "audio"
    ? (activeFormatKey === "flac" ? "Compression level" : "Audio quality")
    : (activeOperation === "compress" ? "Size and quality" : "Video quality");
  els.quality_low.textContent = activeFormatKey === "flac" ? "Faster" : "Smaller file";
  els.quality_high.textContent = activeFormatKey === "flac" ? "Smaller file" : "Better quality";
  els.hardware_row.hidden = activeFormat.kind === "audio";
  els.hardware_row.classList.toggle("disabled", activeFormatKey === "webm");
  els.hardware_toggle.disabled = activeFormat.kind === "audio" || activeFormatKey === "webm" || converting;
  updateQualityLabel();
  updateButton();
}

function updateQualityLabel() {
  const value = Number(els.quality_range.value);
  const videoNames = {
    1: "Smallest", 2: "Smaller", 3: "Smaller", 4: "Balanced", 5: "Balanced",
    6: "Balanced", 7: "High", 8: "High", 9: "Very high", 10: "Maximum",
  };
  const flacNames = {
    1: "Fastest", 2: "Fast", 3: "Fast", 4: "Balanced", 5: "Balanced",
    6: "Compact", 7: "Compact", 8: "Smaller", 9: "Smaller", 10: "Smallest",
  };
  const names = els.format_select.value === "flac" ? flacNames : videoNames;
  els.quality_name.textContent = names[value] || "Balanced";
}

function setOperation(operation) {
  activeOperation = operation;
  operationTabs.forEach((tab) => {
    const active = tab.dataset.operation === operation;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  els.operation_description.textContent = operationCopy[operation];
  els.trim_controls.hidden = operation !== "trim";
  els.resize_controls.hidden = operation !== "resize";
  updateCustomSizeFields();

  const labels = {
    convert: "Convert file",
    compress: "Compress file",
    trim: "Trim file",
    resize: "Resize video",
    "extract-audio": "Extract audio",
  };
  els.convert_button.querySelector("span").textContent = labels[operation];
  if (operation === "compress") {
    els.quality_range.value = els.format_select.value === "flac" ? "10" : "4";
  }
  updateQualityLabel();
  updateFormatControls();
}

function updateCustomSizeFields() {
  els.custom_size_fields.hidden = els.resize_preset.value !== "custom";
}

function rememberFormat() {
  const format = formats[els.format_select.value];
  if (format.kind === "audio") lastAudioFormat = els.format_select.value;
  else lastVideoFormat = els.format_select.value;
  updateFormatControls();
}

async function selectInput(path) {
  inputPath = path;
  const thisRequest = ++inputRequestId;
  els.file_name.textContent = basename(path);
  els.file_path.textContent = path;
  els.file_picker.classList.add("has-file");
  els.file_details.hidden = true;
  els.notice.hidden = true;
  updateButton();

  try {
    const info = await invoke("inspect_media", { inputPath: path });
    if (thisRequest === inputRequestId) renderFileDetails(info);
  } catch {
    if (thisRequest === inputRequestId) {
      els.file_details.hidden = true;
      showNotice("File details are unavailable. You can still try converting this file.", "info");
    }
  }
}

async function chooseInput() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Media files", extensions: inputExtensions }],
  });
  if (!path || Array.isArray(path)) return;
  await selectInput(path);
}

async function startConversion() {
  if (!inputPath || !ffmpegReady || converting) return;
  const format = formats[els.format_select.value];
  const inputName = basename(inputPath).replace(/\.[^.]+$/, "");
  const suffix = {
    convert: "converted", compress: "compressed", trim: "trimmed",
    resize: "resized", "extract-audio": "audio",
  }[activeOperation];
  const outputPath = await save({
    defaultPath: `${inputName}-${suffix}.${format.extension}`,
    filters: [{ name: format.label, extensions: [format.extension] }],
  });
  if (!outputPath) return;

  const desiredPath = outputPath.toLowerCase().endsWith(`.${format.extension}`)
    ? outputPath
    : `${outputPath}.${format.extension}`;

  converting = true;
  updateButton();
  els.progress_panel.hidden = false;
  els.progress_bar.style.width = "0%";
  els.progress_track.setAttribute("aria-valuenow", "0");
  els.progress_percent.textContent = "0%";
  els.progress_message.textContent = "Starting FFmpeg…";
  els.notice.hidden = true;

  try {
    await invoke("convert_media", {
      inputPath,
      outputPath: desiredPath,
      outputFormat: els.format_select.value,
      operation: activeOperation,
      quality: Number(els.quality_range.value),
      useHardware: els.hardware_toggle.checked,
      trimStart: activeOperation === "trim" ? Number(els.trim_start.value || 0) : null,
      trimDuration: activeOperation === "trim" && els.trim_duration.value
        ? Number(els.trim_duration.value)
        : null,
      resizePreset: activeOperation === "resize" ? els.resize_preset.value : null,
      resizeWidth: activeOperation === "resize" ? Number(els.resize_width.value) : null,
      resizeHeight: activeOperation === "resize" ? Number(els.resize_height.value) : null,
      rotation: activeOperation === "resize" ? els.rotation_select.value : "none",
    });
    els.progress_bar.style.width = "100%";
    els.progress_track.setAttribute("aria-valuenow", "100");
    els.progress_percent.textContent = "100%";
    els.progress_message.textContent = "Conversion complete";
    showNotice(`Saved ${basename(desiredPath)}`, "success");
  } catch (error) {
    els.progress_panel.hidden = true;
    showNotice(String(error), "error");
  } finally {
    converting = false;
    updateButton();
  }
}

els.file_picker.addEventListener("click", () => chooseInput().catch((error) => showNotice(String(error), "error")));
els.format_select.addEventListener("change", rememberFormat);
els.quality_range.addEventListener("input", updateQualityLabel);
els.convert_button.addEventListener("click", () => startConversion().catch((error) => showNotice(String(error), "error")));
operationTabs.forEach((tab) => tab.addEventListener("click", () => setOperation(tab.dataset.operation)));
els.resize_preset.addEventListener("change", updateCustomSizeFields);

updateQualityLabel();
updateFormatControls();

if (!desktopAvailable) {
  setEngine(false, "Desktop app required");
  showNotice("This is a browser preview. Open MediaDesk with npm run tauri dev to use local files and FFmpeg.", "info");
} else {
  listen("conversion-progress", (event) => {
    const { percent, message } = event.payload;
    const safePercent = Math.max(0, Math.min(100, percent));
    els.progress_bar.style.width = `${safePercent}%`;
    els.progress_track.setAttribute("aria-valuenow", String(Math.round(safePercent)));
    els.progress_percent.textContent = `${Math.round(percent)}%`;
    els.progress_message.textContent = message;
  }).catch(() => {});

  getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "over") {
      els.file_picker.classList.add("drag-over");
    } else {
      els.file_picker.classList.remove("drag-over");
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        selectInput(event.payload.paths[0]);
      }
    }
  }).catch(() => {});

  invoke("ffmpeg_info")
    .then((version) => setEngine(true, `FFmpeg ${version}`))
    .catch((error) => {
      setEngine(false, "FFmpeg not found");
      showNotice(String(error), "error");
    });
}
