/**
 * Embeds text with a small sentence-embedding model, off the main thread.
 * WebGPU when the browser has it, WebAssembly otherwise. The weights are
 * fetched from the model hub once and kept in the browser cache; the text
 * itself never leaves this worker.
 */
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

export type EmbedRequest = { id: number; model: string; texts: string[] }
export type EmbedResponse =
  | { id: number; kind: 'progress'; loaded: number; total: number }
  | { id: number; kind: 'done'; vectors: number[][]; device: 'webgpu' | 'wasm' }
  | { id: number; kind: 'error'; message: string }

// Never look for weights on Securo's own origin: the SPA fallback would
// answer every missing file with index.html.
env.allowLocalModels = false

const scope = self as unknown as {
  postMessage: (message: EmbedResponse) => void
  onmessage: ((event: MessageEvent<EmbedRequest>) => void) | null
}

let loaded: { model: string; device: 'webgpu' | 'wasm'; extractor: Promise<FeatureExtractionPipeline> } | null = null
const BATCH = 32

function load(model: string, id: number) {
  if (loaded?.model === model) return loaded
  const files = new Map<string, { loaded: number; total: number }>()
  const progress_callback = (info: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status !== 'progress' || !info.file) return
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 })
    let done = 0
    let total = 0
    for (const file of files.values()) { done += file.loaded; total += file.total }
    scope.postMessage({ id, kind: 'progress', loaded: done, total })
  }
  const webgpu = 'gpu' in navigator
  // q8 everywhere: the smallest download (about 120 MB for the default
  // model), and plenty fast for a few thousand short bank descriptions.
  const make = (device: 'webgpu' | 'wasm') =>
    pipeline('feature-extraction', model, { device, dtype: 'q8', progress_callback }) as Promise<FeatureExtractionPipeline>
  const current = { model, device: (webgpu ? 'webgpu' : 'wasm') as 'webgpu' | 'wasm', extractor: null as unknown as Promise<FeatureExtractionPipeline> }
  current.extractor = webgpu
    ? make('webgpu').catch(() => { current.device = 'wasm'; return make('wasm') })
    : make('wasm')
  // A failed load is forgotten, so the next request tries again.
  current.extractor.catch(() => { if (loaded === current) loaded = null })
  loaded = current
  return current
}

scope.onmessage = async ({ data }) => {
  const { id, model, texts } = data
  try {
    const current = load(model, id)
    const extractor = await current.extractor
    const vectors: number[][] = []
    for (let i = 0; i < texts.length; i += BATCH) {
      const output = await extractor(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true })
      vectors.push(...(output.tolist() as number[][]))
    }
    scope.postMessage({ id, kind: 'done', vectors, device: current.device })
  } catch (error) {
    scope.postMessage({ id, kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
