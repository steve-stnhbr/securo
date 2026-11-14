import type { Transaction } from '@/types'

/** An IBAN in groups of four, as banks print it; other identifiers unchanged. */
export function formatAccount(account: string): string {
  return /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(account) ? account.replace(/(.{4})(?=.)/g, '$1 ') : account
}

/**
 * Who is on the other side of a transaction, for display: the payee as
 * Securo knows it, else the name the bank sent, plus the bank's account
 * identifier. Null when there is nothing to add beyond the description.
 */
export function counterpartyDetails(tx: Transaction): { name: string | null; account: string | null } | null {
  const candidate = tx.payee_name ?? tx.payee ?? tx.counterparty_name ?? null
  const name = candidate && candidate.trim().toLowerCase() !== tx.description.trim().toLowerCase() ? candidate : null
  const account = tx.counterparty_account ? formatAccount(tx.counterparty_account) : null
  return name || account ? { name, account } : null
}
