import type { DecisionEngine, DecisionModelSettings, DecisionModelSettingsPatch } from '@/lib/api'
import type { Transaction } from '@/types'

export type DecisionDraft = { engine: DecisionEngine; remoteUrl: string; remoteModel: string; apiKey: string; browserModel: string }

export function draftFrom(settings: DecisionModelSettings): DecisionDraft {
  return {
    engine: settings.engine,
    remoteUrl: settings.remote_url,
    remoteModel: settings.remote_model,
    apiKey: '',
    browserModel: settings.browser_model,
  }
}

/** The patch that turns `settings` into `draft`; empty strings clear. */
export function decisionPatch(settings: DecisionModelSettings, draft: DecisionDraft): DecisionModelSettingsPatch {
  const patch: DecisionModelSettingsPatch = {}
  const text = (value: string) => value.trim() || null
  if (draft.engine !== settings.engine) patch.engine = draft.engine
  if (draft.remoteUrl.trim() !== settings.remote_url) patch.remote_url = text(draft.remoteUrl)
  if (draft.remoteModel.trim() !== settings.remote_model) patch.remote_model = text(draft.remoteModel)
  if (draft.apiKey.trim()) patch.api_key = draft.apiKey.trim()
  const browserModel = draft.browserModel.trim()
  if (browserModel !== settings.browser_model) {
    patch.browser_model = !browserModel || browserModel === settings.default_browser_model ? null : browserModel
  }
  return patch
}

/** Rows a suggestion can fill: uncategorized, unsplit, owned by this workspace. */
export function suggestableTransactions(rows: Transaction[]): Transaction[] {
  return rows.filter((tx) => !tx.category_id && !tx.has_category_lines && !tx.viewer_share)
}
