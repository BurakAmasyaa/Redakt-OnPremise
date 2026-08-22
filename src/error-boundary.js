const DYNAMIC_IMPORT_PATTERNS = [
  /failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /importing a module script failed/iu,
  /chunkloaderror/iu,
  /loading chunk [\w-]+ failed/iu,
];

function eventReason(event) {
  return event?.reason || event?.error || null;
}

function eventMessage(event) {
  const reason = eventReason(event);
  return [event?.message, reason?.message, typeof reason === "string" ? reason : ""]
    .filter(Boolean)
    .join(" ");
}

export function shouldShowFatalFallback(event) {
  const reason = eventReason(event);
  if (reason?.name === "AbortError") return false;
  const message = eventMessage(event);
  if (!message) return false;
  return !DYNAMIC_IMPORT_PATTERNS.some((pattern) => pattern.test(message));
}

export function installGlobalErrorBoundary({ windowObject = window, isProcessing, onFatal }) {
  let shown = false;
  const handle = (event) => {
    if (shown || !isProcessing() || !shouldShowFatalFallback(event)) return;
    shown = true;
    onFatal();
  };
  windowObject.addEventListener("error", handle, true);
  windowObject.addEventListener("unhandledrejection", handle);
  return () => {
    windowObject.removeEventListener("error", handle, true);
    windowObject.removeEventListener("unhandledrejection", handle);
  };
}
