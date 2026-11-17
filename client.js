/**
 * dsh-file-support 的浏览器半侧。
 *
 * 给右侧边栏的文档预览挂上「更多格式」的渲染器，第一个是音频。
 *
 * 接的扩展点是 `dsh-client-ui-sidebar-documentpreview` 留出的两个口子：
 *   1. `ctx.documentPreviews.register(definition)` —— 声明扩展名、加载方式、优先级；
 *   2. keyed slot `sidebar.right.tab.document` 里同 id 的 body 组件 —— 真正画界面。
 *
 * 音频用 `loading: 'bytes-complete'`：owner 会把整份文件字节读进来交给我们，
 * 我们把它包成 Blob URL 丢给 `<audio>`，再用 Web Audio 解一遍画波形。
 * Host 的 `maxFileBytes`（默认 32 MiB）兜住超大的文件，超限时 owner 自己报错。
 */
window.__ModuleLoader__.load({
  id: "@philomelcc/dsh-interaction",
  factory: function (require) {
    "use strict";

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    /** 设置页 / 开关状态共用的 HTTP 前缀。 */
    var API = "/plugins/dsh-interaction/api";

    /** 渲染器身份，同时也是 document slot 里的 keyed key。 */
    var AUDIO_BODY_ID = "dsh-file-support/audio";
    /** 本插件自己的文案命名空间。 */
    var AUDIO_LOCALE = "sidebarAudio";

    /**
     * 认领的音频后缀。
     *
     * 前半段是浏览器原生解码得动的（mp3 / wav / flac / ogg / opus / m4a / aac / weba / aiff），
     * 后半段在部分浏览器上解码不了（wma / ape / amr / mid），但仍然认领：
     * 至少给个「这个格式放不了，用系统播放器」的明确提示，比把二进制丢给文本预览好。
     */
    var AUDIO_EXTENSIONS = [
      "mp3",
      "wav",
      "flac",
      "ogg",
      "oga",
      "opus",
      "m4a",
      "m4b",
      "m4r",
      "aac",
      "weba",
      "aiff",
      "aif",
      "wma",
      "ape",
      "amr",
      "mid",
      "midi",
    ];

    /** 后缀 → Blob 的 MIME。 */
    var AUDIO_MEDIA_TYPES = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      flac: "audio/flac",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      opus: "audio/ogg",
      m4a: "audio/mp4",
      m4b: "audio/mp4",
      m4r: "audio/mp4",
      aac: "audio/aac",
      weba: "audio/webm",
      aiff: "audio/aiff",
      aif: "audio/aiff",
      wma: "audio/x-ms-wma",
      ape: "audio/x-ape",
      amr: "audio/amr",
      mid: "audio/midi",
      midi: "audio/midi",
    };

    /** 播放速度档位。 */
    var RATES = [0.75, 1, 1.25, 1.5, 2];

    /** 超过这个大小就不解波形了：decodeAudioData 会把整段 PCM 摊在内存里，太亏。 */
    var WAVE_DECODE_LIMIT = 24 * 1024 * 1024;

    /** 波形柱数上限，避免超宽屏画成一片实心。 */
    var MAX_WAVE_BARS = 220;

    // ───────────────────────────── 图片 ─────────────────────────────

    /** 图片渲染器身份，同时也是 document slot 里的 keyed key。 */
    var IMAGE_BODY_ID = "dsh-file-support/image";

    /**
     * 图片渲染器的文案命名空间。
     * 不要复用内置的 `sidebarImage`：同名 register 会和 documentpreview 抢字典。
     */
    var IMAGE_LOCALE = "dfsImage";

    /**
     * 认领的图片后缀。
     *
     * 前 8 个是内置渲染器本来就支持的；jfif / apng / avif / tif / tiff / heic / heif
     * 是这次顺手补的（能不能显示取决于浏览器，至少不会再被当文本预览）。
     */
    var IMAGE_EXTENSIONS = [
      "png",
      "jpg",
      "jpeg",
      "jfif",
      "gif",
      "apng",
      "webp",
      "avif",
      "bmp",
      "ico",
      "tif",
      "tiff",
      "heic",
      "heif",
      "svg",
    ];

    /**
     * 其中二进制（不可读作文本）的那部分。
     * SVG 故意不列进来：它的 XML 源码还有阅读价值，应该保留文本预览作为候选实现。
     */
    var IMAGE_BINARY_EXTENSIONS = [
      "png",
      "jpg",
      "jpeg",
      "jfif",
      "gif",
      "apng",
      "webp",
      "avif",
      "bmp",
      "ico",
      "tif",
      "tiff",
      "heic",
      "heif",
    ];

    /** 后缀 → Blob 的 MIME。 */
    var IMAGE_MEDIA_TYPES = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      jfif: "image/jpeg",
      gif: "image/gif",
      apng: "image/apng",
      webp: "image/webp",
      avif: "image/avif",
      bmp: "image/bmp",
      ico: "image/x-icon",
      tif: "image/tiff",
      tiff: "image/tiff",
      heic: "image/heic",
      heif: "image/heif",
      svg: "image/svg+xml",
    };

    /** 缩放上下限（相对图片原始像素）。 */
    var IMAGE_ZOOM_MIN = 0.02;
    var IMAGE_ZOOM_MAX = 16;

    /** 滚轮一格 / 按钮一下的缩放倍率。 */
    var IMAGE_ZOOM_STEP = 1.2;

    // ───────────────────────────── 纯函数 ─────────────────────────────

    /** 取文件名的小写后缀（不含点）。 */
    function extensionOf(path) {
      var name = String(path || "").replace(/\\/gu, "/");
      name = name.slice(name.lastIndexOf("/") + 1);
      var dot = name.lastIndexOf(".");
      return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
    }

    /** 后缀对应的音频 MIME，认不出来的返回空串。 */
    function audioMediaType(path) {
      return AUDIO_MEDIA_TYPES[extensionOf(path)] || "";
    }

    /** 后缀对应的图片 MIME，认不出来的返回空串。 */
    function imageMediaType(path) {
      return IMAGE_MEDIA_TYPES[extensionOf(path)] || "";
    }

    /** 把缩放值夹进上下限；非数字/Infinity 一律退回 1。 */
    function clampImageZoom(value) {
      var number = Number(value);
      if (!isFinite(number) || number <= 0) return 1;
      return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, number));
    }

    /**
     * 旋转 90° 的奇数倍时宽高互换。
     * @param width - 未旋转时的显示宽度。
     * @param height - 未旋转时的显示高度。
     * @param rotation - 旋转次数（0–3，每次 90°）。
     * @returns 旋转后的外接盒尺寸。
     */
    function rotatedSize(width, height, rotation) {
      var quarter = ((Number(rotation) || 0) % 4 + 4) % 4;
      return quarter % 2 === 1
        ? { width: height, height: width }
        : { width: width, height: height };
    }

    /**
     * 「适应窗口」的缩放：长边不超视口，且不比原始像素更大（小图保持 1:1）。
     * @param naturalWidth - 图片原始宽度。
     * @param naturalHeight - 图片原始高度。
     * @param rotation - 旋转次数（0–3）。
     * @param viewportWidth - 视口可用宽度。
     * @param viewportHeight - 视口可用高度。
     * @param inset - 四周留白。
     * @returns 缩放比例，1 表示原始像素大小。
     */
    function fitImageZoom(naturalWidth, naturalHeight, rotation, viewportWidth, viewportHeight, inset) {
      var box = rotatedSize(naturalWidth, naturalHeight, rotation);
      if (!(box.width > 0) || !(box.height > 0)) return 1;
      var pad = typeof inset === "number" ? inset * 2 : 32;
      var availableWidth = Math.max(1, viewportWidth - pad);
      var availableHeight = Math.max(1, viewportHeight - pad);
      if (!(viewportWidth > 0) || !(viewportHeight > 0)) return 1;
      return clampImageZoom(
        Math.min(1, availableWidth / box.width, availableHeight / box.height)
      );
    }

    /** 旋转次数的可读标注：0 / 90 / 180 / 270。 */
    function rotationDegrees(rotation) {
      var quarter = ((Number(rotation) || 0) % 4 + 4) % 4;
      return quarter * 90;
    }

    /**
     * 从 `dsh-resource://file/session/<sessionId>/<path>` 还原文件路径。
     * 解析不出来时返回空串，界面会退化成「未知文件」。
     */
    function sessionFilePath(address) {
      var text = String(address || "");
      var marker = "dsh-resource://file/session/";
      if (text.indexOf(marker) !== 0) return "";
      var rest = text.slice(marker.length);
      var slash = rest.indexOf("/");
      if (slash < 0) return "";
      var raw = rest.slice(slash + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }

    /** 路径里的文件名（解码后）。 */
    function fileNameOf(address) {
      var path = sessionFilePath(address).replace(/\\/gu, "/");
      return path.slice(path.lastIndexOf("/") + 1);
    }

    /** 秒数 → `mm:ss` / `h:mm:ss`。 */
    function formatTime(seconds) {
      if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) {
        return "--:--";
      }
      var total = Math.floor(seconds);
      var hours = Math.floor(total / 3600);
      var minutes = Math.floor((total % 3600) / 60);
      var secs = total % 60;
      function pad(value) {
        return value < 10 ? "0" + value : String(value);
      }
      return hours > 0
        ? hours + ":" + pad(minutes) + ":" + pad(secs)
        : pad(minutes) + ":" + pad(secs);
    }

    /** 字节数 → 人类可读。 */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "";
      var units = ["B", "KB", "MB", "GB"];
      var value = bytes;
      var unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      var digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
      return value.toFixed(digits) + " " + units[unit];
    }

    /**
     * 把整段 PCM 压成 `bins` 个峰值（0–1），用来画波形。
     * @param buffer - 一段带 `getChannelData(0)` 的 AudioBuffer（或同形状对象）。
     * @param bins - 目标柱数。
     * @returns 归一化后的峰值数组；没有可用采样时返回 null。
     */
    function computePeaks(buffer, bins) {
      var channel = buffer && typeof buffer.getChannelData === "function"
        ? buffer.getChannelData(0)
        : null;
      if (!channel || channel.length === 0 || bins <= 0) return null;
      var count = Math.min(bins, channel.length);
      var step = channel.length / count;
      var peaks = new Float32Array(count);
      var loudest = 0;
      for (var i = 0; i < count; i += 1) {
        var start = Math.floor(i * step);
        var end = Math.min(channel.length, Math.ceil((i + 1) * step));
        var max = 0;
        // 大文件不用每个采样都看，跳着抽样足够画图。
        var stride = Math.max(1, Math.floor((end - start) / 256));
        for (var j = start; j < end; j += stride) {
          var value = channel[j];
          if (value < 0) value = -value;
          if (value > max) max = value;
        }
        peaks[i] = max;
        if (max > loudest) loudest = max;
      }
      if (loudest <= 0) return peaks;
      for (var k = 0; k < count; k += 1) peaks[k] /= loudest;
      return peaks;
    }

    /**
     * 解码音频并抽波形。失败一律 resolve(null) —— 波形是锦上添花，不能影响播放。
     * @param data - 文件字节。
     * @param signal - tab 的 AbortSignal（关 tab 就别解了）。
     * @returns `{ peaks, sampleRate, channels }` 或 null。
     */
    function decodeWaveform(data, signal) {
      var AudioCtx = typeof window !== "undefined" &&
        (window.AudioContext || window.webkitAudioContext);
      if (!AudioCtx || !data || data.byteLength === 0) return Promise.resolve(null);
      if (data.byteLength > WAVE_DECODE_LIMIT) return Promise.resolve(null);
      // 拷贝一份：decodeAudioData 会接管（detach）传入的 ArrayBuffer。
      var copy = data.slice().buffer;
      var audioContext = null;
      try {
        audioContext = new AudioCtx();
      } catch {
        return Promise.resolve(null);
      }
      function close() {
        if (audioContext && audioContext.state !== "closed") {
          return audioContext.close().catch(function () {});
        }
        return Promise.resolve();
      }
      return audioContext
        .decodeAudioData(copy)
        .then(function (buffer) {
          return {
            peaks: computePeaks(buffer, 180),
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
          };
        })
        .catch(function () {
          return null;
        })
        .then(function (result) {
          return close().then(function () {
            return result;
          });
        });
    }

    function abortError() {
      var error = new Error("aborted");
      error.name = "AbortError";
      return error;
    }

    /** 组件里统一取文案：拿不到 t 时退回 key 本身。 */
    function bindingOf(props) {
      return typeof props.t === "function"
        ? props.t
        : function (key) {
            return key;
          };
    }

    // ───────────────────────────── 图标 ─────────────────────────────

    function GlyphPlay() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true" },
        h("path", { d: "M8 5.2v13.6L19 12z", fill: "currentColor" })
      );
    }

    function GlyphPause() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true" },
        h("rect", { x: 6.5, y: 5, width: 3.6, height: 14, rx: 1.2, fill: "currentColor" }),
        h("rect", { x: 13.9, y: 5, width: 3.6, height: 14, rx: 1.2, fill: "currentColor" })
      );
    }

    function GlyphVolume(props) {
      var muted = props.muted;
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M4 9.5v5h3.2L11.5 18V6L7.2 9.5H4z",
          fill: "currentColor",
        }),
        muted
          ? h("path", {
              d: "M14.4 9.2l4.6 5.6M19 9.2l-4.6 5.6",
              stroke: "currentColor",
              strokeWidth: 1.7,
              strokeLinecap: "round",
              fill: "none",
            })
          : h("path", {
              d: "M14.2 9.1a4.4 4.4 0 0 1 0 5.8",
              stroke: "currentColor",
              strokeWidth: 1.7,
              strokeLinecap: "round",
              fill: "none",
            })
      );
    }

    function GlyphNote() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" },
        h("path", {
          d: "M9 17.4a2.6 2.6 0 1 1-1.6-2.4V6.6l9-1.9v9.5a2.6 2.6 0 1 1-1.6-2.4V7.3L9 8.6z",
          fill: "currentColor",
          opacity: 0.92,
        })
      );
    }

    function GlyphRotateCounterClockwise() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M7.9 8.4H4.4V4.9",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
        }),
        h("path", {
          d: "M4.7 8.1a7 7 0 1 1-.6 6.2",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          fill: "none",
        })
      );
    }

    function GlyphRotateClockwise() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M16.1 8.4h3.5V4.9",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
        }),
        h("path", {
          d: "M19.3 8.1a7 7 0 1 0 .6 6.2",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          fill: "none",
        })
      );
    }

    function GlyphMinus() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M5.5 12h13",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          fill: "none",
        })
      );
    }

    function GlyphPlus() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M12 5.5v13M5.5 12h13",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          fill: "none",
        })
      );
    }

    function GlyphFit() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" },
        h("path", {
          d: "M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
        })
      );
    }

    function GlyphImage() {
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" },
        h("rect", {
          x: 3.5,
          y: 5,
          width: 17,
          height: 14,
          rx: 2.4,
          stroke: "currentColor",
          strokeWidth: 1.6,
          fill: "none",
        }),
        h("circle", { cx: 9, cy: 10, r: 1.6, fill: "currentColor" }),
        h("path", {
          d: "M5 17.2l4.4-4.2 3.1 2.9 2.6-2.5L20 17.6",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          fill: "none",
        })
      );
    }

    // ───────────────────────────── 波形 ─────────────────────────────

    /**
     * 波形画布：已播放的柱子上亮色，未播放的压暗；点击/拖动由外层命中层负责。
     * @param props - `peaks`（可空）、`progress`（0–1）。
     */
    function Waveform(props) {
      var canvasRef = React.useRef(null);
      var peaks = props.peaks;
      var progress = props.progress;

      React.useEffect(function () {
        var canvas = canvasRef.current;
        if (!canvas) return undefined;
        var host = canvas.parentElement || canvas;

        function draw() {
          var rect = canvas.getBoundingClientRect();
          var width = Math.max(40, Math.round(rect.width));
          var height = Math.max(30, Math.round(rect.height));
          var dpr = window.devicePixelRatio || 1;
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
          var ctx = canvas.getContext("2d");
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, width, height);

          var styles = window.getComputedStyle(canvas);
          var playedColor = (styles.getPropertyValue("--dfs-played") || "").trim() || "#6ea8ff";
          var restColor = (styles.getPropertyValue("--dfs-rest") || "").trim() || "rgba(138,156,186,.34)";

          var gap = 3;
          var barWidth = 3;
          var bars = Math.max(16, Math.min(MAX_WAVE_BARS, Math.floor(width / (barWidth + gap))));
          var stride = (width - bars * barWidth) / Math.max(1, bars - 1);
          var mid = height / 2;
          var full = Math.max(6, height - 14);

          // 解不出波形时只留一条安静的中轴，不画假数据（否则提示文字会糊在柱子上）。
          if (!peaks || peaks.length === 0) {
            ctx.strokeStyle = restColor;
            ctx.globalAlpha = 0.55;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(8, mid);
            ctx.lineTo(width - 8, mid);
            ctx.stroke();
            ctx.globalAlpha = 1;
            return;
          }

          var cursor = Math.max(0, Math.min(1, progress));
          for (var i = 0; i < bars; i += 1) {
            var from = Math.floor((i / bars) * peaks.length);
            var to = Math.max(from + 1, Math.floor(((i + 1) / bars) * peaks.length));
            var max = 0;
            for (var p = from; p < to && p < peaks.length; p += 1) {
              if (peaks[p] > max) max = peaks[p];
            }
            var ratio = Math.max(0.06, max);
            var barHeight = Math.max(2, ratio * full);
            var x = i * (barWidth + stride);
            var played = bars > 1 ? i / (bars - 1) <= cursor : cursor >= 1;
            ctx.fillStyle = played ? playedColor : restColor;
            ctx.globalAlpha = played ? 0.95 : 1;
            ctx.beginPath();
            ctx.roundRect
              ? ctx.roundRect(x, mid - barHeight / 2, barWidth, barHeight, 1.5)
              : ctx.rect(x, mid - barHeight / 2, barWidth, barHeight);
            ctx.fill();
          }
          ctx.globalAlpha = 1;

          // 播放头
          if (cursor > 0 && cursor < 1) {
            var headX = cursor * width;
            ctx.strokeStyle = playedColor;
            ctx.globalAlpha = 0.9;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(headX, 3);
            ctx.lineTo(headX, height - 3);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }

        draw();
        var observer = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
        if (observer) observer.observe(host);
        window.addEventListener("resize", draw);
        return function () {
          if (observer) observer.disconnect();
          window.removeEventListener("resize", draw);
        };
      }, [peaks, progress]);

      return h("canvas", { ref: canvasRef, className: "dfs-wave" });
    }

    // ───────────────────────────── 播放器 ─────────────────────────────

    /**
     * 音频文档 body。
     *
     * 收到的是整份文件字节（`content.kind === 'bytes'`）。播放、进度、音量都交给隐藏的
     * `<audio>`，我们自己画控制条，图的是和 DSH 的深浅主题一致。
     */
    function AudioBody(props) {
      var t = bindingOf(props);
      var content = props.content || {};
      var data = content.kind === "bytes" ? content.data : null;
      var filePath = sessionFilePath(props.resourceAddress);
      var fileName = fileNameOf(props.resourceAddress);
      var fileExt = extensionOf(props.resourceAddress);
      var mediaType = audioMediaType(props.resourceAddress);

      var tabInfo = props.useTabInfo ? props.useTabInfo() : null;
      var tab = tabInfo && tabInfo.tab ? tabInfo.tab : null;
      var signal = tab && tab.signal ? tab.signal : null;
      var visible = tab ? tab.visible !== false : true;

      var audioRef = React.useRef(null);
      var [url, setUrl] = React.useState(null);
      var [playing, setPlaying] = React.useState(false);
      var [duration, setDuration] = React.useState(0);
      var [current, setCurrent] = React.useState(0);
      var [volume, setVolume] = React.useState(1);
      var [muted, setMuted] = React.useState(false);
      var [rate, setRate] = React.useState(1);
      var [error, setError] = React.useState(null);
      var [wave, setWave] = React.useState(null);
      var [wavePending, setWavePending] = React.useState(false);

      // 字节 → Blob URL，卸载时回收。
      React.useEffect(
        function () {
          if (!data || !mediaType) return undefined;
          var objectUrl = null;
          try {
            objectUrl = URL.createObjectURL(new Blob([data], { type: mediaType }));
          } catch {
            setError("failed");
            return undefined;
          }
          setError(null);
          setPlaying(false);
          setCurrent(0);
          setDuration(0);
          setUrl(objectUrl);
          return function () {
            URL.revokeObjectURL(objectUrl);
          };
        },
        [data, mediaType]
      );

      // 解波形（异步、失败静默）。
      React.useEffect(
        function () {
          setWave(null);
          if (!data || !mediaType) return undefined;
          if (data.byteLength > WAVE_DECODE_LIMIT) {
            setWavePending(false);
            return undefined;
          }
          var cancelled = false;
          // 小文件几乎瞬间解完，晚一点再亮「解析中」，避免闪一下。
          var reveal = setTimeout(function () {
            if (!cancelled) setWavePending(true);
          }, 120);
          decodeWaveform(data, signal).then(function (result) {
            if (cancelled) return;
            // 必须把 reveal 清掉：否则解码先完成、计时器随后把 pending 又设回 true，
            // 「正在解析波形…」会永久留在画面上。
            clearTimeout(reveal);
            setWavePending(false);
            if (result) setWave(result);
          });
          return function () {
            cancelled = true;
            clearTimeout(reveal);
          };
        },
        [data, mediaType]
      );

      // 关 tab 立刻停声，别让声音拖在后面。
      React.useEffect(
        function () {
          if (!signal) return undefined;
          function onAbort() {
            var el = audioRef.current;
            if (el) el.pause();
          }
          if (signal.aborted) {
            onAbort();
            return undefined;
          }
          signal.addEventListener("abort", onAbort);
          return function () {
            signal.removeEventListener("abort", onAbort);
          };
        },
        [signal]
      );

      // 面板收起、切到别的 tab、切到别的会话时 tab 不再 visible：
      // 停在原处而不是在背景里继续响。
      React.useEffect(
        function () {
          if (visible) return;
          var el = audioRef.current;
          if (el && !el.paused) el.pause();
        },
        [visible]
      );

      // 音量 / 静音 / 倍速同步到元素。
      React.useEffect(
        function () {
          var el = audioRef.current;
          if (!el) return;
          el.volume = volume;
          el.muted = muted;
          el.playbackRate = rate;
        },
        [volume, muted, rate, url]
      );

      function toggle() {
        var el = audioRef.current;
        if (!el) return;
        if (el.paused) {
          var attempt = el.play();
          if (attempt && typeof attempt.catch === "function") {
            attempt.catch(function () {
              setError("failed");
              setPlaying(false);
            });
          }
        } else {
          el.pause();
        }
      }

      function seekToRatio(ratio) {
        var el = audioRef.current;
        if (!el || !isFinite(el.duration) || el.duration <= 0) return;
        var next = Math.max(0, Math.min(1, ratio)) * el.duration;
        el.currentTime = next;
        setCurrent(next);
      }

      function seekBy(delta) {
        var el = audioRef.current;
        if (!el || !isFinite(el.duration) || el.duration <= 0) return;
        var next = Math.max(0, Math.min(el.duration, el.currentTime + delta));
        el.currentTime = next;
        setCurrent(next);
      }

      function pointerRatio(event) {
        var rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return 0;
        return (event.clientX - rect.left) / rect.width;
      }

      function cycleRate() {
        var index = RATES.indexOf(rate);
        setRate(RATES[(index + 1) % RATES.length]);
      }

      function onKeyDown(event) {
        var target = event.target;
        // 焦点在控件上时交给原生行为，否则空格会「原生 click + 这里 toggle」双触发。
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "BUTTON")
        ) {
          return;
        }
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          toggle();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          seekBy(-5);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          seekBy(5);
        }
      }

      var progress = duration > 0 ? current / duration : 0;

      var subtitle = [];
      if (fileExt) subtitle.push(fileExt.toUpperCase());
      if (data) subtitle.push(formatBytes(content.kind === "bytes" ? content.data.byteLength : 0));
      if (duration > 0) subtitle.push(formatTime(duration));
      // 比特率用「字节 × 8 ÷ 时长」算，比 AudioContext 的采样率可靠
      // （decodeAudioData 会把重采样到设备采样率，读出来的不是源文件的）。
      if (data && duration > 0) {
        var kbps = Math.round((content.data.byteLength * 8) / duration / 1000);
        if (kbps > 0) subtitle.push(t("bitrate", { rate: kbps }));
      }
      if (wave && wave.channels) subtitle.push(t("channels", { count: wave.channels }));

      var waveNote = null;
      if (!data) waveNote = t("waiting");
      else if (error) waveNote = t("waveUnavailable");
      // 已经有波形就不要再盖提示；pending 只在还没有波形时才显示。
      else if (!wave) waveNote = wavePending ? t("wavePending") : t("waveUnavailable");

      return h(
        "div",
        {
          className: "dfs-root",
          tabIndex: 0,
          onKeyDown: onKeyDown,
          "data-dsh-file-support": "audio",
        },
        h(
          "div",
          { className: "dfs-card" },
          h(
            "div",
            { className: "dfs-head" },
            h("div", { className: "dfs-art" }, h(GlyphNote)),
            h(
              "div",
              { className: "dfs-titles" },
              h(
                "div",
                { className: "dfs-name", title: filePath || fileName },
                fileName || t("unknownFile")
              ),
              h("div", { className: "dfs-sub" }, subtitle.length ? subtitle.join(" · ") : t("unknownDuration"))
            )
          ),
          h(
            "div",
            { className: "dfs-wave-wrap" },
            h(Waveform, { peaks: wave ? wave.peaks : null, progress: progress }),
            h("div", {
              className: "dfs-wave-hit",
              onPointerDown: function (event) {
                // 先 seek 再抓指针：合成事件可能没有真实 pointerId，
                // setPointerCapture 会抛 NotFoundError，不该拖累跳转。
                seekToRatio(pointerRatio(event));
                try {
                  event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                  /* 忽略：指针捕获只是拖动时的手势锁定 */
                }
              },
              onPointerMove: function (event) {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  seekToRatio(pointerRatio(event));
                }
              },
              onPointerUp: function (event) {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              },
            }),
            waveNote ? h("div", { className: "dfs-wave-note" }, waveNote) : null
          ),
          error
            ? h(
                "div",
                { className: "dfs-error", role: "alert" },
                t("failed"),
                h("small", null, t("failedHint"))
              )
            : null,
          h(
            "div",
            { className: "dfs-transport" },
            h(
              "button",
              {
                type: "button",
                className: "dfs-play",
                onClick: toggle,
                disabled: !url || Boolean(error),
                "aria-label": playing ? t("pause") : t("play"),
                title: playing ? t("pause") : t("play"),
              },
              playing ? h(GlyphPause) : h(GlyphPlay)
            ),
            h(
              "span",
              { className: "dfs-time" },
              formatTime(current) + " / " + formatTime(duration)
            ),
            h("span", { className: "dfs-spacer" }),
            h(
              "button",
              {
                type: "button",
                className: "dfs-rate",
                onClick: cycleRate,
                title: t("rate"),
                "aria-label": t("rate"),
              },
              (rate === 1 ? "1" : String(rate)) + "×"
            ),
            h(
              "span",
              { className: "dfs-vol" },
              h(
                "button",
                {
                  type: "button",
                  onClick: function () {
                    setMuted(!muted);
                  },
                  title: muted ? t("unmute") : t("mute"),
                  "aria-label": muted ? t("unmute") : t("mute"),
                },
                h(GlyphVolume, { muted: muted })
              ),
              h("input", {
                type: "range",
                min: 0,
                max: 1,
                step: 0.01,
                value: muted ? 0 : volume,
                "aria-label": t("volume"),
                onChange: function (event) {
                  var next = Number(event.target.value);
                  setVolume(next);
                  if (next > 0 && muted) setMuted(false);
                },
              })
            )
          ),
          h("audio", {
            ref: audioRef,
            src: url || undefined,
            preload: "metadata",
            style: { display: "none" },
            onPlay: function () {
              setPlaying(true);
            },
            onPause: function () {
              setPlaying(false);
            },
            onEnded: function () {
              setPlaying(false);
              setCurrent(duration);
            },
            onTimeUpdate: function (event) {
              setCurrent(event.currentTarget.currentTime);
            },
            onLoadedMetadata: function (event) {
              var el = event.currentTarget;
              setDuration(isFinite(el.duration) ? el.duration : 0);
              setCurrent(el.currentTime || 0);
              el.volume = volume;
              el.muted = muted;
              el.playbackRate = rate;
            },
            onDurationChange: function (event) {
              var el = event.currentTarget;
              if (isFinite(el.duration)) setDuration(el.duration);
            },
            onError: function () {
              setError("failed");
              setPlaying(false);
            },
          })
        )
      );
    }

    // ───────────────────────────── 图片预览 ─────────────────────────────

    /**
     * stage 的四周留白。
     * 必须和 CSS 里 `.dfs-img-stage` 的 padding 保持一致，否则「适应窗口」算出来会差一圈。
     */
    var IMAGE_STAGE_INSET = 16;

    /**
     * 图片预览主体。
     *
     * 交互：
     * - 滚轮（不按 Ctrl）直接缩放，以光标位置为锚点；
     * - 两个旋转按钮顺 / 逆时针各转 90°，转完把视野居中；
     * - 工具栏可切「适应窗口」和 100%，也能双击图片切换；
     * - 图片大于视口时按住拖动可以平移（原生滚动条照旧可用）。
     *
     * 尺寸用「重排」而不是 CSS scale：滚轮缩完浏览器会重新采样，
     * 放大后依然清晰，滚动条长度也直接跟着内容走。
     */
    function ImageBody(props) {
      var t = bindingOf(props);
      var content = props.content || {};
      var data = content.kind === "bytes" ? content.data : null;
      var filePath = sessionFilePath(props.resourceAddress);
      var fileName = fileNameOf(props.resourceAddress);
      var fileExt = extensionOf(props.resourceAddress);
      var mediaType = imageMediaType(props.resourceAddress);

      var stageRef = React.useRef(null);
      var canvasRef = React.useRef(null);

      var [url, setUrl] = React.useState(null);
      var [failed, setFailed] = React.useState(false);
      var [natural, setNatural] = React.useState(null);
      var [rotation, setRotation] = React.useState(0);
      var [mode, setMode] = React.useState("fit");
      var [fixedZoom, setFixedZoom] = React.useState(1);
      var [viewport, setViewport] = React.useState({ width: 0, height: 0 });
      var [panning, setPanning] = React.useState(false);

      var fitZoom = React.useMemo(
        function () {
          if (!natural) return 1;
          return fitImageZoom(
            natural.width,
            natural.height,
            rotation,
            viewport.width,
            viewport.height,
            IMAGE_STAGE_INSET
          );
        },
        [natural, rotation, viewport.width, viewport.height]
      );

      var zoom = mode === "fit" ? fitZoom : fixedZoom;
      // 事件回调里读最新值：重新绑定 wheel 监听太啰嗦，ref 更稳。
      var zoomRef = React.useRef(zoom);
      zoomRef.current = zoom;
      var dragRef = React.useRef(null);

      // 字节 → Blob URL，换文件时重置视野，卸载时回收。
      React.useEffect(
        function () {
          if (!data || !mediaType) return undefined;
          var objectUrl = null;
          try {
            objectUrl = URL.createObjectURL(new Blob([data], { type: mediaType }));
          } catch {
            setFailed(true);
            return undefined;
          }
          setFailed(false);
          setNatural(null);
          setRotation(0);
          setMode("fit");
          setFixedZoom(1);
          setUrl(objectUrl);
          return function () {
            URL.revokeObjectURL(objectUrl);
          };
        },
        [data, mediaType]
      );

      // 量视口尺寸（收起 / 展开侧边栏、拖宽都会变）。
      React.useLayoutEffect(function () {
        var stage = stageRef.current;
        if (!stage) return undefined;
        function measure() {
          var width = stage.clientWidth;
          var height = stage.clientHeight;
          setViewport(function (prev) {
            if (prev.width === width && prev.height === height) return prev;
            return { width: width, height: height };
          });
        }
        measure();
        if (typeof ResizeObserver !== "function") return undefined;
        var observer = new ResizeObserver(measure);
        observer.observe(stage);
        return function () {
          observer.disconnect();
        };
      }, []);

      // 旋转后把视野放回中心，免得 90° 一转图片就跑到角落里。
      React.useEffect(
        function () {
          var stage = stageRef.current;
          if (!stage) return;
          stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
          stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
        },
        [rotation]
      );

      /**
       * 缩放到 next，并让视口中 (clientX, clientY) 那个点尽量停着不动。
       * 没有坐标时以视口中心为锚点。
       */
      var applyZoom = React.useCallback(function (next, clientX, clientY) {
        var clamped = clampImageZoom(next);
        var stage = stageRef.current;
        var canvas = canvasRef.current;
        if (!stage || !canvas) {
          setMode("fixed");
          setFixedZoom(clamped);
          return;
        }
        var factor = clamped / (zoomRef.current || 1);
        var stageRect = stage.getBoundingClientRect();
        var canvasRect = canvas.getBoundingClientRect();
        var localX = clientX == null ? stageRect.width / 2 : clientX - stageRect.left;
        var localY = clientY == null ? stageRect.height / 2 : clientY - stageRect.top;
        var anchorX = clientX == null ? canvasRect.width / 2 : clientX - canvasRect.left;
        var anchorY = clientY == null ? canvasRect.height / 2 : clientY - canvasRect.top;
        zoomRef.current = clamped;
        setMode("fixed");
        setFixedZoom(clamped);
        // 等 React 把新尺寸写进 DOM，再按实际布局修正滚动位置。
        requestAnimationFrame(function () {
          var currentCanvas = canvasRef.current;
          var currentStage = stageRef.current;
          if (!currentCanvas || !currentStage) return;
          var nextRect = currentCanvas.getBoundingClientRect();
          var nextStageRect = currentStage.getBoundingClientRect();
          var canvasLeft = nextRect.left - nextStageRect.left + currentStage.scrollLeft;
          var canvasTop = nextRect.top - nextStageRect.top + currentStage.scrollTop;
          currentStage.scrollLeft = canvasLeft + anchorX * factor - localX;
          currentStage.scrollTop = canvasTop + anchorY * factor - localY;
        });
      }, []);

      // 滚轮缩放。必须用原生监听：React 的 onWheel 是 passive 的，preventDefault 无效。
      React.useEffect(
        function () {
          var stage = stageRef.current;
          if (!stage) return undefined;
          function onWheel(event) {
            event.preventDefault();
            var unit =
              event.deltaMode === 1
                ? 16
                : event.deltaMode === 2
                  ? stage.clientHeight
                  : 1;
            var delta = Math.max(-60, Math.min(60, event.deltaY * unit));
            applyZoom(zoomRef.current * Math.exp(-delta * 0.002), event.clientX, event.clientY);
          }
          stage.addEventListener("wheel", onWheel, { passive: false });
          return function () {
            stage.removeEventListener("wheel", onWheel);
          };
        },
        [applyZoom]
      );

      function zoomBy(factor) {
        applyZoom(zoomRef.current * factor);
      }

      function fitToWindow() {
        setMode("fit");
      }

      function toggleActualSize() {
        if (mode === "fit") {
          setMode("fixed");
          setFixedZoom(1);
        } else {
          setMode("fit");
        }
      }

      function rotateBy(delta) {
        setRotation(function (prev) {
          return (prev + delta + 4) % 4;
        });
      }

      function onPointerDown(event) {
        if (event.button !== 0) return;
        var stage = stageRef.current;
        if (!stage) return;
        // 图片没超出视口时没什么可拖的，交给原生文件拖拽 / 双击。
        var scrollableX = stage.scrollWidth > stage.clientWidth + 1;
        var scrollableY = stage.scrollHeight > stage.clientHeight + 1;
        if (!scrollableX && !scrollableY) return;
        dragRef.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: stage.scrollLeft,
          top: stage.scrollTop,
        };
        setPanning(true);
        try {
          stage.setPointerCapture(event.pointerId);
        } catch {
          /* 合成指针可能没有真实 pointerId，忽略即可 */
        }
      }

      function onPointerMove(event) {
        var drag = dragRef.current;
        var stage = stageRef.current;
        if (!drag || !stage) return;
        stage.scrollLeft = drag.left - (event.clientX - drag.x);
        stage.scrollTop = drag.top - (event.clientY - drag.y);
      }

      function endPan(event) {
        var drag = dragRef.current;
        if (!drag) return;
        dragRef.current = null;
        setPanning(false);
        try {
          if (event.currentTarget.hasPointerCapture(drag.id)) {
            event.currentTarget.releasePointerCapture(drag.id);
          }
        } catch {
          /* 指针已经丢了，无所谓 */
        }
      }

      function onKeyDown(event) {
        var target = event.target;
        var tag = target && target.tagName ? target.tagName : "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          zoomBy(IMAGE_ZOOM_STEP);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          zoomBy(1 / IMAGE_ZOOM_STEP);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          fitToWindow();
          return;
        }
        if (event.key === "[" || event.key === "]") {
          event.preventDefault();
          rotateBy(event.key === "[" ? -1 : 1);
        }
      }

      var percent = Math.round(zoom * 100);
      var box = natural
        ? rotatedSize(natural.width * zoom, natural.height * zoom, rotation)
        : { width: 0, height: 0 };
      var subtitle = [];
      if (fileExt) subtitle.push(fileExt.toUpperCase());
      if (natural) subtitle.push(natural.width + " × " + natural.height);
      subtitle.push(percent + "%");
      if (rotation) subtitle.push(t("rotated", { degrees: rotationDegrees(rotation) }));

      return h(
        "div",
        {
          className: "dfs-img-root",
          tabIndex: 0,
          onKeyDown: onKeyDown,
          "data-dsh-file-support": "image",
        },
        h(
          "div",
          {
            className: "dfs-img-stage" + (panning ? " dfs-img-panning" : ""),
            ref: stageRef,
            onPointerDown: onPointerDown,
            onPointerMove: onPointerMove,
            onPointerUp: endPan,
            onPointerCancel: endPan,
            onDoubleClick: toggleActualSize,
          },
          url && !failed && !natural
            ? h("p", { className: "dfs-img-loading", "aria-hidden": "true" }, t("loadingImage"))
            : null,
          url && !failed
            ? h(
                "div",
                {
                  className: "dfs-img-canvas",
                  ref: canvasRef,
                  style: {
                    width: box.width ? box.width + "px" : undefined,
                    height: box.height ? box.height + "px" : undefined,
                  },
                  "data-dfs-image": "canvas",
                },
                h("img", {
                  className: "dfs-img",
                  src: url,
                  alt: fileName ? t("preview", { name: fileName }) : t("imageTitle"),
                  draggable: false,
                  decoding: "async",
                  referrerPolicy: "no-referrer",
                  style: {
                    width: natural ? natural.width * zoom + "px" : undefined,
                    height: natural ? natural.height * zoom + "px" : undefined,
                    transform: "translate(-50%, -50%) rotate(" + rotation * 90 + "deg)",
                  },
                  onLoad: function (event) {
                    var el = event.currentTarget;
                    var width = el.naturalWidth;
                    var height = el.naturalHeight;
                    if (!(width > 0) || !(height > 0)) {
                      setFailed(true);
                      return;
                    }
                    setNatural({ width: width, height: height });
                  },
                  onError: function () {
                    setFailed(true);
                  },
                })
              )
            : null,
          failed
            ? h(
                "p",
                { className: "dfs-img-status", role: "alert" },
                t("failed"),
                h("small", null, t("failedHint"))
              )
            : null
        ),
        h(
          "div",
          { className: "dfs-img-tools", role: "toolbar", "aria-label": t("tools") },
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-tool",
              onClick: function () {
                rotateBy(-1);
              },
              title: t("rotateCounterClockwise"),
              "aria-label": t("rotateCounterClockwise"),
            },
            h(GlyphRotateCounterClockwise)
          ),
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-tool",
              onClick: function () {
                rotateBy(1);
              },
              title: t("rotateClockwise"),
              "aria-label": t("rotateClockwise"),
            },
            h(GlyphRotateClockwise)
          ),
          h("span", { className: "dfs-img-divider", "aria-hidden": "true" }),
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-tool",
              onClick: function () {
                zoomBy(1 / IMAGE_ZOOM_STEP);
              },
              title: t("zoomOut"),
              "aria-label": t("zoomOut"),
            },
            h(GlyphMinus)
          ),
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-zoom",
              onClick: toggleActualSize,
              title: t("toggleActualSize"),
              "aria-label": t("toggleActualSize"),
            },
            percent + "%"
          ),
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-tool",
              onClick: function () {
                zoomBy(IMAGE_ZOOM_STEP);
              },
              title: t("zoomIn"),
              "aria-label": t("zoomIn"),
            },
            h(GlyphPlus)
          ),
          h(
            "button",
            {
              type: "button",
              className: "dfs-img-tool",
              onClick: fitToWindow,
              title: t("fitWindow"),
              "aria-label": t("fitWindow"),
            },
            h(GlyphFit)
          )
        ),
        h(
          "div",
          { className: "dfs-img-caption" },
          h("span", { className: "dfs-img-name", title: filePath || fileName }, fileName || t("unknownFile")),
          h("span", { className: "dfs-img-meta" }, subtitle.length ? subtitle.join(" · ") : "")
        )
      );
    }

    // ───────────────────────────── 原图预览（lightbox）增强 ─────────────────────────────

    /**
     * 原图预览工具栏的图标。
     *
     * 会话里点开图片走的是 `dsh-client-ui-attachment` 的 `ImageLightbox`（primitives 原语），
     * 那条链路没有 documentPreviews 那种扩展点，只能拿到 DOM 后用原生节点补 UI，
     * 所以这里用 SVG 字符串而不是 React 组件。
     */
    var LIGHTBOX_GLYPHS = {
      ccw:
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M7.9 8.4H4.4V4.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
        '<path d="M4.7 8.1a7 7 0 1 1-.6 6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>' +
        "</svg>",
      cw:
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M16.1 8.4h3.5V4.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
        '<path d="M19.3 8.1a7 7 0 1 0 .6 6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>' +
        "</svg>",
      minus:
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M5.5 12h13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
        "</svg>",
      plus:
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M12 5.5v13M5.5 12h13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
        "</svg>",
      fit:
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
        '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
        "</svg>",
    };

    /** 原图预览里 stage 的四周留白（和 primitives 的 CSS 一致：padding: 40px）。 */
    var LIGHTBOX_INSET = 40;

    /**
     * 增强一张原图预览：滚轮缩放、顺 / 逆时针 90° 旋转、拖动平移、双击复位。
     *
     * 不动原组件的布局（img 的 width/height 由它自己算），只叠一层 transform：
     * `translate(dx, dy) scale(scale) rotate(deg)`，transform-origin 居中。
     * 这样旋转后不会裁切，也不影响关闭按钮和遮罩点击。
     *
     * @param dialog - `[role="dialog"][aria-modal="true"]` 的原图预览容器。
     * @param img - 里面那张原图。
     * @param t - 图片命名空间的文案函数。
     * @returns 清理函数；lightbox 关闭时需要调用。
     */
    function enhanceLightbox(dialog, img, t) {
      var state = {
        scale: 1,
        rotation: 0,
        dx: 0,
        dy: 0,
        baseW: 0,
        baseH: 0,
        naturalW: 0,
        naturalH: 0,
        drag: null,
        suppressClick: false,
      };
      var disposed = false;
      var cleanups = [];

      function listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        cleanups.push(function () {
          target.removeEventListener(type, handler, options);
        });
      }

      /** 量一下未加 transform 时的布局尺寸（offsetWidth/Height 不受 transform 影响）。 */
      function measure() {
        state.naturalW = img.naturalWidth || 0;
        state.naturalH = img.naturalHeight || 0;
        state.baseW = img.offsetWidth || img.getBoundingClientRect().width || 0;
        state.baseH = img.offsetHeight || img.getBoundingClientRect().height || 0;
      }

      function stageEl() {
        return img.parentElement || dialog;
      }

      /** 旋转后图片占的外接盒（未乘 scale）。 */
      function boxOf(rotation) {
        var swap = ((rotation % 4) + 4) % 4 % 2 === 1;
        return swap
          ? { width: state.baseH, height: state.baseW }
          : { width: state.baseW, height: state.baseH };
      }

      /** 原图在 stage 里的可用区域（stage 的 padding 内）。 */
      function usableArea() {
        var stage = stageEl();
        var width = stage.clientWidth || 0;
        var height = stage.clientHeight || 0;
        if (width <= 0 || height <= 0) {
          width = window.innerWidth;
          height = window.innerHeight;
        }
        return {
          width: Math.max(1, width - LIGHTBOX_INSET * 2),
          height: Math.max(1, height - LIGHTBOX_INSET * 2),
        };
      }

      /** 旋转到某个方向时，能完整放下的最大比例。 */
      function fitScale(rotation) {
        var box = boxOf(rotation == null ? state.rotation : rotation);
        if (!(box.width > 0) || !(box.height > 0)) return 1;
        var area = usableArea();
        return Math.max(
          IMAGE_ZOOM_MIN,
          Math.min(1, area.width / box.width, area.height / box.height)
        );
      }

      /** 展示比例 → 相对原始像素的百分比（100% = 一比一像素）。 */
      function percent() {
        if (!(state.naturalW > 0) || !(state.baseW > 0)) return 100;
        return Math.round((state.baseW * state.scale * 100) / state.naturalW);
      }

      function apply() {
        if (disposed) return;
        img.style.transformOrigin = "center center";
        img.style.willChange = "transform";
        img.style.cursor = state.drag ? "grabbing" : "grab";
        img.style.transform =
          "translate(" +
          state.dx +
          "px, " +
          state.dy +
          "px) scale(" +
          state.scale +
          ") rotate(" +
          state.rotation * 90 +
          "deg)";
        if (percentButton) percentButton.textContent = percent() + "%";
      }

      function zoomAt(factor, clientX, clientY) {
        var previous = state.scale;
        var next = clampImageZoom(previous * factor);
        if (next === previous) return;
        var ratio = next / previous;
        var stageRect = stageEl().getBoundingClientRect();
        var centerX = stageRect.left + stageRect.width / 2 + state.dx;
        var centerY = stageRect.top + stageRect.height / 2 + state.dy;
        var cursorX = clientX == null ? centerX : clientX;
        var cursorY = clientY == null ? centerY : clientY;
        // 让光标下的那个点保持不动（transform 是围绕中心缩放的）。
        state.dx += (cursorX - centerX) * (1 - ratio);
        state.dy += (cursorY - centerY) * (1 - ratio);
        state.scale = next;
        apply();
      }

      function zoomBy(factor) {
        zoomAt(factor, null, null);
      }

      function rotateBy(delta) {
        state.rotation = (state.rotation + delta + 4) % 4;
        // 旋转后回到中心，并按新方向重新适应，免得 90° 一转图就顶到屏幕外。
        state.dx = 0;
        state.dy = 0;
        state.scale = Math.min(state.scale, fitScale());
        apply();
      }

      function reset() {
        measure();
        state.scale = 1;
        state.rotation = 0;
        state.dx = 0;
        state.dy = 0;
        apply();
      }

      function onWheel(event) {
        event.preventDefault();
        event.stopPropagation();
        var unit =
          event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
        var delta = Math.max(-60, Math.min(60, event.deltaY * unit));
        zoomAt(Math.exp(-delta * 0.002), event.clientX, event.clientY);
      }

      function onPointerDown(event) {
        if (event.button !== 0) return;
        state.drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          dx: state.dx,
          dy: state.dy,
        };
        state.suppressClick = true;
        try {
          img.setPointerCapture(event.pointerId);
        } catch {
          /* 合成指针没有真实 pointerId 时忽略 */
        }
        apply();
      }

      function onPointerMove(event) {
        if (!state.drag) return;
        state.dx = state.drag.dx + (event.clientX - state.drag.x);
        state.dy = state.drag.dy + (event.clientY - state.drag.y);
        if (event.cancelable) event.preventDefault();
        apply();
      }

      function onPointerUp() {
        if (!state.drag) return;
        state.drag = null;
        apply();
      }

      /** 拖动过的这一次点击不要再传给遮罩，否则会顺手把原图预览关掉。 */
      function onClickCapture(event) {
        if (!state.suppressClick) return;
        state.suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
      }

      function onKeyDown(event) {
        if (!document.body || !document.body.contains(dialog)) return;
        var tag = event.target && event.target.tagName ? event.target.tagName : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          zoomBy(IMAGE_ZOOM_STEP);
          return;
        }
        if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          zoomBy(1 / IMAGE_ZOOM_STEP);
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          reset();
          return;
        }
        if (event.key === "[" || event.key === "]") {
          event.preventDefault();
          rotateBy(event.key === "[" ? -1 : 1);
        }
      }

      function onResize() {
        measure();
        apply();
      }

      // ── 工具栏 ──
      var percentButton = null;
      var toolbar = document.createElement("div");
      toolbar.className = "dfs-img-tools dfs-lightbox-tools";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", t("tools"));

      function addTool(glyph, label, onClick, className) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = className || "dfs-img-tool";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = glyph;
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        toolbar.appendChild(button);
        return button;
      }

      addTool(LIGHTBOX_GLYPHS.ccw, t("rotateCounterClockwise"), function () {
        rotateBy(-1);
      });
      addTool(LIGHTBOX_GLYPHS.cw, t("rotateClockwise"), function () {
        rotateBy(1);
      });
      var divider = document.createElement("span");
      divider.className = "dfs-img-divider";
      divider.setAttribute("aria-hidden", "true");
      toolbar.appendChild(divider);
      addTool(LIGHTBOX_GLYPHS.minus, t("zoomOut"), function () {
        zoomBy(1 / IMAGE_ZOOM_STEP);
      });
      percentButton = addTool("", t("toggleActualSize"), reset, "dfs-img-zoom");
      addTool(LIGHTBOX_GLYPHS.plus, t("zoomIn"), function () {
        zoomBy(IMAGE_ZOOM_STEP);
      });
      addTool(LIGHTBOX_GLYPHS.fit, t("fitWindow"), reset);

      dialog.appendChild(toolbar);
      cleanups.push(function () {
        toolbar.remove();
      });

      // ── 事件 ──
      listen(dialog, "wheel", onWheel, { passive: false });
      listen(dialog, "click", onClickCapture, true);
      listen(img, "pointerdown", onPointerDown);
      listen(img, "pointermove", onPointerMove);
      listen(img, "pointerup", onPointerUp);
      listen(img, "pointercancel", onPointerUp);
      listen(img, "dblclick", function (event) {
        event.preventDefault();
        reset();
      });
      listen(document, "keydown", onKeyDown, true);
      listen(window, "resize", onResize);

      var previousDraggable = img.draggable;
      img.draggable = false;
      cleanups.push(function () {
        img.draggable = previousDraggable;
        img.style.transform = "";
        img.style.transformOrigin = "";
        img.style.willChange = "";
        img.style.cursor = "";
      });

      measure();
      apply();

      return function cleanup() {
        if (disposed) return;
        disposed = true;
        for (var i = 0; i < cleanups.length; i += 1) {
          try {
            cleanups[i]();
          } catch {
            /* 单个清理失败不影响其他 */
          }
        }
        cleanups.length = 0;
      };
    }

    /**
     * 装一个原图预览增强器。
     *
     * 没有扩展点，所以用 MutationObserver 盯着 body：一旦出现
     * `[role="dialog"][aria-modal="true"]` 且里面恰好一张大图，就交给 enhanceLightbox。
     * 只认「一张图」的 dialog，避免误伤设置弹窗之类。
     *
     * @param t - 图片命名空间的文案函数。
     * @returns 清理函数。
     */
    function installLightboxEnhancer(t) {
      if (typeof document === "undefined" || !document.body) return function () {};
      var active = new Map();
      var scheduled = false;
      var disposed = false;

      function scan() {
        scheduled = false;
        if (disposed) return;
        active.forEach(function (cleanup, dialog) {
          if (!document.contains(dialog)) {
            cleanup();
            active.delete(dialog);
          }
        });
        var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
        for (var i = 0; i < dialogs.length; i += 1) {
          var dialog = dialogs[i];
          if (active.has(dialog)) continue;
          var img = dialog.querySelector("img");
          if (!img || !img.parentElement) continue;
          if (dialog.querySelectorAll("img").length !== 1) continue;
          if (img.closest(".dfs-img-root")) continue;
          if (!img.complete) {
            // 还没加载完，等 load 之后再量尺寸。
            // 用 dataset 标记防止每次 scan 都重复挂监听（会话切换时 mutation 非常密集）。
            if (!img.dataset.dfsLoadWatch) {
              img.dataset.dfsLoadWatch = "1";
              img.addEventListener(
                "load",
                function () {
                  delete img.dataset.dfsLoadWatch;
                  schedule();
                },
                { once: true }
              );
            }
            continue;
          }
          if (!(img.naturalWidth > 120) || !(img.naturalHeight > 120)) continue;
          active.set(dialog, enhanceLightbox(dialog, img, t));
        }
      }

      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(scan);
        } else {
          setTimeout(scan, 16);
        }
      }

      var observer = new MutationObserver(schedule);
      // 只盯 body 的直接子节点：原图预览是挂到 body 上的（实测 v0.2.2 如此）。
      // 绝不 subtree——会话切换时消息列表的 mutation 有上万条，subtree 会把主线程拖死。
      observer.observe(document.body, { childList: true });

      // 兜底：点图片打开原图后补扫几次，防止某些版本把 lightbox 挂到更深的容器里。
      function onDocumentClick() {
        schedule();
        setTimeout(schedule, 120);
        setTimeout(schedule, 500);
      }
      document.addEventListener("click", onDocumentClick, true);

      schedule();

      return function cleanup() {
        disposed = true;
        document.removeEventListener("click", onDocumentClick, true);
        observer.disconnect();
        active.forEach(function (cleanupFn) {
          cleanupFn();
        });
        active.clear();
      };
    }

    // ───────────────────────────── 草稿附件保鲜（补 DSH 的 bug） ─────────────────────────────

    /**
     * 补 DSH 的「切会话后未发送的附件消失」bug。
     *
     * 原实现：切走会话时 `conversation.input` 的 shell 被 teardown，
     * `shell.dispose()` 把草稿里所有附件 id 交出来，teardown 再对每个 id 调
     * `ConversationController.releaseDraftAttachment()` —— 删附件对象、revoke 图片预览的
     * Blob URL、abort 还在跑的上传。而草稿**文本**走的是 `persistDraft` 持久化，
     * 所以切回来文字还在、附件没了。
     *
     * 补丁只做三件事，不改任何官方文件：
     *   1. `shellFor` 返回 shell 时记下它属于哪个 session，并给 `shell.dispose` 包一层：
     *      dispose 之前先把当前草稿附件 id 记进「保鲜」集合；
     *   2. `releaseDraftAttachment` 遇到保鲜集合里的 id 直接跳过（对象、预览 URL、
     *      `fileUploads` 里的上传状态全部留着）；
     *   3. 同一个 session 的 shell 重新创建时（切回来），把保鲜的 id 重新
     *      `addAttachments` 回去。
     *
     * 用户主动点 × 删除、以及发送成功后的释放都不在保鲜集合里，走原逻辑。
     *
     * @param conversation - `ConversationController`（root service `conversation`）。
     * @returns 清理函数。
     */
    function installDraftAttachmentKeeper(conversation) {
      if (!conversation || typeof conversation.releaseDraftAttachment !== "function") {
        return function () {};
      }
      var hub = conversation.input;
      if (!hub || typeof hub.shellFor !== "function" || typeof hub.shell !== "function") {
        return function () {};
      }

      /** 切会话时被「释放」但实际要留着的附件 id。 */
      var carriedIds = new Set();
      /** shell → sessionId。 */
      var shellSessions = new WeakMap();
      /** sessionId → 待恢复的附件 id（有序）。 */
      var sessionCarry = new Map();
      /** 已经包过 dispose 的 shell。 */
      var patchedShells = new WeakSet();
      var originalRelease = conversation.releaseDraftAttachment;
      /**
       * 保鲜区上限：用户切走后永远不回来时，这些附件（含图片 Blob URL）会一直占内存。
       * 超过上限就按加入顺序释放最旧的，保证不会无限增长。
       */
      var CARRY_LIMIT = 40;

      function dropCarried(id) {
        carriedIds.delete(id);
        sessionCarry.forEach(function (ids, sessionId) {
          var index = ids.indexOf(id);
          if (index < 0) return;
          ids.splice(index, 1);
          if (ids.length === 0) sessionCarry.delete(sessionId);
        });
      }

      function trimCarry() {
        if (carriedIds.size <= CARRY_LIMIT) return;
        var overflow = carriedIds.size - CARRY_LIMIT;
        var victims = [];
        carriedIds.forEach(function (id) {
          if (victims.length < overflow) victims.push(id);
        });
        for (var i = 0; i < victims.length; i += 1) {
          dropCarried(victims[i]);
          try {
            originalRelease.call(conversation, victims[i]);
          } catch {
            /* 单个释放失败不影响其他 */
          }
        }
      }

      conversation.releaseDraftAttachment = function (id) {
        if (carriedIds.has(id)) return;
        return originalRelease.call(this, id);
      };

      function snapshotIdsOf(shell) {
        var snapshot = null;
        try {
          snapshot = shell.snapshot;
        } catch {
          snapshot = null;
        }
        return snapshot && Array.isArray(snapshot.attachmentIds) ? snapshot.attachmentIds.slice() : [];
      }

      /** dispose 前把草稿附件记进保鲜集合，等它切回来再恢复。 */
      function remember(shell) {
        var sessionId = shellSessions.get(shell);
        if (sessionId === undefined) return;
        var ids = snapshotIdsOf(shell);
        if (ids.length === 0) return;
        var previous = sessionCarry.get(sessionId) || [];
        var merged = previous.slice();
        for (var i = 0; i < ids.length; i += 1) {
          if (merged.indexOf(ids[i]) < 0) merged.push(ids[i]);
          carriedIds.add(ids[i]);
        }
        sessionCarry.set(sessionId, merged);
        trimCarry();
      }

      function patchShell(shell, sessionId) {
        if (sessionId !== undefined) shellSessions.set(shell, sessionId);
        if (patchedShells.has(shell) || typeof shell.dispose !== "function") return;
        patchedShells.add(shell);
        var originalDispose = shell.dispose;
        shell.dispose = function () {
          remember(shell);
          return originalDispose.apply(shell, arguments);
        };
      }

      /** shell 重新出现时，把备份的附件挂回去。 */
      function restore(shell, sessionId) {
        var ids = sessionCarry.get(sessionId);
        if (!ids || ids.length === 0) return;
        sessionCarry.delete(sessionId);
        var live = [];
        for (var i = 0; i < ids.length; i += 1) {
          if (conversation.draftAttachments && conversation.draftAttachments.has(ids[i])) {
            live.push(ids[i]);
          }
          // 对象已经不在（被删 / 释放了）的 id 也没必要继续保鲜。
          carriedIds.delete(ids[i]);
        }
        if (live.length === 0) return;
        var existing = snapshotIdsOf(shell);
        var missing = [];
        for (var j = 0; j < live.length; j += 1) {
          if (existing.indexOf(live[j]) < 0) missing.push(live[j]);
        }
        if (missing.length === 0) return;

        var attempt = function () {
          try {
            var snapshot = shell.snapshot;
            // 提交中/发送中不接受追加，等它回到 plain。
            if (snapshot && snapshot.phase && snapshot.phase !== "plain") return false;
            return shell.addAttachments(missing) === true;
          } catch {
            return false;
          }
        };
        if (attempt()) return;
        // composer 可能还没挂载完，隔一会儿再试几次。
        var tries = 0;
        var timer = setInterval(function () {
          tries += 1;
          if (attempt() || tries >= 8) clearInterval(timer);
        }, 400);
      }

      var originalShellFor = hub.shellFor;
      hub.shellFor = function (binding) {
        var shell = originalShellFor.apply(hub, arguments);
        var sessionId = binding && binding.sessionId !== undefined ? binding.sessionId : undefined;
        patchShell(shell, sessionId);
        if (sessionId !== undefined) restore(shell, sessionId);
        return shell;
      };

      var originalShell = hub.shell;
      hub.shell = function (id) {
        var shell = originalShell.apply(hub, arguments);
        patchShell(shell, id);
        if (id !== undefined) restore(shell, id);
        return shell;
      };

      return function cleanup() {
        conversation.releaseDraftAttachment = originalRelease;
        hub.shellFor = originalShellFor;
        hub.shell = originalShell;
        // 插件卸载时把还留着的附件交回原逻辑，别让 Blob URL 泄漏。
        carriedIds.forEach(function (id) {
          try {
            originalRelease.call(conversation, id);
          } catch {
            /* 单个释放失败不影响其他 */
          }
        });
        carriedIds.clear();
        sessionCarry.clear();
      };
    }

    // ───────────────────────────── 样式 ─────────────────────────────

    var STYLE = `
.dfs-root {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 100%;
  padding: 20px;
  overflow: auto;
  outline: none;
}
.dfs-root:focus-visible .dfs-card {
  border-color: var(--dsw-alias-brand-primary, #6ea8ff);
}
.dfs-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 520px;
  padding: 20px 20px 16px;
  border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 140, 160, 0.22));
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.035));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.10);
}
.dfs-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.dfs-art {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  color: var(--dsw-alias-brand-primary, #6ea8ff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 140, 160, 0.22));
  background: linear-gradient(135deg, rgba(110, 168, 255, 0.20), rgba(180, 140, 255, 0.14));
}
.dfs-titles {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.dfs-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 650;
  color: var(--dsw-alias-label-primary, #e6e8ec);
}
.dfs-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dfs-wave-wrap {
  position: relative;
  height: 88px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 140, 160, 0.16));
  background: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.12));
}
.dfs-wave {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  /* 固定品牌蓝：--dsw-alias-brand-primary 在暗色主题下是白色，波形会白成一片。 */
  --dfs-played: #6ea8ff;
  --dfs-rest: rgba(138, 156, 186, 0.34);
}
.dfs-wave-hit {
  position: absolute;
  inset: 0;
  cursor: pointer;
  touch-action: none;
}
.dfs-wave-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
/*
 * 类名刻意避开 controls 这个词：工作台插件注入过一条
 * [class*="controls"] { display: none !important; } 的全局规则，
 * 任何带 controls 的类名都会整块消失（实测踩过）。同理也别用 header / panel 之类太通用的词。
 */
.dfs-transport {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dfs-play {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  padding: 0;
  border: none;
  border-radius: 999px;
  /* 别用 --dsw-alias-brand-primary：暗色主题下它是白色，白底白图标就看不见了。 */
  background: linear-gradient(135deg, #5b8cff, #8f6dff);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(91, 140, 255, 0.28);
  transition: transform 0.12s ease, filter 0.12s ease;
}
.dfs-play:hover:not(:disabled) { filter: brightness(1.08); }
.dfs-play:active:not(:disabled) { transform: scale(0.95); }
.dfs-play:disabled { opacity: 0.45; cursor: default; }
.dfs-time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #b9c0c8);
}
.dfs-spacer { flex: 1 1 auto; }
.dfs-rate {
  height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 140, 160, 0.28));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b9c0c8);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.dfs-rate:hover {
  color: var(--dsw-alias-label-primary, #e6e8ec);
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06));
}
.dfs-vol {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dfs-vol button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b9c0c8);
  cursor: pointer;
}
.dfs-vol button:hover { background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06)); }
.dfs-vol input[type="range"] {
  width: 64px;
  height: 3px;
  border-radius: 999px;
  outline: none;
  background: var(--dsw-alias-border-l2, rgba(128, 140, 160, 0.28));
  -webkit-appearance: none;
  appearance: none;
}
.dfs-vol input[type="range"]::-webkit-slider-thumb {
  width: 11px;
  height: 11px;
  border-radius: 999px;
  background: var(--dsw-alias-label-primary, #e6e8ec);
  cursor: pointer;
  -webkit-appearance: none;
}
.dfs-error {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-state-error-primary, #f87171);
}
.dfs-error small {
  display: block;
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
@media (max-width: 420px) {
  .dfs-vol input[type="range"] { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dfs-play { transition: none; }
}

/* ───────────────────────────── 图片 ───────────────────────────── */
.dfs-img-root {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 100%;
  overflow: hidden;
  outline: none;
}
.dfs-img-stage {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  box-sizing: border-box;
  padding: 16px;
  overflow: auto;
  overscroll-behavior: contain;
}
.dfs-img-stage.dfs-img-panning {
  cursor: grabbing;
}
.dfs-img-stage.dfs-img-panning * {
  cursor: grabbing !important;
}
.dfs-img-canvas {
  position: relative;
  flex: 0 0 auto;
  margin: auto;
}
.dfs-img {
  position: absolute;
  top: 50%;
  left: 50%;
  display: block;
  max-width: none;
  max-height: none;
  border-radius: 10px;
  background: var(--dsw-alias-bg-base, rgba(0, 0, 0, 0.12));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  user-select: none;
  -webkit-user-drag: none;
  transform-origin: center center;
}
.dfs-img-status {
  margin: auto;
  padding: 10px;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  color: var(--dsw-alias-state-error-primary, #f87171);
}
.dfs-img-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  pointer-events: none;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dfs-img-status small {
  display: block;
  margin-top: 4px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
/* 工具栏：固定在右上角，不随图片滚动。类名刻意避开 controls 这类通用词。 */
.dfs-img-tools {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128, 140, 160, 0.26));
  background: var(--dsw-alias-bg-layer-1, rgba(24, 28, 36, 0.72));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  opacity: 0.92;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
.dfs-img-tools:hover {
  opacity: 1;
}
/*
 * 原图预览（会话图片点开）的工具栏：固定在左上角，
 * 避开右上角的关闭按钮，也不跟原图抢层级。
 */
.dfs-lightbox-tools {
  position: fixed;
  top: 20px;
  left: 20px;
  right: auto;
  z-index: 2;
  opacity: 1;
}
.dfs-lightbox-tools .dfs-img-zoom {
  min-width: 48px;
}
.dfs-img-tool {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b9c0c8);
  cursor: pointer;
}
.dfs-img-tool:hover {
  color: var(--dsw-alias-label-primary, #e6e8ec);
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));
}
.dfs-img-tool:active {
  transform: scale(0.94);
}
.dfs-img-zoom {
  min-width: 48px;
  height: 26px;
  padding: 0 6px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #b9c0c8);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.dfs-img-zoom:hover {
  color: var(--dsw-alias-label-primary, #e6e8ec);
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));
}
.dfs-img-divider {
  width: 1px;
  height: 15px;
  margin: 0 2px;
  background: var(--dsw-alias-border-l2, rgba(128, 140, 160, 0.3));
}
.dfs-img-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 12px 10px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #8b949e);
}
.dfs-img-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dfs-img-meta {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .dfs-img-tool:active { transform: none; }
}
`;

    /** 中文文案。 */
    var ZH = {
      title: "音频",
      play: "播放",
      pause: "暂停",
      mute: "静音",
      unmute: "取消静音",
      volume: "音量",
      rate: "播放速度",
      failed: "浏览器无法解码这个音频文件",
      failedHint: "可以试试用系统播放器打开它。",
      waiting: "等待音频数据…",
      wavePending: "正在解析波形…",
      waveUnavailable: "波形不可用",
      channels: "{count} 声道",
      bitrate: "{rate} kbps",
      unknownDuration: "未知时长",
      unknownFile: "未知文件",
      imageTitle: "图片",
      preview: "图片预览：{name}",
      loadingImage: "正在加载图片…",
      imageFailed: "无法显示这张图片",
      imageFailedHint: "浏览器可能不支持这个格式，或者文件已经损坏。",
      tools: "图片工具",
      rotateCounterClockwise: "逆时针旋转 90°",
      rotateClockwise: "顺时针旋转 90°",
      zoomIn: "放大",
      zoomOut: "缩小",
      fitWindow: "适应窗口",
      toggleActualSize: "切换 适应窗口 / 100%",
      rotated: "旋转 {degrees}°",
    };

    /** 英文文案。 */
    var EN = {
      title: "Audio",
      play: "Play",
      pause: "Pause",
      mute: "Mute",
      unmute: "Unmute",
      volume: "Volume",
      rate: "Playback rate",
      failed: "This browser cannot decode the audio file",
      failedHint: "Try opening it in a system player instead.",
      waiting: "Waiting for audio data…",
      wavePending: "Analyzing waveform…",
      waveUnavailable: "Waveform unavailable",
      channels: "{count} channels",
      bitrate: "{rate} kbps",
      unknownDuration: "Unknown duration",
      unknownFile: "Unknown file",
      imageTitle: "Image",
      preview: "Image preview: {name}",
      loadingImage: "Loading image…",
      imageFailed: "This image could not be displayed",
      imageFailedHint: "The browser may not support this format, or the file is damaged.",
      tools: "Image tools",
      rotateCounterClockwise: "Rotate 90° counter-clockwise",
      rotateClockwise: "Rotate 90° clockwise",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fitWindow: "Fit to window",
      toggleActualSize: "Toggle fit to window / 100%",
      rotated: "Rotated {degrees}°",
    };

    // ───────────────────────────── 注册 ─────────────────────────────

    /** 音频渲染器的元数据。 */
    function audioDefinition(title) {
      return {
        id: AUDIO_BODY_ID,
        extensions: AUDIO_EXTENSIONS,
        binaryExtensions: AUDIO_EXTENSIONS,
        priority: "extension",
        title: title,
        loading: "bytes-complete",
        wrap: false,
      };
    }

    /**
     * 图片渲染器的元数据。
     *
     * `priority: "extension"` 是故意的：documentpreview 的注册表规定外部实现赢过产品内置实现，
     * 这样我们才能接管 .png / .jpg，加上内置没有的滚轮缩放与旋转。
     */
    function imageDefinition(title) {
      return {
        id: IMAGE_BODY_ID,
        extensions: IMAGE_EXTENSIONS,
        binaryExtensions: IMAGE_BINARY_EXTENSIONS,
        priority: "extension",
        title: title,
        loading: "bytes-complete",
        wrap: false,
      };
    }

    /**
     * 文件支持的全部注册装进 ctx，返回卸载函数。
     * 和原版 dsh-file-support 的 apply 内容一致，只是把 ctx.effect 换成了可手动调用的
     * disposer 数组——设置页的开关需要在运行时挂上/卸掉，而不是只能等插件卸载。
     */
    function mountFileSupport(ctx) {
      var disposers = [];

      var style = document.createElement("style");
      style.dataset.plugin = "dsh-interaction-files";
      style.textContent = STYLE;
      (document.head || document.documentElement).appendChild(style);
      disposers.push(function () {
        style.remove();
      });

      // 字典和原图预览增强不依赖 documentPreviews，放在 install 外面，
      // 这样即使预览服务还没就绪，点开会话图片也能用。
      var audioT = ctx.locale.bind(AUDIO_LOCALE);
      var imageT = ctx.locale.bind(IMAGE_LOCALE);
      disposers.push(ctx.locale.register(AUDIO_LOCALE, { zh: ZH, en: EN }));
      disposers.push(ctx.locale.register(IMAGE_LOCALE, { zh: ZH, en: EN }));
      disposers.push(installLightboxEnhancer(imageT));

      // conversation 是 root service，可能还没就绪：先取，取不到再动态注入等待。
      var conversation = ctx.get("conversation");
      if (conversation) {
        disposers.push(installDraftAttachmentKeeper(conversation));
      } else {
        var draftDispose = null;
        try {
          ctx.inject(["conversation"], function (child) {
            draftDispose = installDraftAttachmentKeeper(child.conversation);
          });
        } catch (error) {
          /* 拿不到 conversation 就只是少了草稿附件保持，不影响预览 */
        }
        disposers.push(function () {
          try {
            if (draftDispose) draftDispose();
          } catch (error) {
            /* 卸载阶段吞掉 */
          }
        });
      }

      var installed = false;

      function install(previews) {
        if (installed || !previews) return;
        installed = true;
        disposers.push(
          previews.register(
            audioDefinition(function () {
              return audioT("title");
            })
          )
        );
        disposers.push(
          previews.register(
            imageDefinition(function () {
              return imageT("imageTitle");
            })
          )
        );
        disposers.push(
          ctx.slots.inject("sidebar.right.tab.document", function () {
            return ctx.slots.register(
              {
                name: "sidebar.right.tab.document",
                key: AUDIO_BODY_ID,
                locale: AUDIO_LOCALE,
              },
              AudioBody
            );
          })
        );
        disposers.push(
          ctx.slots.inject("sidebar.right.tab.document", function () {
            return ctx.slots.register(
              {
                name: "sidebar.right.tab.document",
                key: IMAGE_BODY_ID,
                locale: IMAGE_LOCALE,
              },
              ImageBody
            );
          })
        );
      }

      var present = ctx.get("documentPreviews");
      if (present) {
        install(present);
      } else {
        var bindDispose = null;
        try {
          bindDispose = ctx.inject(["documentPreviews"], function (child) {
            install(child.documentPreviews);
          });
        } catch (error) {
          bindDispose = null;
        }
        disposers.push(function () {
          try {
            if (bindDispose) bindDispose();
          } catch (error) {
            /* 卸载阶段吞掉 */
          }
        });
      }

      return function unmount() {
        for (var index = 0; index < disposers.length; index += 1) {
          try {
            disposers[index]();
          } catch (error) {
            /* 卸载阶段吞掉 */
          }
        }
        disposers.length = 0;
      };
    }

    // ---------------------------------------------------------------- 设置页

    var C = {
      text: "var(--dsw-alias-label-primary)",
      sub: "var(--dsw-alias-label-secondary)",
      faint: "var(--dsw-alias-label-tertiary)",
      border: "var(--dsw-alias-border-l1)",
      borderStrong: "var(--dsw-alias-border-selected)",
      card: "var(--dsw-alias-settings-card-fill)",
      input: "var(--dsw-alias-bg-base)",
      surface: "var(--dsw-alias-interactive-bg-hover)",
      knob: "var(--dsw-alias-bg-base)",
      danger: "var(--dsw-alias-state-error-primary)",
      ok: "var(--dsw-alias-state-success-primary)",
    };

    /**
     * 设置页开关的样式。滑块必须用 ::after 画（内联 style 做不到伪元素），
     * 所以注入一段 CSS；颜色全走 DSH 主题 token。
     */
    var SETTINGS_STYLE = [
      ".di-switch-row{display:flex;align-items:center;gap:10px;padding:2px 0 8px}",
      ".di-switch-label{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary)}",
      ".di-switch-state{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary);transition:color .24s ease}",
      ".di-switch-row.di-on .di-switch-state{color:var(--dsw-alias-label-primary)}",
      ".di-switch{flex:0 0 auto;position:relative;width:44px;height:26px;border:0;padding:0;border-radius:999px;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,var(--dsw-alias-bg-base));transition:background .26s ease,transform .12s ease}",
      ".di-switch::after{content:\"\";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 3px color-mix(in srgb,var(--dsw-alias-label-primary) 30%,transparent);transition:transform .3s cubic-bezier(.34,1.56,.64,1),background .26s ease}",
      ".di-switch.di-on{background:var(--dsw-alias-brand-primary)}",
      ".di-switch.di-on::after{transform:translateX(18px)}",
      ".di-switch:active{transform:scale(.96)}",
      ".di-switch:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:3px}",
      "@media (prefers-reduced-motion:reduce){.di-switch,.di-switch::after,.di-switch-state{transition:none}}",
    ].join("");

    var S = {
      page: { maxWidth: "860px", color: C.text },
      lead: { fontSize: "12px", color: C.sub, lineHeight: 1.8, marginBottom: "14px" },
      card: {
        border: "1px solid " + C.border,
        borderRadius: "12px",
        padding: "14px",
        background: C.card,
        marginBottom: "12px",
      },
      title: { fontSize: "13px", fontWeight: 700, color: C.text, marginBottom: "4px" },
      hint: { fontSize: "11px", color: C.faint, lineHeight: 1.7, marginBottom: "10px" },
      row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      btn: function (on) {
        return {
          border: "1px solid " + (on ? C.borderStrong : C.border),
          background: on ? "var(--dsw-alias-button-ghost-active-fill)" : "transparent",
          color: C.text,
          borderRadius: "8px",
          padding: "7px 12px",
          fontSize: "12px",
          cursor: "pointer",
          fontWeight: on ? 700 : 400,
        };
      },
      primary: {
        border: "1px solid " + C.text,
        background: C.text,
        color: "var(--dsw-alias-bg-base)",
        borderRadius: "8px",
        padding: "7px 14px",
        fontSize: "12px",
        cursor: "pointer",
        fontWeight: 700,
      },
      num: {
        width: "72px",
        background: C.input,
        color: C.text,
        border: "1px solid " + C.border,
        borderRadius: "7px",
        padding: "6px 8px",
        fontSize: "12px",
      },
      subRow: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        flexWrap: "wrap",
        marginTop: "12px",
        paddingTop: "12px",
        borderTop: "1px solid " + C.border,
      },
      subLabel: { fontSize: "12px", color: C.sub },
      note: { fontSize: "12px", color: C.ok, minHeight: "18px", lineHeight: 1.6 },
      error: { fontSize: "12px", color: C.danger, minHeight: "18px", lineHeight: 1.6 },
    };

    /**
     * 设置 → 交互增强：三块能力的开关，外加跨会话的两条护栏参数。
     * @param {(settings: object) => void} onSaved 保存成功后的回调（用来立即切换文件支持开关）。
     */
    function makeSettingsPage(onSaved) {
      return function SettingsPage() {
        var settingsState = useState(null);
        var settings = settingsState[0];
        var setSettings = settingsState[1];
        var noteState = useState("");
        var note = noteState[0];
        var setNote = noteState[1];
        var errorState = useState("");
        var error = errorState[0];
        var setError = errorState[1];

        useEffect(function () {
          fetch(API + "/settings", { cache: "no-store" })
            .then(function (response) {
              return response.json();
            })
            .then(function (data) {
              if (data && data.settings) setSettings(data.settings);
              else setError("设置接口返回不合法");
            })
            .catch(function (failure) {
              setError("读取设置失败：" + failure.message);
            });
        }, []);

        /** 把完整设置写回服务端。开关类改动立即调用，数字参数失焦时调用。 */
        function persist(next) {
          setError("");
          fetch(API + "/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(next),
          })
            .then(function (response) {
              return response.json();
            })
            .then(function (data) {
              if (!data || !data.ok) throw new Error((data && data.error) || "保存失败");
              setSettings(data.settings);
              setNote("已生效");
            })
            .catch(function (failure) {
              setError(failure.message);
            });
        }

        /**
         * 开关点一下立即生效。
         * 设计规范里这类布尔开关就是「立即生效、不配保存按钮」的形态。
         */
        function toggle(key) {
          if (!settings) return;
          var next = {};
          for (var field in settings) next[field] = settings[field];
          next[key] = !settings[key];
          setSettings(next);
          // 文件支持是在浏览器里挂渲染器，不等服务端回包就当场切换。
          if (key === "fileSupport" && onSaved) onSaved(next);
          persist(next);
        }

        /** 数字参数先改本地，失焦时才落盘。 */
        function setNumber(key, value) {
          if (!settings) return;
          var next = {};
          for (var field in settings) next[field] = settings[field];
          next[key] = Number(value) || 0;
          setSettings(next);
        }

        function commitNumbers() {
          if (settings) persist(settings);
        }

        if (!settings) {
          return h(
            "div",
            { style: S.page },
            h("div", { style: S.lead }, error || "正在读取交互增强设置……"),
            error ? h("div", { style: S.error }, error) : null
          );
        }

        var cards = [
          {
            key: "askFlow",
            title: "分支式提问",
            hint: "ask_flow 工具：一次声明整张问题图，按依赖分波提问（选 A 才问 A 的后续），支持「← 返回上一题」。关掉后只剩官方 ask_user_question。",
          },
          {
            key: "crossSession",
            title: "跨会话消息",
            hint: "session_list / session_send / session_peek 工具：向其它会话发消息并唤醒它，发完能回读回复。带防环（链路深度）和限频两道护栏。",
          },
          {
            key: "fileSupport",
            title: "文件支持扩展",
            hint: "右侧边栏文档预览：音频波形 + 播放器、图片滚轮缩放 + 顺逆时针旋转、原图预览增强。关掉后回到 DSH 自带的预览。",
          },
        ];

        return h(
          "div",
          { style: S.page },
          h(
            "div",
            { style: S.lead },
            "这里控制「交互增强」插件的三块能力。开关点一下立即生效：AI 侧的工具当场注册/注销，文件支持会立刻切换预览渲染器。"
          ),
          cards.map(function (card) {
            var on = settings[card.key] === true;
            var labelId = "di-label-" + card.key;
            var children = [
              h(
                "div",
                { key: "row", className: "di-switch-row" + (on ? " di-on" : "") },
                h("b", { key: "label", id: labelId, className: "di-switch-label" }, card.title),
                h(
                  "span",
                  { key: "state", className: "di-switch-state", "aria-hidden": "true" },
                  on ? "已开启" : "已关闭"
                ),
                h("button", {
                  key: "sw",
                  type: "button",
                  className: "di-switch" + (on ? " di-on" : ""),
                  role: "switch",
                  "aria-checked": on ? "true" : "false",
                  "aria-labelledby": labelId,
                  onClick: function () { toggle(card.key) },
                })
              ),
              h("div", { key: "hint", style: S.hint }, card.hint),
            ];
            // 功能内部需要的参数挂在它自己的卡片上，不另开一张卡片。
            if (card.key === "crossSession") {
              children.push(
                h(
                  "div",
                  { key: "options", style: S.subRow },
                  h("span", { style: S.subLabel }, "链路深度"),
                  h("input", {
                    type: "number",
                    min: 1,
                    max: 10,
                    style: S.num,
                    value: settings.crossSessionMaxDepth,
                    onChange: function (event) { setNumber("crossSessionMaxDepth", event.target.value) },
                    onBlur: commitNumbers,
                  }),
                  h("span", { style: S.subLabel }, "限频（条/分钟）"),
                  h("input", {
                    type: "number",
                    min: 1,
                    max: 60,
                    style: S.num,
                    value: settings.crossSessionRateLimit,
                    onChange: function (event) { setNumber("crossSessionRateLimit", event.target.value) },
                    onBlur: commitNumbers,
                  })
                )
              );
            }
            return h("div", { key: card.key, style: S.card }, children);
          }),
          h("div", { style: S.note }, note),
          h("div", { style: S.error }, error)
        );
      };
    }

    /** 设置页保存后用来同步文件支持开关（apply 里赋值）。 */
    var syncFileSupport = null;

    /**
     * 插件体：设置页始终注册；文件支持按开关挂载。
     *
     * `documentPreviews` 是 documentpreview 插件用 reflect 提供的服务，
     * 加载顺序不保证，所以 mountFileSupport 里先直接取，取不到再注入等待。
     */
    function apply(ctx) {
      // 设置页开关的样式（滑块是 ::after，必须走 CSS，内联 style 做不到）。
      var settingsStyle = document.createElement("style");
      settingsStyle.dataset.plugin = "dsh-interaction-settings";
      settingsStyle.textContent = SETTINGS_STYLE;
      (document.head || document.documentElement).appendChild(settingsStyle);
      ctx.effect(function () {
        return function () {
          settingsStyle.remove();
        };
      }, "interaction: settings styles");

      var fileSupportOn = true;
      var mounted = null;

      function sync() {
        try {
          if (fileSupportOn && !mounted) {
            mounted = mountFileSupport(ctx);
            return;
          }
          if (!fileSupportOn && mounted) {
            mounted();
            mounted = null;
          }
        } catch (error) {
          // 文件支持挂载失败不能连累设置页注册。
          console.error("[interaction] 文件支持挂载失败", error);
          mounted = null;
        }
      }

      syncFileSupport = function (on) {
        fileSupportOn = on !== false;
        sync();
      };

      // 设置页优先注册：即使文件支持那一半出错，设置入口也必须在。
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "interaction",
            order: 77,
            label: function () {
              return "交互增强";
            },
          },
          makeSettingsPage(function (settings) {
            if (syncFileSupport) syncFileSupport(settings.fileSupport);
          })
        );
      });

      // 先按默认（开）挂上，再异步读服务端设置校正——读不到就保持开。
      sync();
      fetch(API + "/settings", { cache: "no-store" })
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          if (data && data.settings) syncFileSupport(data.settings.fileSupport);
        })
        .catch(function () {
          /* 读不到设置就保持默认 */
        });

      ctx.effect(function () {
        return function () {
          if (mounted) {
            try {
              mounted();
            } catch (error) {
              /* 卸载阶段吞掉 */
            }
            mounted = null;
          }
        };
      }, "interaction: file support unmount");
    }

    return {
      inject: ["slots", "locale"],
      apply: apply,
      __internal: {
        AUDIO_BODY_ID: AUDIO_BODY_ID,
        IMAGE_BODY_ID: IMAGE_BODY_ID,
        AUDIO_EXTENSIONS: AUDIO_EXTENSIONS,
        AUDIO_MEDIA_TYPES: AUDIO_MEDIA_TYPES,
        IMAGE_EXTENSIONS: IMAGE_EXTENSIONS,
        IMAGE_BINARY_EXTENSIONS: IMAGE_BINARY_EXTENSIONS,
        IMAGE_MEDIA_TYPES: IMAGE_MEDIA_TYPES,
        IMAGE_ZOOM_MIN: IMAGE_ZOOM_MIN,
        IMAGE_ZOOM_MAX: IMAGE_ZOOM_MAX,
        IMAGE_ZOOM_STEP: IMAGE_ZOOM_STEP,
        RATES: RATES,
        extensionOf: extensionOf,
        audioMediaType: audioMediaType,
        imageMediaType: imageMediaType,
        clampImageZoom: clampImageZoom,
        rotatedSize: rotatedSize,
        fitImageZoom: fitImageZoom,
        rotationDegrees: rotationDegrees,
        sessionFilePath: sessionFilePath,
        fileNameOf: fileNameOf,
        formatTime: formatTime,
        formatBytes: formatBytes,
        computePeaks: computePeaks,
        decodeWaveform: decodeWaveform,
        audioDefinition: audioDefinition,
        imageDefinition: imageDefinition,
        AudioBody: AudioBody,
        ImageBody: ImageBody,
        installLightboxEnhancer: installLightboxEnhancer,
        STYLE: STYLE,
      },
    };
  },
});
