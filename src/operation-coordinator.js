function abortError(message) {
  return new DOMException(message, "AbortError");
}

export class OperationCoordinator {
  constructor() {
    this.controllers = new Map();
  }

  begin(kind) {
    this.abort(kind, abortError(`${kind} işlemi yenisiyle değiştirildi.`));
    const controller = new AbortController();
    this.controllers.set(kind, controller);
    return controller;
  }

  finish(kind, controller) {
    if (this.controllers.get(kind) === controller) this.controllers.delete(kind);
  }

  active(kind) {
    return this.controllers.get(kind) || null;
  }

  abort(kind, reason = abortError(`${kind} işlemi iptal edildi.`)) {
    const controller = this.controllers.get(kind);
    if (!controller) return false;
    this.controllers.delete(kind);
    controller.abort(reason);
    return true;
  }

  abortAll(reason = abortError("Tüm işlemler iptal edildi.")) {
    for (const kind of [...this.controllers.keys()]) this.abort(kind, reason);
  }
}

export function createOperationCoordinator() {
  return new OperationCoordinator();
}
