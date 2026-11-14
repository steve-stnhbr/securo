import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Cloud, MonitorSmartphone, Power, Sparkles, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { admin, type DecisionEngine, type DecisionModelSettingsPatch } from '@/lib/api'
import { decisionPatch, draftFrom, type DecisionDraft as Draft } from '@/lib/decisions/ui-helpers'
import { cn } from '@/lib/utils'

/**
 * Remote services that speak TypeSafe's decision API. Choosing one fills
 * the URL and model; both stay editable. Ollaya serves open models (Kev,
 * Laya, Clef, ...) on your own hardware with the same API.
 */
export const REMOTE_PRESETS = [
  { id: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0' },
  { id: 'openrouter', url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
  { id: 'ollaya', url: 'http://ollaya:11435/v1/systemone', model: 'kev:0.8b' },
] as const

const engines: { id: DecisionEngine; icon: LucideIcon }[] = [
  { id: 'off', icon: Power },
  { id: 'browser', icon: MonitorSmartphone },
  { id: 'remote', icon: Cloud },
]

export function DecisionModelSettings() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['admin', 'decision-model'], queryFn: admin.decisionModel })
  const [draft, setDraft] = useState<Draft | null>(null)

  const save = useMutation({
    mutationFn: (patch: DecisionModelSettingsPatch) => admin.updateDecisionModel(patch),
    onSuccess: (saved) => {
      queryClient.setQueryData(['admin', 'decision-model'], saved)
      void queryClient.invalidateQueries({ queryKey: ['decision-config'] })
      setDraft(null)
      toast.success(t('admin.settings.updated'))
    },
    onError: () => toast.error(t('decisionModel.saveFailed')),
  })

  const settings = query.data
  const current = draft ?? (settings ? draftFrom(settings) : null)
  const update = (changes: Partial<Draft>) => current && setDraft({ ...current, ...changes })
  const patch = settings && current ? decisionPatch(settings, current) : {}
  const dirty = Object.keys(patch).length > 0
  const remoteIncomplete = current?.engine === 'remote' && !(current.remoteUrl.trim() && current.remoteModel.trim())
  const preset = REMOTE_PRESETS.find((p) => p.url === current?.remoteUrl.trim())?.id ?? 'custom'

  return (
    <section aria-labelledby="decision-model-heading" className="mb-8 overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border/40 px-5 py-4">
        <div className="mb-0.5 flex items-center gap-2">
          <Sparkles size={15} className="text-muted-foreground" aria-hidden="true" />
          <h2 id="decision-model-heading" className="text-sm font-semibold text-foreground">{t('decisionModel.title')}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t('decisionModel.description')}</p>
      </div>
      <div className="space-y-5 p-5">
        {query.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
            <span>{t('common.error')}</span>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>{t('common.retry')}</Button>
          </div>
        ) : !settings || !current ? (
          <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <>
            <fieldset className="grid gap-3 sm:grid-cols-3">
              <legend className="sr-only">{t('decisionModel.engineLabel')}</legend>
              {engines.map(({ id, icon: Icon }) => (
                <label
                  key={id}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-4 transition-colors',
                    current.engine === id ? 'border-primary bg-primary/5' : 'border-border/60 hover:bg-muted/40',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="radio"
                      name="decision-engine"
                      value={id}
                      checked={current.engine === id}
                      onChange={() => update({ engine: id })}
                      className="accent-primary"
                    />
                    <Icon size={15} aria-hidden="true" />
                    {t(`decisionModel.engines.${id}.title`)}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{t(`decisionModel.engines.${id}.description`)}</span>
                </label>
              ))}
            </fieldset>

            {current.engine === 'browser' && (
              <div className="space-y-2">
                <Label htmlFor="decision-browser-model">{t('decisionModel.browserModel')}</Label>
                <Input
                  id="decision-browser-model"
                  aria-describedby="decision-browser-model-help"
                  className="h-10 font-mono text-sm"
                  spellCheck={false}
                  value={current.browserModel}
                  placeholder={settings.default_browser_model}
                  onChange={(event) => update({ browserModel: event.target.value })}
                />
                <p id="decision-browser-model-help" className="text-xs leading-relaxed text-muted-foreground">
                  {t('decisionModel.browserModelHelp', { model: settings.default_browser_model })}
                </p>
              </div>
            )}

            {current.engine === 'remote' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="decision-preset">{t('decisionModel.preset')}</Label>
                  <select
                    id="decision-preset"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-80"
                    value={preset}
                    onChange={(event) => {
                      const chosen = REMOTE_PRESETS.find((p) => p.id === event.target.value)
                      if (chosen) update({ remoteUrl: chosen.url, remoteModel: chosen.model })
                    }}
                  >
                    {REMOTE_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>{t(`decisionModel.presets.${p.id}`)}</option>
                    ))}
                    <option value="custom">{t('decisionModel.presets.custom')}</option>
                  </select>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="decision-remote-url">{t('decisionModel.remoteUrl')}</Label>
                    <Input
                      id="decision-remote-url"
                      type="url"
                      className="h-10 font-mono text-sm"
                      spellCheck={false}
                      value={current.remoteUrl}
                      placeholder="https://…/v1/systemone"
                      onChange={(event) => update({ remoteUrl: event.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="decision-remote-model">{t('decisionModel.remoteModel')}</Label>
                    <Input
                      id="decision-remote-model"
                      className="h-10 font-mono text-sm"
                      spellCheck={false}
                      value={current.remoteModel}
                      placeholder="jev-1.13.0"
                      onChange={(event) => update({ remoteModel: event.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="decision-api-key">{t('decisionModel.apiKey')}</Label>
                    {settings.api_key_configured && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={save.isPending}
                        onClick={() => save.mutate({ api_key: null })}
                      >
                        {t('decisionModel.removeApiKey')}
                      </Button>
                    )}
                  </div>
                  <Input
                    id="decision-api-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="h-10"
                    disabled={!settings.can_store_secrets}
                    value={current.apiKey}
                    placeholder={t(settings.api_key_configured ? 'decisionModel.apiKeySaved' : 'decisionModel.apiKeyPlaceholder')}
                    onChange={(event) => update({ apiKey: event.target.value })}
                  />
                  {settings.api_key_invalid && (
                    <p role="alert" className="text-xs text-destructive">{t('decisionModel.apiKeyInvalid')}</p>
                  )}
                  {!settings.can_store_secrets && (
                    <p className="text-xs text-muted-foreground">{t('decisionModel.cannotStoreSecrets')}</p>
                  )}
                </div>
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{t('decisionModel.remotePrivacy')}</span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={!dirty || remoteIncomplete || save.isPending} onClick={() => save.mutate(patch)}>
                {save.isPending ? t('common.loading') : t('common.save')}
              </Button>
              {remoteIncomplete && <span className="text-xs text-muted-foreground">{t('decisionModel.remoteIncomplete')}</span>}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
