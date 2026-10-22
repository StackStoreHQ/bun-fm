(() => {
  "use strict";

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }).catch((error) => {
      console.warn("Offline player support could not be registered.", error);
    });
  });
})();
