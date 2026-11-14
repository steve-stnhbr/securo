import { decisions, type DecisionConfig, type DecisionSuggestion } from '@/lib/api'
import type { Transaction } from '@/types'
import type { EngineProgress } from './browser-engine'

export type { EngineProgress }

const REMOTE_BATCH = 50

/** Suggestions from whichever engine the administrator chose. */
export async function suggestTransactions(
  config: DecisionConfig,
  targets: Transaction[],
  onProgress?: (progress: EngineProgress) => void,
): Promise<DecisionSuggestion[]> {
  if (!targets.length) return []
  if (config.engine === 'browser' && config.browser_model) {
    // Loaded on demand: transformers.js and its runtime stay out of the
    // main bundle for everyone who never opens the dialog.
    const { suggestInBrowser } = await import('./browser-engine')
    return suggestInBrowser(targets, config.browser_model, onProgress)
  }
  if (config.engine === 'remote') {
    const out: DecisionSuggestion[] = []
    for (let i = 0; i < targets.length; i += REMOTE_BATCH) {
      const { suggestions } = await decisions.suggest(targets.slice(i, i + REMOTE_BATCH).map((tx) => tx.id))
      out.push(...suggestions)
    }
    return out
  }
  return []
}

/** Default bar for pre-selecting a suggestion; below it the user opts in. */
export const AUTO_SELECT_CONFIDENCE = 0.8
