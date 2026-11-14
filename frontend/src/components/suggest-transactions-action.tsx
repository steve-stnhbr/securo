import { useContext, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SuggestTransactionsDialog } from '@/components/suggest-transactions-dialog'
import { Button } from '@/components/ui/button'
import { WorkspaceContext } from '@/contexts/workspace-context'
import { categories as categoriesApi, decisions } from '@/lib/api'
import { suggestableTransactions } from '@/lib/decisions/ui-helpers'
import type { Transaction } from '@/types'

/**
 * A Suggest button and its dialog for any list of transactions, shown only
 * when an engine is on, the member can write, and some row can be filled.
 * Read from the context, not `useWorkspace`, so a panel rendered outside a
 * workspace provider just goes without the button.
 */
export function SuggestTransactionsAction({ transactions, className }: { transactions: Transaction[]; className?: string }) {
  const { t } = useTranslation()
  const canWrite = useContext(WorkspaceContext)?.canWrite ?? false
  const [open, setOpen] = useState(false)
  const { data: config } = useQuery({
    queryKey: ['decision-config'],
    queryFn: () => decisions.config(),
    staleTime: 5 * 60_000,
    enabled: canWrite,
  })
  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list(),
    enabled: canWrite && !!config && config.engine !== 'off',
  })
  const suggestable = useMemo(() => suggestableTransactions(transactions), [transactions])

  if (!canWrite || !config || config.engine === 'off' || !suggestable.length) return null
  return (
    <>
      <Button variant="outline" size="sm" className={className} onClick={() => setOpen(true)}>
        <Sparkles size={14} aria-hidden="true" />
        {t('decisionSuggestions.open')}
      </Button>
      <SuggestTransactionsDialog
        open={open}
        onOpenChange={setOpen}
        config={config}
        transactions={suggestable}
        categories={categories ?? []}
      />
    </>
  )
}
