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
  let muted = false;
  let wanted = false;
  let phase = "paused";
  let playbackError = "";
  let attempt = 0;
  let connectionTimer = 0;
  let removeAudioListeners = () => {};
  let graph = null;
  let spectrumUnavailable = false;
  let animationFrame = 0;
  let lastFrame = 0;
  let leaving = false;
  let siteTimer = 0;
  let metadataTimer = 0;
  const requests = new Set();
  let starsLoaded = false;

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

  function alignFooter() {
    const artwork = document.querySelector(".artwork").getBoundingClientRect();
    const shell = document.querySelector(".shell").getBoundingClientRect();
    document.querySelector(".site-footer").style.paddingInlineStart =
      Math.max(0, artwork.left - shell.left) + "px";
  }

  function renderGitHubStars(count) {
    const exact = new Intl.NumberFormat("en").format(count);
    const compact = new Intl.NumberFormat("en", {
      notation: "compact", maximumFractionDigits: 1,
    }).format(count);
    const label = "BunFM on GitHub, " + exact + " stars";
    get("github-stars").textContent = "· " + compact + " stars";
    get("github-stars").dataset.loaded = "true";
    get("github-link").setAttribute("aria-label", label);
    get("github-link").title = label;
    starsLoaded = true;
  }

  async function loadGitHubStars() {
    const cacheKey = "bunfm.github-stars:pxgo/bun-fm";
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey));
      if (cached && Number.isSafeInteger(cached.count) && cached.count >= 0 &&
          Number.isFinite(cached.at) && cached.at <= Date.now() &&
          Date.now() - cached.at < 60 * 60 * 1000) {
        renderGitHubStars(cached.count);
        return;
      }
    } catch {
      // Storage may be disabled; the optional request still works without it.
    }
    const controller = new AbortController();
    requests.add(controller);
    const timer = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch("https://api.github.com/repos/pxgo/bun-fm", {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok) return;
      const data = await response.json();
      const count = data && data.stargazers_count;
      if (leaving || !Number.isSafeInteger(count) || count < 0) return;
      renderGitHubStars(count);
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ count, at: Date.now() }));
      } catch {
        // A blocked/full cache must never affect playback or the GitHub link.
      }
    } catch {
      // Offline, rate limited or timed out: keep the static GitHub link only.
    } finally {
      window.clearTimeout(timer);
      requests.delete(controller);
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
    get("play-icon").toggleAttribute("hidden", wanted);
    get("pause-icon").toggleAttribute("hidden", !wanted);
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
    } else if (phase === "error") {
      status = "Unable to play";
      hint = playbackError + " Press play to retry.";
    }
    get("playback-status").textContent = status;
    get("playback-hint").textContent = hint;
    renderText("playback-error", phase === "error" ? hint : "");
  }

  function renderCover(track) {
    const candidates = [...new Set([
      track && track.coverUrl,
      site && site.defaultCover,
      "/icon.jpg",
    ].map(safeUrl).filter(Boolean))];
    const key = JSON.stringify(candidates);
    if (key === coverKey) return;
    coverKey = key;
    const version = ++coverVersion;
    let index = 0;
    const tryNext = () => {
      if (version !== coverVersion) return;
      if (index >= candidates.length) {
        cover.hidden = true;
        background.hidden = true;
        return;
      }
      const url = candidates[index++];
      const isTrackCover = track && url === safeUrl(track.coverUrl);
      cover.alt = isTrackCover ?
        "Cover artwork for " + (track.album || track.title || "the current track") :
        "Station artwork";
      cover.hidden = true;
      cover.onload = () => {
        if (version !== coverVersion) return;
        cover.hidden = false;
        background.hidden = false;
        background.onerror = () => { background.hidden = true; };
        background.src = url;
      };
      cover.onerror = tryNext;
      cover.src = url;
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


      renderText("site-error", "");
      renderCover(latestMetadata && latestMetadata.track);
      renderPlayback();
    } catch {
      if (leaving) return;
      renderText("site-error",
        "Station settings could not be loaded. Retrying automatically.");
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
      renderText("metadata-error", "");
    } catch {
      if (leaving) return;
      renderText("metadata-error", latestMetadata ?
        "Track information may be out of date. Retrying automatically." :
        "Track information is unavailable. Retrying automatically.");
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
    if (!window.isSecureContext || !AudioContext || !painter) {
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
              if (wanted && graph.source && context.state !== "running") {
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

  function pausePlayback(error = "") {
    wanted = false;
    ++attempt;
    phase = error ? "error" : "paused";
    playbackError = error;
    stopDrawing();
    releaseAudio();
    if (graph) {
      try { Promise.resolve(graph.context.suspend()).catch(() => {}); } catch {}
    }
    renderPlayback();
  }

  function mediaError(element) {
    switch (element.error && element.error.code) {
      case 2: return "A network error interrupted the stream.";
      case 3: return "Your browser could not decode the audio.";
      case 4: return "The stream is unavailable or its format is unsupported.";
      default: return "The audio stream was interrupted.";
    }
  }

  function startPlayback() {
    if (!site || leaving) return;
    const token = ++attempt;
    const element = audio;
    wanted = true;
    phase = "connecting";
    playbackError = "";
    renderPlayback();
    const current = () => token === attempt && wanted && element === audio;
    const fail = (message) => { if (current()) pausePlayback(message); };
    const armTimeout = () => {
      if (connectionTimer) return;
      connectionTimer = window.setTimeout(() => {
        connectionTimer = 0;
        fail("The stream took too long to respond. Check your connection.");
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
    const error = () => {
      if (element.error) fail(mediaError(element));
    };
    const ended = () => fail("The live stream has ended.");
    const pause = () => {
      // play() clears paused synchronously, so queued load() events are ignored.
      // A genuine native pause must also release a connecting/buffering stream.
      if (current() && element.paused) pausePlayback();
    };
    const events = { playing, waiting, stalled: waiting, error, ended, pause };
    for (const [name, handler] of Object.entries(events)) {
      element.addEventListener(name, handler);
    }
    removeAudioListeners = () => {
      for (const [name, handler] of Object.entries(events)) {
        element.removeEventListener(name, handler);
      }
    };
    armTimeout();
    try {
      element.src = site.streamUrl + "?live=" + Date.now() + "-" + token;
      element.load();
      prepareSpectrum(token);
      // Graph setup can fall back to a new element. Do not play the old one.
      if (!current()) return;
      Promise.resolve(element.play()).catch((reason) => {
        fail(reason && reason.name === "NotAllowedError" ?
          "Your browser blocked playback. Select play to allow audio." :
          "Playback could not start in your browser.");
      });
    } catch {
      fail("Playback is not supported in this browser.");
    }
  }

  button.addEventListener("click", () => {
    if (wanted) pausePlayback();
    else startPlayback();
  });
  document.addEventListener("visibilitychange", updateDrawing);
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", updateDrawing);
  } else if (reducedMotion.addListener) {
    reducedMotion.addListener(updateDrawing);
  }
  window.addEventListener("pagehide", () => {
    leaving = true;
    window.clearTimeout(siteTimer);
    window.clearTimeout(metadataTimer);
    for (const request of requests) request.abort();
    pausePlayback();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    leaving = false;
    if (!site) loadSite();
    if (!starsLoaded) loadGitHubStars();
    alignFooter();
    pollMetadata();
  });

  if (window.ResizeObserver) {
    const footerObserver = new ResizeObserver(alignFooter);
    footerObserver.observe(document.querySelector(".artwork"));
    footerObserver.observe(document.querySelector(".shell"));
  }
  window.addEventListener("resize", alignFooter);
  alignFooter();
  renderPlayback();
  renderCover(null);
  loadSite();
  pollMetadata();
  loadGitHubStars();
})();
