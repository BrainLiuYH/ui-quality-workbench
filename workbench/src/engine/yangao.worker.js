import { analyzeImages } from './yangaoEngine.js'

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack,
  }
}

self.onmessage = async (event) => {
  const message = event.data
  if (message?.type !== 'analyze') return

  const { designImage, implementationImage, alignment, anchors } = message
  try {
    const result = await analyzeImages({
      designImage,
      implementationImage,
      alignment,
      anchors,
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
    })
    self.postMessage({ type: 'result', result })
  } catch (error) {
    self.postMessage({ type: 'error', error: serializeError(error) })
  } finally {
    designImage?.close?.()
    implementationImage?.close?.()
  }
}
