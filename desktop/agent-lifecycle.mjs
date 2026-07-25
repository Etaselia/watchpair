export function createSerialTaskQueue() {
  let pending = Promise.resolve();
  return (task) => {
    const result = pending.then(task, task);
    pending = result.catch(() => {});
    return result;
  };
}

export function ownsAgentProcess(current, candidate) {
  return current === candidate;
}
