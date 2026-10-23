"use strict";

(() => {
  const get = (id) => document.getElementById(id);
  const button = get("play-toggle");
  const cover = get("cover");
  const background = get("background-cover");
  const canvas = get("spectrum");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let audio = get("audio");
  let painter = null;
  let site = null;
  let latestMetadata = null;
  let metadataKey = "";
  let coverKey = "";
  let coverVersion = 0;
  let coverTrackId = null;
  let coverTimer = 0;
  let coverGraceExpired = false;
  let coverIsTrack = false;
  let muted = false;
  let wanted = false;
  let phase = "paused";
  let attempt = 0;
  let connectionTimer = 0;
  let progressTimer = 0;
  let retryTimer = 0;
  let retryCount = 0;
  let removeAudioListeners = () => {};
  let graph = null;
  let spectrumUnavailable = false;
  let animationFrame = 0;
  let lastFrame = 0;
  let leaving = false;
  let siteTimer = 0;
  let metadataTimer = 0;
  let statsTimer = 0;
  let shareTimer = 0;
  let shareTrigger = null;
  const requests = new Set();

  try {
    painter = canvas.getContext("2d");
  } catch {
    // An unavailable canvas must not prevent native audio playback.
  }

  function safeUrl(value) {
    if (typeof value !== "string" || !value ||
        /[\s\\\u0000-\u001f\u007f]/.test(value)) {
      return null;
    }
    const rootRelative = value.startsWith("/") && !value.startsWith("//");
    if (!rootRelative && !/^https?:\/\//i.test(value)) return null;
    try {
      const url = new URL(value, window.location.href);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
        return null;
      }
      if (rootRelative && (url.origin !== window.location.origin ||
          url.pathname.startsWith("//"))) {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }


  function shareData() {
    const title = site && site.title || "BunFM";
    return {
      title,
      text: "I'm listening to " + title + ". Tune in with me.",
      url: new URL("/", window.location.origin).href,
    };
  }

  function renderShareLinks() {
    const data = shareData();
    const url = new URL("https://twitter.com/intent/tweet");
    url.searchParams.set("text", data.text);
    url.searchParams.set("url", data.url);
    get("share-x").href = url.href;
    get("share-actions").hidden = false;
  }

  function shareStatus(message) {
    window.clearTimeout(shareTimer);
    get("share-status").textContent = message;
    if (message) {
      shareTimer = window.setTimeout(() => {
        get("share-status").textContent = "";
      }, 5000);
    }
  }

  function closeShareFallback() {
    get("share-fallback").hidden = true;
    if (shareTrigger) shareTrigger.focus();
  }

  function showShareFallback(trigger) {
    shareTrigger = trigger;
    get("share-url").value = shareData().url;
    get("share-fallback").hidden = false;
    get("share-url").focus();
    get("share-url").select();
  }

  async function copyShareLink(trigger) {
    get("share-fallback").hidden = true;
    shareStatus("");
    try {
      await navigator.clipboard.writeText(shareData().url);
      shareStatus("Link copied");
    } catch {
      showShareFallback(trigger);
    }
  }

  async function shareMore() {
    const trigger = get("share-more");
    get("share-fallback").hidden = true;
    shareStatus("");
    const data = shareData();
    trigger.disabled = true;
    try {
      if (!navigator.share ||
          (navigator.canShare && !navigator.canShare(data))) {
        await copyShareLink(trigger);
        return;
      }
      await navigator.share(data);
    } catch (error) {
      if (!error || error.name !== "AbortError") {
        showShareFallback(trigger);
      }
    } finally {
      trigger.disabled = false;
    }
  }

  function renderText(id, text) {
    const element = get(id);
    element.textContent = text;
    element.hidden = !text;
  }

  function renderPlayback() {
    button.disabled = !site;
    button.setAttribute("aria-label", wanted ?
      "Pause live stream" : "Play live stream");
    const loading = !site || (wanted && phase !== "playing");
    get("play-icon").toggleAttribute("hidden", loading || wanted);
    get("pause-icon").toggleAttribute("hidden", loading || !wanted);
    get("loading-icon").toggleAttribute("hidden", !loading);
    document.body.dataset.playing = String(phase === "playing");
    let status = "Paused";
    let hint = "Press play to join the live stream";
    if (!site) {
      status = "Loading station…";
      hint = "Audio stays off until you press play";
    } else if (phase === "connecting") {
      status = "Connecting…";
      hint = "Joining the live stream";
    } else if (phase === "buffering") {
      status = "Buffering…";
      hint = "Waiting for audio. You can pause at any time.";
    } else if (phase === "playing") {
      status = muted ? "Station muted" : "Listening live";
      hint = muted ? "Connected. Waiting for the station to unmute." :
        "You’re tuned in to the live stream";
    } else if (phase === "retrying") {
      status = "Reconnecting…";
      hint = "Retrying automatically. You can pause at any time.";
    }
    get("playback-status").textContent = status;
    get("playback-hint").textContent = hint;

  }

  function renderCover(track) {
    const trackId = track ? track.id : null;
    if (trackId !== coverTrackId) {
      coverTrackId = trackId;
      window.clearTimeout(coverTimer);
      coverTimer = 0;
      coverGraceExpired = false;
      coverKey = "";
      ++coverVersion;
    }
    const trackCover = safeUrl(track && track.coverUrl);
    if (!trackCover && coverIsTrack && !coverGraceExpired) {
      if (!coverTimer) {
        coverKey = "";
        ++coverVersion;
        // Allow 10s for extraction plus a 3s metadata poll before falling back.
        coverTimer = window.setTimeout(() => {
          coverTimer = 0;
          coverGraceExpired = true;
          renderCover(latestMetadata && latestMetadata.track);
        }, 15000);
      }
      return;
    }
    window.clearTimeout(coverTimer);
    coverTimer = 0;
    const candidates = [...new Set([
      trackCover,
      site && site.defaultCover,
      "/icon.jpg",
    ].map(safeUrl).filter(Boolean))];
    const trackAlt = track &&
      "Cover artwork for " + (track.album || track.title || "the current track");
    const key = JSON.stringify([trackId, trackAlt, candidates]);
    if (key === coverKey) return;
    coverKey = key;
    const version = ++coverVersion;
    let index = 0;
    const tryNext = () => {
      if (leaving || version !== coverVersion) return;
      if (index >= candidates.length) return;
      const url = candidates[index++];
      const isTrackCover = url === trackCover;
      const image = new Image();
      image.onload = () => {
        if (leaving || version !== coverVersion) return;
        cover.src = url;
        cover.alt = isTrackCover ? trackAlt : "Station artwork";
        background.src = url;
        cover.hidden = false;
        background.hidden = false;
        coverIsTrack = isTrackCover;
      };
      image.onerror = tryNext;
      image.src = url;
    };
    tryNext();
  }

  function renderMetadata(data) {
    latestMetadata = data;
    const key = JSON.stringify(data.track);
    if (key !== metadataKey) {
      metadataKey = key;
      const track = data.track;
      get("track-title").textContent = track ?
        (track.title || "Untitled track") : "Nothing playing yet";
      get("track-artist").textContent = track ?
        (track.artist || "Unknown artist") : "The station is between tracks";
      renderText("track-album", track ? (track.album || "Unknown album") : "");
      renderCover(track);
    }
    if (muted !== data.muted) {
      muted = data.muted;
      renderPlayback();
    }
  }

  async function fetchJson(path) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(path, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(type)) {
        throw new Error("Invalid API response");
      }
      return await response.json();
    } finally {
      window.clearTimeout(timer);
      requests.delete(controller);
    }
  }

  function validSite(data) {
    return data && ["title", "description", "defaultCover"]
      .every((key) => typeof data[key] === "string") &&
      typeof data.spectrumEnabled === "boolean" && data.streamUrl === "/stream";
  }

  function validStats(data) {
    return data && typeof data.version === "string" && data.version &&
      ["uptimeSeconds", "visits", "listens", "online"]
        .every((key) => Number.isSafeInteger(data[key]) && data[key] >= 0);
  }

  function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `Up ${days}d ${hours}h`;
    if (hours) return `Up ${hours}h ${minutes}m`;
    if (minutes) return `Up ${minutes}m`;
    return `Up ${seconds}s`;
  }

  function renderStats(data) {
    const compact = new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    const exact = new Intl.NumberFormat("en");
    get("app-version").textContent = data.version;
    get("project-link").setAttribute(
      "aria-label",
      `GoFM version ${data.version} on GitHub`,
    );
    get("service-uptime").textContent = formatUptime(data.uptimeSeconds);
    get("service-uptime").title =
      `Service uptime: ${exact.format(data.uptimeSeconds)} seconds`;
    get("service-visits").textContent = `Visits ${compact.format(data.visits)}`;
    get("service-visits").title =
      `${exact.format(data.visits)} player page views since the first visit`;
    get("service-listens").textContent = `Listens ${compact.format(data.listens)}`;
    get("service-listens").title =
      `${exact.format(data.listens)} live stream connections since the first visit`;
    get("service-online").textContent = `Online ${compact.format(data.online)}`;
    get("service-online").title =
      `${exact.format(data.online)} active live stream connections`;
  }

  async function pollStats() {
    try {
      const data = await fetchJson("/api/stats");
      if (!validStats(data)) throw new Error("Invalid service statistics");
      if (leaving) return;
      renderStats(data);
    } catch {
      // Keep the last available values and retry while the player is open.
    } finally {
      if (!leaving) statsTimer = window.setTimeout(pollStats, 5000);
    }
  }

  async function loadSite() {
    try {
      const data = await fetchJson("/api/site");
      if (!validSite(data)) throw new Error("Invalid site configuration");
      if (leaving) return;
      site = data;
      const title = site.title || "BunFM";
      document.title = title + " — Live radio";
      document.querySelector('meta[name="description"]').content =
        site.description;

      get("site-title").textContent = title;
      renderText("site-description", site.description);
      renderShareLinks();

      renderCover(latestMetadata && latestMetadata.track);
      renderPlayback();
    } catch {
      if (leaving) return;

      siteTimer = window.setTimeout(loadSite, 10000);
    }
  }

  async function pollMetadata() {
    try {
      const data = await fetchJson("/api/now-playing");
      const track = data && data.track;
      if (!data || typeof data.muted !== "boolean" ||
          !(track === null || (track && ["id", "title", "artist", "album"]
            .every((key) => typeof track[key] === "string") &&
            (track.coverUrl === null || typeof track.coverUrl === "string")))) {
        throw new Error("Invalid track information");
      }
      if (leaving) return;
      renderMetadata(data);

    } catch {
      if (leaving) return;

    } finally {
      if (!leaving) metadataTimer = window.setTimeout(pollMetadata, 3000);
    }
  }

  function stopDrawing() {
    window.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastFrame = 0;
    if (painter) painter.clearRect(0, 0, canvas.width, canvas.height);

  }

  function canDraw() {
    return wanted && phase === "playing" && graph && graph.source &&
      graph.context.state === "running" && !document.hidden &&
      !reducedMotion.matches && !spectrumUnavailable;
  }

  function draw(time) {
    animationFrame = 0;
    if (!canDraw()) {
      stopDrawing();
      return;
    }
    animationFrame = window.requestAnimationFrame(draw);
    if (time - lastFrame < 40) return;
    lastFrame = time;
    try {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (!width || !height) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      graph.analyser.getByteFrequencyData(graph.bins);
      painter.clearRect(0, 0, width, height);
      painter.fillStyle = getComputedStyle(canvas).getPropertyValue("--accent");
      const count = 40;
      const step = width / count;
      for (let i = 0; i < count; i++) {
        const start = Math.floor(Math.pow(i / count, 2) * graph.bins.length);
        const end = Math.max(start + 1,
          Math.floor(Math.pow((i + 1) / count, 2) * graph.bins.length));
        let sum = 0;
        for (let bin = start; bin < end; bin++) sum += graph.bins[bin];
        const barHeight = (sum / (end - start) / 255) * height;
        if (barHeight > 0) {
          painter.fillRect(i * step, height - barHeight,
            Math.max(1, step - 3 * ratio), barHeight);
        }
      }
    } catch {
      disableSpectrum("The spectrum is unavailable. Audio can still play.");
    }
  }

  function updateDrawing() {
    if (!canDraw()) {
      stopDrawing();
    } else if (!animationFrame) {

      animationFrame = window.requestAnimationFrame(draw);
    }
  }

  function releaseAudio() {
    removeAudioListeners();
    removeAudioListeners = () => {};
    window.clearTimeout(connectionTimer);
    connectionTimer = 0;
    window.clearInterval(progressTimer);
    progressTimer = 0;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  function disableSpectrum(message) {
    spectrumUnavailable = true;
    stopDrawing();
    renderText("spectrum-note", message);
    const old = graph;
    graph = null;
    if (!old) return;
    old.context.onstatechange = null;
    // A media element captured by Web Audio cannot return to its native route.
    // Replace it only on graph failure; normal play/pause reuses one source.
    if (old.source) {
      const restart = wanted;
      ++attempt;
      releaseAudio();
      const replacement = audio.cloneNode(false);
      replacement.removeAttribute("src");
      audio.replaceWith(replacement);
      audio = replacement;
      if (restart) startPlayback();
    }
    try { if (old.source) old.source.disconnect(); } catch {}
    try { old.analyser.disconnect(); } catch {}
    try { Promise.resolve(old.context.close()).catch(() => {}); } catch {}
  }

  function prepareSpectrum(token) {
    if (!site.spectrumEnabled || spectrumUnavailable ||
        (reducedMotion.matches && !graph)) {
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || !painter) {
      disableSpectrum("Spectrum unavailable in this browser. Audio can still play.");
      return;
    }
    try {
      if (!graph) {
        const context = new AudioContext();
        try {
          if (typeof context.createAnalyser !== "function" ||
              typeof context.createMediaElementSource !== "function" ||
              typeof context.resume !== "function") {
            throw new Error("Audio analysis is unsupported");
          }
          const analyser = context.createAnalyser();
          if (typeof analyser.getByteFrequencyData !== "function" ||
              typeof analyser.connect !== "function") {
            throw new Error("Audio analysis is unsupported");
          }
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          analyser.connect(context.destination);
          graph = { context, analyser, source: null,
            bins: new Uint8Array(analyser.frequencyBinCount) };
          context.onstatechange = () => {
            if (graph && graph.context === context) {
              // Suspension/interruption is recoverable; keep the graph so
              // visibilitychange or the next play gesture can resume it.
              if (context.state === "closed") {
                disableSpectrum("Spectrum interrupted. Using standard audio playback.");
              } else {
                updateDrawing();
              }
            }
          };
        } catch (error) {
          try { Promise.resolve(context.close()).catch(() => {}); } catch {}
          throw error;
        }
      }
      const current = graph;
      const resumeTimer = window.setTimeout(() => {
        if (token === attempt && wanted && graph === current) {
          disableSpectrum("Spectrum did not start. Using standard audio playback.");
        }
      }, 2000);
      // Resume is called synchronously in the click gesture. Never capture the
      // element until the context really runs, so a blocked context stays native.
      Promise.resolve(current.context.resume()).then(() => {
        window.clearTimeout(resumeTimer);
        if (token !== attempt || !wanted || graph !== current) return;
        if (current.context.state !== "running") {
          disableSpectrum("Spectrum unavailable. Using standard audio playback.");
          return;
        }
        try {
          if (!current.source) {
            current.source = current.context.createMediaElementSource(audio);
            current.source.connect(current.analyser);
          }
          updateDrawing();
        } catch {
          disableSpectrum("Spectrum unavailable. Using standard audio playback.");
        }
      }).catch(() => {
        window.clearTimeout(resumeTimer);
        if (token === attempt && graph === current) {
          disableSpectrum("Spectrum unavailable. Using standard audio playback.");
        }
      });
    } catch {
      disableSpectrum("Spectrum unavailable in this browser. Audio can still play.");
    }
  }

  function pausePlayback() {
    wanted = false;
    ++attempt;
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    retryCount = 0;
    phase = "paused";
    stopDrawing();
    releaseAudio();
    if (graph) {
      try { Promise.resolve(graph.context.suspend()).catch(() => {}); } catch {}
    }
    renderPlayback();
  }

  function retryPlayback() {
    if (!wanted || leaving || retryTimer) return;
    ++attempt;
    releaseAudio();
    stopDrawing();
    phase = "retrying";
    renderPlayback();
    const delay = Math.min(1000 * 2 ** Math.min(retryCount++, 4), 15000);
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      if (wanted && !leaving) startPlayback();
    }, delay);
  }

  function startPlayback() {
    if (!site || leaving) return;
    const token = ++attempt;
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    releaseAudio();
    const element = audio;
    wanted = true;
    phase = "connecting";
    renderPlayback();
    const current = () => token === attempt && wanted && element === audio;
    const fail = () => { if (current()) retryPlayback(); };
    const armTimeout = () => {
      if (connectionTimer) return;
      connectionTimer = window.setTimeout(() => {
        connectionTimer = 0;
        fail();
      }, 15000);
    };
    const playing = () => {
      if (!current() || element.paused) return;
      window.clearTimeout(connectionTimer);
      connectionTimer = 0;
      phase = "playing";
      renderPlayback();
      updateDrawing();
    };
    const waiting = () => {
      if (!current()) return;
      phase = "buffering";
      renderPlayback();
      stopDrawing();
      armTimeout();
    };
    const error = fail;
    const ended = fail;
    const pause = () => {
      // play() clears paused synchronously, so queued load() events are ignored.
      // A genuine native pause must also release a connecting/buffering stream.
      if (current() && element.paused) fail();
    };
    let lastTime = element.currentTime;
    let lastProgress = Date.now();
    const checkProgress = () => {
      if (!current()) return;
      if (!element.paused && element.currentTime > lastTime) {
        lastTime = element.currentTime;
        lastProgress = Date.now();
        retryCount = 0;
        if (phase !== "playing") playing();
      } else if (Date.now() - lastProgress >= 15000) {
        fail();
      }
    };
    const events = { playing, waiting, stalled: waiting, error, ended, pause,
      timeupdate: checkProgress };
    for (const [name, handler] of Object.entries(events)) {
      element.addEventListener(name, handler);
    }
    removeAudioListeners = () => {
      for (const [name, handler] of Object.entries(events)) {
        element.removeEventListener(name, handler);
      }
    };
    armTimeout();
    progressTimer = window.setInterval(checkProgress, 1000);
    try {
      element.src = site.streamUrl + "?live=" + Date.now() + "-" + token;
      element.load();
      prepareSpectrum(token);
      // Graph setup can fall back to a new element. Do not play the old one.
      if (!current()) return;
      Promise.resolve(element.play()).catch(fail);
    } catch {
      fail();
    }
  }

  get("share-copy").addEventListener("click", (event) => {
    copyShareLink(event.currentTarget);
  });
  get("share-more").addEventListener("click", shareMore);
  get("share-close").addEventListener("click", closeShareFallback);
  get("share-fallback").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeShareFallback();
    }
  });
  get("share-url").addEventListener("click", (event) => {
    event.currentTarget.select();
  });

  button.addEventListener("click", () => {
    if (wanted) pausePlayback();
    else startPlayback();
  });
  window.addEventListener("online", () => {
    if (wanted && phase !== "playing") startPlayback();
  });
  document.addEventListener("visibilitychange", () => {
    updateDrawing();
    if (!document.hidden && wanted && graph &&
        graph.context.state !== "running") {
      // Safari can interrupt Web Audio while the page is in the background.
      // Keep the existing source and try to resume it when the page returns.
      try {
        Promise.resolve(graph.context.resume()).then(updateDrawing).catch(() => {});
      } catch {}
    }
  });
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", updateDrawing);
  } else if (reducedMotion.addListener) {
    reducedMotion.addListener(updateDrawing);
  }
  window.addEventListener("pagehide", () => {
    leaving = true;
    window.clearTimeout(siteTimer);
    window.clearTimeout(metadataTimer);
    window.clearTimeout(statsTimer);
    window.clearTimeout(shareTimer);
    window.clearTimeout(coverTimer);
    coverTimer = 0;
    coverKey = "";
    ++coverVersion;
    for (const request of requests) request.abort();
    pausePlayback();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    leaving = false;
    if (!site) loadSite();
    renderCover(latestMetadata && latestMetadata.track);
    pollMetadata();
    pollStats();
  });


  renderShareLinks();
  renderPlayback();
  renderCover(null);
  loadSite();
  pollMetadata();
  pollStats();
})();
