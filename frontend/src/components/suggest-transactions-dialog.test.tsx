import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { transactions } from '@/lib/api'
import { suggestTransactions } from '@/lib/decisions/engine'
import { renderWithProviders } from '@/test/utils'
import type { Category, Transaction } from '@/types'

import { SuggestTransactionsDialog } from './suggest-transactions-dialog'

vi.mock('@/lib/api', () => ({
  transactions: { bulkCategorize: vi.fn(), update: vi.fn() },
}))
vi.mock('@/lib/decisions/engine', () => ({
  AUTO_SELECT_CONFIDENCE: 0.8,
  suggestTransactions: vi.fn(),
}))

const rows = [
  { id: 't1', description: 'BILLA DANKT', payee_id: null },
  { id: 't2', description: 'NETFLIX.COM', payee_id: 'already-set' },
  { id: 't3', description: 'UNKNOWN SHOP', payee_id: null },
] as Transaction[]
const categories = [
  { id: 'groceries', name: 'Groceries' },
  { id: 'subscriptions', name: 'Subscriptions' },
] as Category[]
const blank = {
  category_id: null, category_probability: null, category_confidence: null,
  payee_id: null, payee_name: null, payee_probability: null,
  transfer_probability: null, recurring_probability: null, error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(transactions.bulkCategorize).mockResolvedValue({ updated: 1 })
  vi.mocked(transactions.update).mockResolvedValue({} as Transaction)
  vi.mocked(suggestTransactions).mockResolvedValue([
    { ...blank, transaction_id: 't1', category_id: 'groceries', category_probability: 0.95, category_confidence: 0.9, payee_id: 'billa', payee_name: 'BILLA' },
    { ...blank, transaction_id: 't2', category_id: 'subscriptions', category_probability: 0.6, category_confidence: 0.5, payee_id: 'netflix', payee_name: 'Netflix', recurring_probability: 0.9 },
    { ...blank, transaction_id: 't3' },
  ])
})

describe('suggest transactions dialog', () => {
  it('preselects confident rows and applies category and missing payee', async () => {
    const onOpenChange = vi.fn()
    const { user } = renderWithProviders(
      <SuggestTransactionsDialog
        open
        onOpenChange={onOpenChange}
        config={{ engine: 'browser', browser_model: 'x/y', remote_model: null }}
        transactions={rows}
        categories={categories}
      />,
    )

    const billa = await screen.findByRole('checkbox', { name: /BILLA DANKT/ })
    const netflix = screen.getByRole('checkbox', { name: /NETFLIX\.COM/ })
    expect(billa).toBeChecked()
    expect(netflix).not.toBeChecked()
    expect(screen.queryByText('UNKNOWN SHOP')).not.toBeInTheDocument()
    expect(screen.getByText('Looks recurring')).toBeVisible()
    // The row's own payee wins, so no payee badge for Netflix.
    expect(screen.queryByText('Payee: Netflix')).not.toBeInTheDocument()

    await user.click(netflix)
    await user.click(screen.getByRole('button', { name: 'Apply (2)' }))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(transactions.bulkCategorize).toHaveBeenCalledWith(['t1'], 'groceries')
    expect(transactions.bulkCategorize).toHaveBeenCalledWith(['t2'], 'subscriptions')
    expect(transactions.update).toHaveBeenCalledTimes(1)
    expect(transactions.update).toHaveBeenCalledWith('t1', { payee_id: 'billa' })
  })
})
