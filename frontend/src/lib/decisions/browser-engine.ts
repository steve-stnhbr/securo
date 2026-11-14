import { transactions as transactionsApi, type DecisionSuggestion } from '@/lib/api'
import type { Transaction } from '@/types'
import type { EmbedRequest, EmbedResponse } from './embed.worker'
import {
  commonWords,
  distinctiveText,
  embeddingText,
  lexicalProfile,
  suggestFromNeighbours,
  type LabelledExample,
} from './knn'

/** How much history the browser engine learns from: the latest labelled rows. */
const HISTORY_PAGES = 4
const HISTORY_PAGE_SIZE = 500

export type EngineProgress = { stage: 'history' } | { stage: 'model'; loaded: number; total: number } | { stage: 'embedding' }

let worker: Worker | null = null
let nextId = 0
// Per model: text -> vector, so reopening the dialog does not embed the
// whole history again in the same session.
const cache = new Map<string, Map<string, number[]>>()

function getWorker(): Worker {
  worker ??= new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

function embed(model: string, texts: string[], onProgress?: (p: EngineProgress) => void): Promise<number[][]> {
  const id = ++nextId
  const w = getWorker()
  return new Promise((resolve, reject) => {
    const listener = ({ data }: MessageEvent<EmbedResponse>) => {
      if (data.id !== id) return
      if (data.kind === 'progress') {
        onProgress?.({ stage: 'model', loaded: data.loaded, total: data.total })
        return
      }
      w.removeEventListener('message', listener)
      if (data.kind === 'done') resolve(data.vectors)
      else reject(new Error(data.message))
    }
    w.addEventListener('message', listener)
    w.postMessage({ id, model, texts } satisfies EmbedRequest)
  })
}

async function embedCached(model: string, texts: string[], onProgress?: (p: EngineProgress) => void) {
  const known = cache.get(model) ?? new Map<string, number[]>()
  cache.set(model, known)
  const missing = [...new Set(texts.filter((text) => !known.has(text)))]
  if (missing.length) {
    const vectors = await embed(model, missing, onProgress)
    missing.forEach((text, i) => known.set(text, vectors[i]))
  }
  return texts.map((text) => known.get(text)!)
}

async function labelledHistory(exclude: Set<string>): Promise<Transaction[]> {
  const rows: Transaction[] = []
  for (let page = 1; page <= HISTORY_PAGES; page++) {
    const { items, total } = await transactionsApi.list({ page, limit: HISTORY_PAGE_SIZE })
    rows.push(...items)
    if (page * HISTORY_PAGE_SIZE >= total) break
  }
  return rows.filter((tx) =>
    !exclude.has(tx.id)
    && !tx.has_category_lines
    && !tx.viewer_share
    && (tx.category_id !== null || tx.payee_id !== null),
  )
}

/**
 * The browser engine: embed the targets and the user's own labelled history
 * locally, and let the nearest labelled transactions vote.
 */
export async function suggestInBrowser(
  targets: Transaction[],
  model: string,
  onProgress?: (p: EngineProgress) => void,
): Promise<DecisionSuggestion[]> {
  onProgress?.({ stage: 'history' })
  const history = await labelledHistory(new Set(targets.map((tx) => tx.id)))
  const raw = (tx: Transaction) => embeddingText(tx.description, tx.payee)
  // Boilerplate is judged over everything in view, so a bank that writes
  // "VISA Debitkartenumsatz vom ..." on every line does not make all of
  // them look like one merchant.
  const common = commonWords([...history, ...targets].map(raw))
  const text = (tx: Transaction) => distinctiveText(raw(tx), common)
  // A row left with no distinctive word cannot be told from any other, so
  // it neither votes nor gets a suggestion.
  const labelled = history.map((tx) => ({ tx, text: text(tx) })).filter((row) => row.text)
  const asked = targets.map((tx) => ({ tx, text: text(tx) }))
  const answerable = asked.filter((row) => row.text)
  const none = (tx: Transaction) => suggestFromNeighbours(tx.id, [], lexicalProfile(''), tx.type, [])
  if (!labelled.length || !answerable.length) return targets.map(none)

  const vectors = await embedCached(model, [...labelled, ...answerable].map((row) => row.text), onProgress)
  onProgress?.({ stage: 'embedding' })
  const examples: LabelledExample[] = labelled.map(({ tx, text }, i) => ({
    vector: vectors[i],
    lexical: lexicalProfile(text),
    type: tx.type,
    categoryId: tx.category_id,
    payeeId: tx.payee_id,
    payeeName: tx.payee_name ?? tx.payee,
    transfer: tx.transfer_pair_id !== null,
    recurring: Boolean(tx.recurring_transaction_id),
  }))
  const vectorOf = new Map(answerable.map((row, i) => [row.tx.id, vectors[labelled.length + i]]))
  return asked.map(({ tx, text }) => {
    const vector = vectorOf.get(tx.id)
    return vector
      ? suggestFromNeighbours(tx.id, vector, lexicalProfile(text), tx.type, examples)
      : none(tx)
  })
}
