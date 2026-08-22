export function hasActiveProcessing({ coordinator, batchScanning = false, bulkExporting = false } = {}) {
  return Boolean(
    batchScanning
    || bulkExporting
    || coordinator?.active?.("scan")
    || coordinator?.active?.("export")
  );
}

export function applyBeforeUnloadWarning(event, active) {
  if (!active) return false;
  event.preventDefault();
  event.returnValue = "";
  return true;
}

export function createBeforeUnloadGuard({ windowObject = window, isActive, onUnload = () => {} }) {
  let installed = false;
  const handle = (event) => {
    onUnload();
    applyBeforeUnloadWarning(event, true);
  };
  return {
    sync() {
      const active = Boolean(isActive());
      if (active && !installed) {
        windowObject.addEventListener("beforeunload", handle);
        installed = true;
      } else if (!active && installed) {
        windowObject.removeEventListener("beforeunload", handle);
        installed = false;
      }
    },
    installed() {
      return installed;
    },
  };
}
