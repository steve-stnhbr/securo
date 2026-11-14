import { describe, expect, it } from 'vitest'
import type { DecisionModelSettings } from '@/lib/api'
import type { Transaction } from '@/types'
import { decisionPatch, draftFrom, suggestableTransactions } from './ui-helpers'

const saved: DecisionModelSettings = {
  engine: 'remote',
  remote_url: 'https://api.typesafe.ai/v1/systemone',
  remote_model: 'jev-1.13.0',
  api_key_configured: true,
  api_key_invalid: false,
  browser_model: 'acme/custom-embedder',
  default_browser_model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  can_store_secrets: true,
}

describe('decisionPatch', () => {
  it('is empty when nothing changed and never resends the saved key', () => {
    expect(decisionPatch(saved, draftFrom(saved))).toEqual({})
  })

  it('clears emptied fields and resets the browser model to the default', () => {
    const draft = { ...draftFrom(saved), engine: 'browser' as const, remoteModel: ' ', browserModel: saved.default_browser_model }
    expect(decisionPatch(saved, draft)).toEqual({ engine: 'browser', remote_model: null, browser_model: null })
  })
})

describe('suggestableTransactions', () => {
  it('keeps only uncategorized, unsplit rows of this workspace', () => {
    const rows = [
      { id: 'a', category_id: null },
      { id: 'b', category_id: 'food' },
      { id: 'c', category_id: null, has_category_lines: true },
      { id: 'd', category_id: null, viewer_share: 12 },
    ] as Transaction[]
    expect(suggestableTransactions(rows).map((tx) => tx.id)).toEqual(['a'])
  })
})
