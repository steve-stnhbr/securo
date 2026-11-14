import { describe, expect, it } from 'vitest'
import type { Transaction } from '@/types'
import { counterpartyDetails, formatAccount } from './counterparty'

const tx = (fields: Partial<Transaction>) => ({ description: 'VISA Debitkartenumsatz vom 14.08.2026', payee: null, payee_name: null, ...fields }) as Transaction

describe('formatAccount', () => {
  it('groups an IBAN by four and leaves other identifiers alone', () => {
    expect(formatAccount('AT611904300234573201')).toBe('AT61 1904 3002 3457 3201')
    expect(formatAccount('260-0001-123')).toBe('260-0001-123')
  })
})

describe('counterpartyDetails', () => {
  it('prefers the payee, falls back to the bank name, and adds the account', () => {
    expect(counterpartyDetails(tx({ payee_name: 'Billa', counterparty_name: 'BILLA AG' }))).toEqual({ name: 'Billa', account: null })
    expect(counterpartyDetails(tx({ counterparty_name: 'BILLA AG', counterparty_account: 'AT611904300234573201' })))
      .toEqual({ name: 'BILLA AG', account: 'AT61 1904 3002 3457 3201' })
  })

  it('adds nothing that the description already says', () => {
    expect(counterpartyDetails(tx({ description: 'Netflix', payee: 'NETFLIX' }))).toBeNull()
    expect(counterpartyDetails(tx({}))).toBeNull()
  })
})
