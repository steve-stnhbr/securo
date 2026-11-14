import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

import { admin, type DecisionModelSettings as Settings } from '@/lib/api'
import { renderWithProviders } from '@/test/utils'

import { DecisionModelSettings } from './decision-model-settings'

vi.mock('@/lib/api', () => ({
  admin: { decisionModel: vi.fn(), updateDecisionModel: vi.fn() },
}))

const off: Settings = {
  engine: 'off',
  remote_url: '',
  remote_model: '',
  api_key_configured: false,
  api_key_invalid: false,
  browser_model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  default_browser_model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  can_store_secrets: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(admin.decisionModel).mockResolvedValue(off)
  vi.mocked(admin.updateDecisionModel).mockImplementation(async (patch) => ({ ...off, ...patch } as Settings))
})

describe('decision model settings', () => {
  it('switches to a remote preset and saves URL, model and key', async () => {
    const { user } = renderWithProviders(<DecisionModelSettings />)
    await user.click(await screen.findByRole('radio', { name: /Remote decision API/ }))

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Service'), 'ollaya')
    expect(screen.getByLabelText('Endpoint URL')).toHaveValue('http://ollaya:11435/v1/systemone')
    expect(screen.getByLabelText('Model')).toHaveValue('kev:0.8b')
    await user.type(screen.getByLabelText('API key'), 'local')
    expect(screen.getByText(/IBANs and long numbers masked/)).toBeVisible()

    await user.click(save)
    await waitFor(() => expect(admin.updateDecisionModel).toHaveBeenCalledWith({
      engine: 'remote',
      remote_url: 'http://ollaya:11435/v1/systemone',
      remote_model: 'kev:0.8b',
      api_key: 'local',
    }))
  })

  it('saves the browser engine without touching the remote fields', async () => {
    const { user } = renderWithProviders(<DecisionModelSettings />)
    await user.click(await screen.findByRole('radio', { name: /In the browser/ }))
    expect(screen.getByLabelText('Embedding model')).toHaveValue(off.browser_model)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(admin.updateDecisionModel).toHaveBeenCalledWith({ engine: 'browser' }))
  })
})
