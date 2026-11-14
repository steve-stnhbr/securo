import type { DecisionSuggestion } from '@/lib/api'

/**
 * The words of a transaction text that can name a merchant, and their
 * character trigrams. Built once per text and reused for every comparison.
 */
export interface LexicalProfile {
  words: string[]
  trigrams: Set<string>
}

/** A transaction the user already labelled, as the browser engine sees it. */
export interface LabelledExample {
  vector: ArrayLike<number>
  lexical: LexicalProfile
  /** The counterparty's IBAN or account number, when the bank sent one. */
  account: string | null
  type: 'debit' | 'credit'
  categoryId: string | null
  payeeId: string | null
  payeeName: string | null
  transfer: boolean
  recurring: boolean
}

export interface KnnOptions {
  /** Neighbours that vote. */
  k?: number
  /** Similarity below which an example is not a neighbour at all. */
  minSimilarity?: number
}

const DEFAULT_K = 8
// Measured on real statement lines with the default multilingual MiniLM:
// one merchant's lines mostly score 0.45 and up on the better of the two
// signals, unrelated merchants below 0.3. Between the two sit merchants of
// the same kind (two supermarkets), which is a fair category vote.
const DEFAULT_MIN_SIMILARITY = 0.45
// A trigram overlap this high names the same merchant even when the first
// word differs ("amazon mktp" vs "amzn mktp").
const SAME_MERCHANT_DICE = 0.6

/**
 * Words banks put in front of the merchant: booking types, not names. They
 * are skipped so "POS REWE" and "POS SPAR" do not look like one merchant.
 */
const BOOKING_WORDS = new Set([
  'pos', 'sepa', 'card', 'debit', 'credit', 'purchase', 'payment', 'transfer', 'direct',
  'lastschrift', 'gutschrift', 'kartenzahlung', 'zahlung', 'überweisung', 'ueberweisung', 'dauerauftrag',
  'bankomat', 'maestro', 'visa', 'mastercard', 'compra', 'pagamento', 'pago', 'cartão', 'cartao',
  'tarjeta', 'paiement', 'carte', 'achat', 'prelevement', 'prélèvement', 'virement', 'pix', 'ted', 'doc',
])

/**
 * What the transaction's text looks like to the models: payee and
 * description, lowercased, with long digit runs (references, card and
 * account numbers) collapsed so two charges from one merchant still match.
 */
export function embeddingText(description: string, payee?: string | null): string {
  return `${payee ?? ''} ${description}`
    .toLowerCase()
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !BOOKING_WORDS.has(word))
}

/** Share of texts a word must reach before it counts as boilerplate. */
const COMMON_SHARE = 0.2
/** A word in fewer texts than this is never boilerplate, whatever the share. */
const COMMON_MIN_COUNT = 5

/**
 * Words that appear in so many of a user's transactions that they cannot
 * name a merchant: the bank's own boilerplate, in whatever language it
 * writes it ("visa debitkartenumsatz vom", "compra cartão", ...). Counted
 * once per text. A single merchant rarely reaches a fifth of all rows,
 * so its name survives.
 */
export function commonWords(texts: string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const word of new Set(words(text))) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const threshold = Math.max(COMMON_MIN_COUNT, texts.length * COMMON_SHARE)
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([word]) => word))
}

/**
 * The text with boilerplate removed: booking words, words in `common`, and
 * tokens without a letter (dates, amounts, masked numbers). What is left is
 * what can tell one merchant from another, and may well be nothing.
 */
export function distinctiveText(text: string, common: Set<string>): string {
  return text
    .split(/\s+/)
    .filter((token) => {
      if (!/\p{L}/u.test(token)) return false
      const tokenWords = words(token)
      return tokenWords.length > 0 && tokenWords.some((word) => !common.has(word))
    })
    .join(' ')
}

export function lexicalProfile(text: string): LexicalProfile {
  const found = words(text)
  const trigrams = new Set<string>()
  for (const word of found) {
    const padded = ` ${word} `
    for (let i = 0; i < padded.length - 2; i++) trigrams.add(padded.slice(i, i + 3))
  }
  return { words: found, trigrams }
}

/** Dice coefficient of the two texts' character trigrams. */
export function lexicalSimilarity(a: LexicalProfile, b: LexicalProfile): number {
  if (!a.trigrams.size || !b.trigrams.size) return 0
  let shared = 0
  for (const gram of a.trigrams) if (b.trigrams.has(gram)) shared++
  return (2 * shared) / (a.trigrams.size + b.trigrams.size)
}

/**
 * Whether two texts plausibly name one merchant: they lead with the same
 * word (merchants come first on a statement line once booking words are
 * gone), or most of their trigrams agree.
 */
export function sameMerchant(a: LexicalProfile, b: LexicalProfile, dice = lexicalSimilarity(a, b)): boolean {
  const [x] = a.words
  const [y] = b.words
  return Boolean(x && y && x === y) || dice >= SAME_MERCHANT_DICE
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

function vote<K>(neighbours: { weight: number; key: K | null }[], total: number) {
  const tally = new Map<K, number>()
  for (const { weight, key } of neighbours) {
    if (key !== null) tally.set(key, (tally.get(key) ?? 0) + weight)
  }
  let best: K | null = null
  let bestWeight = 0
  for (const [key, weight] of tally) {
    if (weight > bestWeight) { best = key; bestWeight = weight }
  }
  return { best, probability: best === null || total <= 0 ? null : bestWeight / total }
}

/**
 * Suggest a category, payee and the transfer and recurring hints from the
 * closest labelled examples.
 *
 * A neighbour paid to or from the same counterparty account (IBAN) is an
 * exact match. Otherwise similarity is the better of two signals: the embedding's cosine (vectors
 * must be L2-normalised), which groups merchants of the same kind, and the
 * trigram overlap, which catches one merchant written two ways. Category
 * and the hints are voted on by every neighbour; the payee only by the
 * neighbours that look like the same merchant, since "the same kind of
 * shop" is a category, not a payee.
 *
 * A probability is the similarity-weighted share of voters that agree;
 * the category confidence also discounts it by how close the nearest
 * neighbour is, so a unanimous vote among distant look-alikes still asks
 * for review.
 */
export function suggestFromNeighbours(
  transactionId: string,
  vector: ArrayLike<number>,
  lexical: LexicalProfile,
  type: 'debit' | 'credit',
  examples: LabelledExample[],
  options: KnnOptions = {},
  account: string | null = null,
): DecisionSuggestion {
  const k = options.k ?? DEFAULT_K
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY
  const neighbours = examples
    .filter((example) => example.type === type)
    .map((example) => {
      // One counterparty account is one payee, whatever the text says.
      if (account && example.account === account) return { example, similarity: 1, merchant: true }
      const dice = lexicalSimilarity(lexical, example.lexical)
      return {
        example,
        similarity: Math.max(dot(vector, example.vector), dice),
        merchant: sameMerchant(lexical, example.lexical, dice),
      }
    })
    .filter(({ similarity }) => similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)

  const empty: DecisionSuggestion = {
    transaction_id: transactionId,
    category_id: null,
    category_probability: null,
    category_confidence: null,
    payee_id: null,
    payee_name: null,
    payee_probability: null,
    transfer_probability: null,
    recurring_probability: null,
    error: null,
  }
  if (!neighbours.length) return empty

  const total = neighbours.reduce((sum, n) => sum + n.similarity, 0)
  const closeness = Math.min(1, neighbours[0].similarity)
  const category = vote(neighbours.map((n) => ({ weight: n.similarity, key: n.example.categoryId })), total)
  const merchants = neighbours.filter((n) => n.merchant)
  const payee = vote(
    merchants.map((n) => ({ weight: n.similarity, key: n.example.payeeId })),
    merchants.reduce((sum, n) => sum + n.similarity, 0),
  )
  const share = (pick: (e: LabelledExample) => boolean) =>
    neighbours.reduce((sum, n) => sum + (pick(n.example) ? n.similarity : 0), 0) / total

  return {
    ...empty,
    category_id: category.best,
    category_probability: category.probability,
    category_confidence: category.probability === null ? null : category.probability * closeness,
    payee_id: payee.best,
    payee_name: payee.best === null
      ? null
      : merchants.find((n) => n.example.payeeId === payee.best)?.example.payeeName ?? null,
    payee_probability: payee.probability,
    transfer_probability: share((e) => e.transfer),
    recurring_probability: share((e) => e.recurring),
  }
}
