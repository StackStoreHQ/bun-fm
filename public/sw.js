"use strict";

// Bump this version whenever a cached player asset changes.
const CACHE_PREFIX = "bunfm-shell-";
const CACHE_NAME = CACHE_PREFIX + "v9";
const SHELL_ASSETS = [
  "/",
  "/player.css",
  "/fonts/space-grotesk-latin.woff2",
  "/player.js",
  "/pwa.js",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icon.jpg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS.map((path) =>
        new Request(path, { cache: "reload" })
      ))
    )
  );
  // Let existing player windows close before activating an update.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const path = url.pathname === "/index.html" ? "/" : url.pathname;
  // Never intercept live audio, APIs, dynamic covers or external resources.
  if (!SHELL_ASSETS.includes(path)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(path)) || fetch(request);
  })());
});
