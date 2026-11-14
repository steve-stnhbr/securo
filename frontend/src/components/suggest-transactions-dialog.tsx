import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Repeat, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { transactions as transactionsApi, type DecisionConfig, type DecisionSuggestion } from '@/lib/api'
import { AUTO_SELECT_CONFIDENCE, suggestTransactions, type EngineProgress } from '@/lib/decisions/engine'
import { invalidateFinancialQueries } from '@/lib/invalidate-queries'
import type { Category, Transaction } from '@/types'

/** Above this, a transfer or recurring hint is shown on the row. */
const HINT_THRESHOLD = 0.7

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: DecisionConfig
  transactions: Transaction[]
  categories: Category[]
}

const percent = (value: number | null) => (value === null ? '' : `${Math.round(value * 100)}%`)

export function SuggestTransactionsDialog({ open, onOpenChange, config, transactions, categories }: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<EngineProgress | null>(null)
  const [suggestions, setSuggestions] = useState<DecisionSuggestion[] | null>(null)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const categoryNames = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories])
  const byId = useMemo(() => new Map(transactions.map((tx) => [tx.id, tx])), [transactions])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSuggestions(null)
    setError(false)
    setProgress(null)
    suggestTransactions(config, transactions, (p) => { if (!cancelled) setProgress(p) })
      .then((result) => {
        if (cancelled) return
        setSuggestions(result)
        setSelected(new Set(result
          .filter((s) => s.category_id && (s.category_confidence ?? 0) >= AUTO_SELECT_CONFIDENCE)
          .map((s) => s.transaction_id)))
      })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
    // Run once per opening; the list underneath may refetch meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const apply = useMutation({
    mutationFn: async () => {
      const chosen = (suggestions ?? []).filter((s) => selected.has(s.transaction_id))
      const byCategory = new Map<string, string[]>()
      for (const s of chosen) {
        if (s.category_id) byCategory.set(s.category_id, [...(byCategory.get(s.category_id) ?? []), s.transaction_id])
      }
      for (const [categoryId, ids] of byCategory) await transactionsApi.bulkCategorize(ids, categoryId)
      // A payee only fills an empty one; a payee the user set stays.
      for (const s of chosen) {
        if (s.payee_id && !byId.get(s.transaction_id)?.payee_id) {
          await transactionsApi.update(s.transaction_id, { payee_id: s.payee_id })
        }
      }
      return chosen.length
    },
    onSuccess: (count) => {
      invalidateFinancialQueries(queryClient)
      toast.success(t('decisionSuggestions.applied', { count }))
      onOpenChange(false)
    },
    onError: () => toast.error(t('common.error')),
  })

  const rows = (suggestions ?? []).filter((s) => byId.has(s.transaction_id))
  const withAnswer = rows.filter((s) => s.category_id || s.payee_id)

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const status = error
    ? t('decisionSuggestions.failed')
    : progress?.stage === 'model'
      ? t('decisionSuggestions.downloadingModel', { percent: progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0 })
      : progress?.stage === 'history'
        ? t('decisionSuggestions.readingHistory')
        : t('decisionSuggestions.thinking')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} aria-hidden="true" />
            {t('decisionSuggestions.title')}
          </DialogTitle>
          <DialogDescription>
            {config.engine === 'browser'
              ? t('decisionSuggestions.engineBrowser')
              : t('decisionSuggestions.engineRemote', { model: config.remote_model })}
          </DialogDescription>
        </DialogHeader>

        {!suggestions ? (
          <p role={error ? 'alert' : 'status'} className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {status}
          </p>
        ) : !withAnswer.length ? (
          <p role="status" className="text-sm text-muted-foreground">{t('decisionSuggestions.none')}</p>
        ) : (
          <ul className="divide-y divide-border/40 rounded-lg border border-border/60">
            {withAnswer.map((s) => {
              const tx = byId.get(s.transaction_id)!
              const id = `suggestion-${s.transaction_id}`
              return (
                <li key={s.transaction_id} className="flex items-start gap-3 px-3 py-2.5">
                  <input
                    id={id}
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={selected.has(s.transaction_id)}
                    disabled={!s.category_id && !s.payee_id}
                    onChange={() => toggle(s.transaction_id)}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 space-y-1">
                    <span className="block truncate text-sm font-medium">{tx.description}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {s.category_id && (
                        <Badge variant="outline">
                          {categoryNames.get(s.category_id) ?? t('decisionSuggestions.unknownCategory')}
                          <span className="tabular-nums text-muted-foreground">{percent(s.category_confidence ?? s.category_probability)}</span>
                        </Badge>
                      )}
                      {s.payee_name && !tx.payee_id && (
                        <Badge variant="outline">{t('decisionSuggestions.payee', { name: s.payee_name })}</Badge>
                      )}
                      {(s.transfer_probability ?? 0) >= HINT_THRESHOLD && (
                        <Badge variant="secondary"><ArrowLeftRight aria-hidden="true" />{t('decisionSuggestions.looksLikeTransfer')}</Badge>
                      )}
                      {(s.recurring_probability ?? 0) >= HINT_THRESHOLD && (
                        <Badge variant="secondary"><Repeat aria-hidden="true" />{t('decisionSuggestions.looksRecurring')}</Badge>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={!selected.size || apply.isPending || !suggestions} onClick={() => apply.mutate()}>
            {apply.isPending ? t('common.loading') : t('decisionSuggestions.apply', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
