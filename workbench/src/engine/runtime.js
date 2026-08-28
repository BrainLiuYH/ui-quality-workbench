export function createAbortError(reason) {
  if (reason instanceof Error) return reason
  if (typeof DOMException === 'function') {
    return new DOMException(reason || 'Image analysis was aborted', 'AbortError')
  }
  const error = new Error(reason || 'Image analysis was aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason)
}

export function reportProgress(onProgress, phase, percent) {
  if (typeof onProgress !== 'function') return
  onProgress({ phase, percent: Math.max(0, Math.min(100, Math.round(percent))) })
}

export async function yieldToHost(signal) {
  throwIfAborted(signal)
  await new Promise((resolve) => setTimeout(resolve, 0))
  throwIfAborted(signal)
}
