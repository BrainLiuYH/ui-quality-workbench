import { createAbortError, throwIfAborted } from './runtime.js'

function closeBitmap(bitmap) {
  if (bitmap && typeof bitmap.close === 'function') bitmap.close()
}

function deserializeWorkerError(payload) {
  const error = new Error(payload?.message || 'Image analysis failed in the worker')
  error.name = payload?.name || 'Error'
  if (payload?.stack) error.stack = payload.stack
  return error
}

/**
 * Decode local image files, transfer them to an isolated worker, and run yangao.
 * A fresh worker per run keeps cancellation deterministic: aborting terminates
 * both the CPU work and its temporary raster memory.
 */
export function analyzeImagesInWorker({
  designFile,
  implementationFile,
  signal,
  onProgress,
}) {
  try {
    throwIfAborted(signal)
  } catch (error) {
    return Promise.reject(error)
  }

  if (!(designFile instanceof Blob) || !(implementationFile instanceof Blob)) {
    return Promise.reject(new TypeError('designFile and implementationFile must be image Blobs'))
  }
  if (typeof Worker !== 'function' || typeof createImageBitmap !== 'function') {
    return Promise.reject(new Error('This browser does not support image-analysis workers'))
  }

  const worker = new Worker(new URL('./yangao.worker.js', import.meta.url), {
    type: 'module',
    name: 'yangao-image-analysis',
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let transferred = false
    let designBitmap = null
    let implementationBitmap = null

    const cleanup = () => {
      signal?.removeEventListener('abort', handleAbort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      if (!transferred) {
        closeBitmap(designBitmap)
        closeBitmap(implementationBitmap)
      }
    }

    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }

    const handleAbort = () => {
      finish(reject, createAbortError(signal?.reason))
    }

    signal?.addEventListener('abort', handleAbort, { once: true })

    worker.onmessage = (event) => {
      if (settled) return
      const message = event.data
      if (message?.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(message.progress)
        return
      }
      if (message?.type === 'result') {
        finish(resolve, message.result)
        return
      }
      if (message?.type === 'error') {
        finish(reject, deserializeWorkerError(message.error))
      }
    }

    worker.onerror = (event) => {
      event.preventDefault?.()
      finish(reject, new Error(event.message || 'Image analysis worker crashed'))
    }
    worker.onmessageerror = () => {
      finish(reject, new Error('Image analysis worker returned unreadable data'))
    }

    Promise.all([
      createImageBitmap(designFile).then((bitmap) => {
        designBitmap = bitmap
        return bitmap
      }),
      createImageBitmap(implementationFile).then((bitmap) => {
        implementationBitmap = bitmap
        return bitmap
      }),
    ]).then(() => {
      if (settled) {
        closeBitmap(designBitmap)
        closeBitmap(implementationBitmap)
        return
      }

      try {
        throwIfAborted(signal)
        worker.postMessage({
          type: 'analyze',
          designImage: designBitmap,
          implementationImage: implementationBitmap,
        }, [designBitmap, implementationBitmap])
        transferred = true
      } catch (error) {
        finish(reject, error)
      }
    }).catch((error) => {
      finish(reject, error)
    })
  })
}
