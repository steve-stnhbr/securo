import { describe, expect, it } from 'vitest'
import {
  embeddingText,
  lexicalProfile,
  lexicalSimilarity,
  sameMerchant,
  suggestFromNeighbours,
  type LabelledExample,
} from './knn'

const unit = (...values: number[]) => {
  const norm = Math.hypot(...values)
  return values.map((v) => v / norm)
}

const example = (vector: number[], text: string, overrides: Partial<LabelledExample> = {}): LabelledExample => ({
  vector,
  lexical: lexicalProfile(text),
  type: 'debit',
  categoryId: 'groceries',
  payeeId: null,
  payeeName: null,
  transfer: false,
  recurring: false,
  ...overrides,
})

describe('embeddingText', () => {
  it('joins payee and description and collapses reference numbers', () => {
    expect(embeddingText('REWE SAGT DANKE 12345678', 'Rewe')).toBe('rewe rewe sagt danke #')
  })
})

describe('lexical signals', () => {
  it('skips booking words so the merchant leads', () => {
    expect(lexicalProfile('pos kartenzahlung billa ag 1234').words).toEqual(['billa'])
  })

  it('tells one merchant written two ways from two merchants', () => {
    const rewe = lexicalProfile('rewe sagt danke #')
    expect(sameMerchant(rewe, lexicalProfile('rewe markt wien # karte'))).toBe(true)
    expect(sameMerchant(lexicalProfile('amazon mktp de'), lexicalProfile('amzn mktp de #'))).toBe(false)
    expect(sameMerchant(lexicalProfile('netflix.com'), lexicalProfile('netflix com amsterdam'))).toBe(true)
    expect(sameMerchant(lexicalProfile('billa dankt'), lexicalProfile('spar dankt #'))).toBe(false)
    expect(lexicalSimilarity(rewe, lexicalProfile(''))).toBe(0)
  })
})

describe('suggestFromNeighbours', () => {
  it('votes the category by similarity and the payee only among the same merchant', () => {
    const target = lexicalProfile('billa dankt filiale #')
    const suggestion = suggestFromNeighbours('t1', unit(1, 0), target, 'debit', [
      example(unit(1, 0.05), 'billa ag', { payeeId: 'billa', payeeName: 'BILLA', recurring: true }),
      example(unit(1, 0.1), 'spar dankt', { payeeId: 'spar', payeeName: 'SPAR' }),
      example(unit(1, 0.3), 'spar supermarkt', { categoryId: 'household', payeeId: 'spar', payeeName: 'SPAR' }),
    ])
    expect(suggestion.category_id).toBe('groceries')
    expect(suggestion.category_probability).toBeGreaterThan(0.6)
    expect(suggestion.category_confidence).toBeLessThanOrEqual(suggestion.category_probability!)
    // SPAR is closer by count, but only BILLA is the same merchant.
    expect(suggestion.payee_id).toBe('billa')
    expect(suggestion.payee_name).toBe('BILLA')
    expect(suggestion.payee_probability).toBe(1)
    expect(suggestion.recurring_probability).toBeGreaterThan(0.3)
    expect(suggestion.transfer_probability).toBe(0)
  })

  it('lets trigram overlap find a neighbour the embedding misses', () => {
    const suggestion = suggestFromNeighbours('t1', unit(1, 0), lexicalProfile('netflix.com'), 'debit', [
      example(unit(0, 1), 'netflix com amsterdam', { categoryId: 'subscriptions' }),
    ])
    expect(suggestion.category_id).toBe('subscriptions')
  })

  it('ignores the other direction and distant examples', () => {
    const suggestion = suggestFromNeighbours('t1', unit(1, 0), lexicalProfile('gehalt'), 'debit', [
      example(unit(1, 0), 'gehalt', { type: 'credit', categoryId: 'salary' }),
      example(unit(0, 1), 'miete', { categoryId: 'rent' }),
    ])
    expect(suggestion.category_id).toBeNull()
    expect(suggestion.category_probability).toBeNull()
    expect(suggestion.transfer_probability).toBeNull()
  })
})
