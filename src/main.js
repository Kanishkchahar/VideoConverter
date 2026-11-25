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
  gif: { label: "GIF", extension: "gif", kind: "video" },
  mp3: { label: "MP3", extension: "mp3", kind: "audio" },
  wav: { label: "WAV", extension: "wav", kind: "audio" },
  flac: { label: "FLAC", extension: "flac", kind: "audio" },
};

const operationCopy = {
  convert: "Change the file format while keeping its video and audio.",
  compress: "Make a smaller file by choosing a more compact quality setting.",
  trim: "Keep a section of the file. Enter start time and duration (e.g. 0:30, 1:15, or seconds).",
  resize: "Resize, set custom dimensions, or rotate the video while preserving its shape.",
  "extract-audio": "Save the soundtrack as an MP3, WAV, or FLAC file.",
};

const inputExtensions = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpeg", "mpg", "ts", "mts",
  "m2ts", "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff",
  "3gp", "3g2", "wmv", "flv", "vob", "mxf", "mpg", "amr", "gif",
];

const elementIds = [
  "file-picker", "file-name", "file-path", "file-details", "file-thumb-box", "file-thumbnail",
  "detail-duration", "detail-resolution", "detail-codecs", "detail-size",
  "format-select", "quality-range", "quality-name", "quality-field", "quality-caption",
  "quality-low", "quality-high", "hardware-row", "hardware-toggle", "mute-row", "mute-toggle",
  "operation-description", "trim-controls", "trim-start", "trim-duration",
  "resize-controls", "resize-preset", "custom-size-fields", "resize-width", "resize-height",
  "rotation-select", "convert-button", "notice", "progress-panel", "recent-list", "recent-empty",
  "clear-history", "progress-message", "progress-stats", "progress-percent", "progress-bar",
  "progress-track", "cancel-button", "completion-actions", "btn-open-file", "btn-reveal-folder",
  "ffmpeg-badge", "ffmpeg-status",
];

const els = Object.fromEntries(
  elementIds.map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]),
);

const operationTabs = [...document.querySelectorAll(".action-tab")];
const historyStorageKey = "mediadesk:recent-exports-v2";
const operationLabels = {
  convert: "Converted",
  compress: "Compressed",
  trim: "Trimmed",
  resize: "Resized",
  "extract-audio": "Audio extracted",
};

let inputPath = null;
let lastExportedPath = null;
let ffmpegReady = false;
let converting = false;
let activeOperation = "convert";
let lastVideoFormat = "mp4";
let lastAudioFormat = "mp3";
let inputRequestId = 0;
const desktopAvailable = Boolean(window.__TAURI_INTERNALS__?.invoke);
let recentHistory = readRecentHistory();

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

function parseTimeInput(val) {
  if (val == null) return null;
  const trimmed = String(val).trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }
  const parts = trimmed.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p))) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
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

function readRecentHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem(historyStorageKey) || "[]");
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry
      && typeof entry.fileName === "string"
      && typeof entry.operation === "string"
      && typeof entry.format === "string"
      && typeof entry.completedAt === "string")
      .slice(0, 10);
  } catch {
    return [];
  }
}

function saveRecentHistory() {
  try {
    localStorage.setItem(historyStorageKey, JSON.stringify(recentHistory));
  } catch {
    // Keep the current session usable if browser storage is unavailable.
  }
}

function formatRecentTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Saved";
  const minutesAgo = Math.floor((Date.now() - date.getTime()) / 60_000);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (minutesAgo < 1) return "Just now";
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  if (date.toDateString() === new Date().toDateString()) return `Today, ${time}`;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function renderRecentHistory() {
  els.recent_list.replaceChildren();
  const hasHistory = recentHistory.length > 0;
  els.recent_empty.hidden = hasHistory;
  els.recent_list.hidden = !hasHistory;
  els.clear_history.disabled = !hasHistory;

  for (const entry of recentHistory) {
    const item = document.createElement("li");
    item.className = "recent-item";

    const formatBadge = document.createElement("span");
    formatBadge.className = `recent-format ${formats[entry.format]?.kind === "audio" ? "audio" : "video"}`;
    formatBadge.textContent = formats[entry.format]?.label || entry.format.toUpperCase();
    formatBadge.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "recent-copy";

    const fileName = document.createElement("span");
    fileName.className = "recent-file";
    fileName.textContent = entry.fileName;
    fileName.title = entry.filePath || entry.fileName;

    const description = document.createElement("span");
    description.className = "recent-description";
    description.textContent = `${operationLabels[entry.operation] || "Exported"} · ${formats[entry.format]?.label || entry.format.toUpperCase()}`;

    copy.append(fileName, description);

    const rightCol = document.createElement("div");
    rightCol.className = "recent-right";

    const time = document.createElement("time");
    time.className = "recent-time";
    time.dateTime = entry.completedAt;
    time.textContent = formatRecentTime(entry.completedAt);
    rightCol.append(time);

    if (entry.filePath && desktopAvailable) {
      const actions = document.createElement("div");
      actions.className = "recent-actions";

      const playBtn = document.createElement("button");
      playBtn.className = "recent-icon-btn";
      playBtn.type = "button";
      playBtn.title = "Play exported file";
      playBtn.setAttribute("aria-label", `Play ${entry.fileName}`);
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m8 5 11 7-11 7z"/></svg>`;
      playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        invoke("open_media_file", { path: entry.filePath }).catch((err) => showNotice(String(err), "error"));
      });

      const folderBtn = document.createElement("button");
      folderBtn.className = "recent-icon-btn";
      folderBtn.type = "button";
      folderBtn.title = "Show in folder";
      folderBtn.setAttribute("aria-label", `Show ${entry.fileName} in folder`);
      folderBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v13h18V7H12l-2-2H3z"/></svg>`;
      folderBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        invoke("show_in_folder", { path: entry.filePath }).catch((err) => showNotice(String(err), "error"));
      });

      actions.append(playBtn, folderBtn);
      rightCol.append(actions);
    }

    item.append(formatBadge, copy, rightCol);
    els.recent_list.append(item);
  }
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
  els.mute_toggle.disabled = converting || els.mute_row.hidden;
  els.trim_start.disabled = converting;
  els.trim_duration.disabled = converting;
  els.resize_preset.disabled = converting;
  els.resize_width.disabled = converting;
  els.resize_height.disabled = converting;
  els.rotation_select.disabled = converting;
  operationTabs.forEach((tab) => { tab.disabled = converting; });
}

function updateFormatControls() {
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
  const isGif = activeFormatKey === "gif";
  const qualitySupported = activeFormatKey !== "wav" && !isGif;

  els.quality_field.hidden = !qualitySupported;
  els.quality_range.disabled = !qualitySupported || converting;

  if (qualitySupported) {
    els.quality_caption.textContent = activeFormat.kind === "audio"
      ? (activeFormatKey === "flac" ? "Compression level" : "Audio quality")
      : (activeOperation === "compress" ? "Size and quality" : "Video quality");
    els.quality_low.textContent = activeFormatKey === "flac" ? "Faster" : "Smaller file";
    els.quality_high.textContent = activeFormatKey === "flac" ? "Smaller file" : "Better quality";
  }

  // Hardware acceleration: only available for H.264 formats (mp4, mkv, mov)
  const supportsHardware = ["mp4", "mkv", "mov"].includes(activeFormatKey);
  els.hardware_row.hidden = activeFormat.kind === "audio" || isGif;
  els.hardware_row.classList.toggle("disabled", !supportsHardware);
  els.hardware_toggle.disabled = !supportsHardware || converting;

  // Mute row: available for video outputs except GIF (which has no audio)
  els.mute_row.hidden = activeFormat.kind === "audio" || isGif;
  els.mute_toggle.disabled = els.mute_row.hidden || converting;

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
  els.file_thumb_box.hidden = true;
  els.file_thumbnail.src = "";
  els.notice.hidden = true;
  els.completion_actions.hidden = true;
  updateButton();

  try {
    const info = await invoke("inspect_media", { inputPath: path });
    if (thisRequest === inputRequestId) {
      renderFileDetails(info);
      // Fetch thumbnail frame for video
      if (info.width || info.videoCodec) {
        invoke("get_thumbnail", { inputPath: path })
          .then((thumbDataUrl) => {
            if (thisRequest === inputRequestId && thumbDataUrl) {
              els.file_thumbnail.src = thumbDataUrl;
              els.file_thumb_box.hidden = false;
            }
          })
          .catch(() => {});
      }
    }
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

async function cancelConversion() {
  if (!converting) return;
  els.cancel_button.disabled = true;
  els.cancel_button.textContent = "Cancelling…";
  try {
    await invoke("cancel_conversion");
    showNotice("Conversion cancelled.", "info");
  } catch (error) {
    showNotice(String(error), "error");
  }
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
  els.progress_stats.textContent = "";
  els.cancel_button.disabled = false;
  els.cancel_button.textContent = "Cancel";
  els.notice.hidden = true;
  els.completion_actions.hidden = true;

  const parsedStart = activeOperation === "trim" ? parseTimeInput(els.trim_start.value) : null;
  const parsedDuration = activeOperation === "trim" ? parseTimeInput(els.trim_duration.value) : null;

  try {
    await invoke("convert_media", {
      inputPath,
      outputPath: desiredPath,
      outputFormat: els.format_select.value,
      operation: activeOperation,
      quality: Number(els.quality_range.value),
      useHardware: els.hardware_toggle.checked,
      trimStart: parsedStart != null ? parsedStart : 0,
      trimDuration: parsedDuration,
      resizePreset: activeOperation === "resize" ? els.resize_preset.value : null,
      resizeWidth: activeOperation === "resize" ? Number(els.resize_width.value) : null,
      resizeHeight: activeOperation === "resize" ? Number(els.resize_height.value) : null,
      rotation: activeOperation === "resize" ? els.rotation_select.value : "none",
      muteAudio: els.mute_toggle.checked && !els.mute_row.hidden,
    });

    els.progress_bar.style.width = "100%";
    els.progress_track.setAttribute("aria-valuenow", "100");
    els.progress_percent.textContent = "100%";
    els.progress_message.textContent = "Conversion complete";
    els.progress_stats.textContent = "";

    lastExportedPath = desiredPath;
    els.completion_actions.hidden = false;

    recentHistory = [{
      fileName: basename(desiredPath),
      filePath: desiredPath,
      operation: activeOperation,
      format: els.format_select.value,
      completedAt: new Date().toISOString(),
    }, ...recentHistory.filter((item) => item.filePath !== desiredPath)].slice(0, 10);

    saveRecentHistory();
    renderRecentHistory();
    showNotice(`Successfully saved ${basename(desiredPath)}`, "success");
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
els.cancel_button.addEventListener("click", () => cancelConversion().catch((error) => showNotice(String(error), "error")));
operationTabs.forEach((tab) => tab.addEventListener("click", () => setOperation(tab.dataset.operation)));
els.resize_preset.addEventListener("change", updateCustomSizeFields);
els.clear_history.addEventListener("click", () => {
  recentHistory = [];
  saveRecentHistory();
  renderRecentHistory();
});

els.btn_open_file.addEventListener("click", () => {
  if (lastExportedPath && desktopAvailable) {
    invoke("open_media_file", { path: lastExportedPath }).catch((err) => showNotice(String(err), "error"));
  }
});

els.btn_reveal_folder.addEventListener("click", () => {
  if (lastExportedPath && desktopAvailable) {
    invoke("show_in_folder", { path: lastExportedPath }).catch((err) => showNotice(String(err), "error"));
  }
});

updateQualityLabel();
updateFormatControls();
renderRecentHistory();

if (!desktopAvailable) {
  setEngine(false, "Desktop app required");
  showNotice("This is a browser preview. Open MediaDesk with npm run tauri dev to use local files and FFmpeg.", "info");
} else {
  listen("conversion-progress", (event) => {
    const { percent, message, etaSeconds, speed } = event.payload;
    const safePercent = Math.max(0, Math.min(100, percent));
    els.progress_bar.style.width = `${safePercent}%`;
    els.progress_track.setAttribute("aria-valuenow", String(Math.round(safePercent)));
    els.progress_percent.textContent = `${Math.round(percent)}%`;
    els.progress_message.textContent = message;

    const statsParts = [];
    if (speed) {
      statsParts.push(`Speed: ${speed}`);
    }
    if (etaSeconds != null && Number.isFinite(etaSeconds) && etaSeconds > 0) {
      const remainingRounded = Math.round(etaSeconds);
      if (remainingRounded < 60) {
        statsParts.push(`~${remainingRounded}s left`);
      } else {
        const m = Math.floor(remainingRounded / 60);
        const s = remainingRounded % 60;
        statsParts.push(`~${m}m ${s}s left`);
      }
    }
    els.progress_stats.textContent = statsParts.join(" · ");
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
