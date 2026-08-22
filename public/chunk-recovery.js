(function installChunkRecovery() {
  "use strict";

  var recoveryKey = "redakt:dynamic-import-reload-attempted";
  var dynamicImportPatterns = [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /chunkloaderror/i,
    /loading chunk [\w-]+ failed/i,
  ];

  function errorMessage(event) {
    var reason = event && event.reason;
    return [
      event && event.message,
      reason && reason.message,
      typeof reason === "string" ? reason : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function recoverFromStaleChunk(event) {
    var message = errorMessage(event);
    if (!dynamicImportPatterns.some(function matches(pattern) { return pattern.test(message); })) return;

    try {
      if (window.sessionStorage.getItem(recoveryKey)) return;
      window.sessionStorage.setItem(recoveryKey, "1");
    } catch (_error) {
      return;
    }

    window.location.reload();
  }

  window.addEventListener("error", recoverFromStaleChunk, true);
  window.addEventListener("unhandledrejection", recoverFromStaleChunk);
})();
