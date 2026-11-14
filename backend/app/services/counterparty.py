"""Who is on the other side of a bank transaction, read from the provider's raw data.

The payee a sync stores depends on the connection's payee-source setting,
and a description often carries only the bank's booking text ("VISA
Debitkartenumsatz vom 14.08.2026"). The raw payload usually still names
the counterparty, and for transfers it identifies the account, which is
the most stable signal there is: the same IBAN is almost always the same
payee and the same category.

Only the counterparty is read, never the account holder's own side, so a
debit cannot come back named after the user.
"""

import re
from typing import Any, Optional

_SPACES = re.compile(r"\s+")


def _text(value: Any) -> Optional[str]:
    return value.strip() or None if isinstance(value, str) else None


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _enable_banking(raw: dict, tx_type: str) -> tuple[Optional[str], Optional[str]]:
    # Money out goes to the creditor, money in comes from the debtor.
    party = "creditor" if tx_type == "debit" else "debtor"
    name = _text(_dict(raw.get(party)).get("name")) or _text(raw.get(f"{party}_name"))
    iban = _text(_dict(raw.get(f"{party}_account")).get("iban"))
    return name, _SPACES.sub("", iban).upper() if iban else None


def _pluggy(raw: dict, tx_type: str) -> tuple[Optional[str], Optional[str]]:
    payment = _dict(raw.get("paymentData"))
    party = _dict(payment.get("receiver" if tx_type == "debit" else "payer"))
    merchant = _dict(raw.get("merchant"))
    name = _text(merchant.get("name")) or _text(merchant.get("businessName")) or _text(party.get("name"))
    number = _text(party.get("accountNumber"))
    account = None
    if number:
        # Brazilian accounts have no IBAN; bank, branch and number identify one.
        parts = [_text(party.get("routingNumber")), _text(party.get("branchNumber")), number]
        account = "-".join(part for part in parts if part)
    return name, account


def counterparty(raw: Any, tx_type: str) -> tuple[Optional[str], Optional[str]]:
    """(name, account identifier) of the counterparty, each None when unknown."""
    if not isinstance(raw, dict):
        return None, None
    if "credit_debit_indicator" in raw or "creditor" in raw or "debtor" in raw:
        return _enable_banking(raw, tx_type)
    if "paymentData" in raw or "merchant" in raw:
        return _pluggy(raw, tx_type)
    return None, None
