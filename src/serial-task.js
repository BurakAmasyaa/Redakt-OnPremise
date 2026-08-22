export function createSerialTaskRunner() {
  let tail = Promise.resolve();

  return function runSerial(task) {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
}
