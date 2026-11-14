import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { WorkspaceContext } from '@/contexts/workspace-context'
import { categories, decisions } from '@/lib/api'
import { renderWithProviders } from '@/test/utils'
import type { Transaction } from '@/types'

import { SuggestTransactionsAction } from './suggest-transactions-action'

vi.mock('@/lib/api', () => ({
  decisions: { config: vi.fn() },
  categories: { list: vi.fn() },
}))
vi.mock('@/components/suggest-transactions-dialog', () => ({
  SuggestTransactionsDialog: ({ open, transactions }: { open: boolean; transactions: Transaction[] }) =>
    open ? <p>dialog with {transactions.length}</p> : null,
}))

const rows = [
  { id: 'a', category_id: null },
  { id: 'b', category_id: 'food' },
] as Transaction[]

function render(canWrite: boolean) {
  return renderWithProviders(
    <WorkspaceContext.Provider value={{ canWrite } as never}>
      <SuggestTransactionsAction transactions={rows} />
    </WorkspaceContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(categories.list).mockResolvedValue([])
  vi.mocked(decisions.config).mockResolvedValue({ engine: 'browser', browser_model: 'x/y', remote_model: null })
})

describe('SuggestTransactionsAction', () => {
  it('opens the dialog for the uncategorized rows', async () => {
    const { user } = render(true)
    await user.click(await screen.findByRole('button', { name: 'Suggest' }))
    expect(screen.getByText('dialog with 1')).toBeVisible()
  })

  it('stays hidden when the engine is off or the member is read-only', async () => {
    vi.mocked(decisions.config).mockResolvedValue({ engine: 'off', browser_model: null, remote_model: null })
    render(true)
    await vi.waitFor(() => expect(decisions.config).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Suggest' })).not.toBeInTheDocument()

    vi.mocked(decisions.config).mockClear()
    render(false)
    expect(decisions.config).not.toHaveBeenCalled()
  })
})
