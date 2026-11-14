"""Suggest what a transaction is, by asking a remote decision model.

A decision model gets a state and typed questions and answers each with a
probability instead of text. The request uses TypeSafe's ``/v1/systemone``
wire format, which Jev, OpenRouter's decisions route, Clef and a
self-hosted Ollaya server (Kev, Laya, ...) all accept:

    {"model": ..., "state": {...}, "questions": {id: {"type", "instructions", "criteria"}}}

and answer

    {"answers": {id: {"type": "choice", "choice", "probabilities", "confidence"}
                     | {"type": "noul", "noul"}}}

Four questions are asked per transaction, which is everything a Securo
transaction leaves for a model to determine: its category, its payee, and
whether it looks like a transfer between own accounts or a recurring
charge. The last two are hints; pairing and recurring-bill matching stay
with their own services.

Only what the questions need is sent: the description and payee text with
IBANs and long digit runs masked, the direction, amount and currency.
"""

import asyncio
import math
import re
import uuid
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category
from app.models.payee import Payee
from app.models.transaction import Transaction
from app.services.decision_settings import DecisionSettings
from app.services.text_similarity import normalize_words

MAX_TRANSACTIONS = 50
MAX_CATEGORY_OPTIONS = 254  # 255 per Choice question, one is "none"
MAX_PAYEE_OPTIONS = 15
CONCURRENCY = 4
TIMEOUT_SECONDS = 30.0
NONE_OPTION = "None of these"

_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b")
_LONG_DIGITS = re.compile(r"\d[\d -]{7,}\d")


class DecisionUnavailable(Exception):
    """The remote engine is not selected or not configured."""


class DecisionUpstreamError(Exception):
    """The decision API refused or failed every request."""


def redact(text: Optional[str]) -> Optional[str]:
    """Mask IBANs and card/account-number-like digit runs."""
    if not text:
        return text
    return _LONG_DIGITS.sub("#", _IBAN.sub("[IBAN]", text))


def category_options(categories: list[Category]) -> dict[str, uuid.UUID]:
    """Option label -> category id, labels unique.

    The label is the category's own name: a decision head follows the
    option name more than its description, so an opaque key would cost
    accuracy.
    """
    options: dict[str, uuid.UUID] = {}
    for category in categories[:MAX_CATEGORY_OPTIONS]:
        label = category.name.strip() or "Unnamed"
        candidate, n = label, 2
        while candidate in options or candidate == NONE_OPTION:
            candidate, n = f"{label} ({n})", n + 1
        options[candidate] = category.id
    return options


def payee_shortlist(text: str, payees: list[Payee]) -> dict[str, uuid.UUID]:
    """The existing payees sharing a word with the transaction text."""
    words = {w for w in normalize_words(text) if len(w) >= 3}
    if not words:
        return {}
    scored = []
    for payee in payees:
        payee_words = {w for w in normalize_words(payee.name) if len(w) >= 3}
        shared = len(words & payee_words)
        if shared:
            scored.append((shared / len(payee_words), payee))
    scored.sort(key=lambda item: (-item[0], item[1].name))
    options: dict[str, uuid.UUID] = {}
    for _, payee in scored:
        if payee.name not in options and payee.name != NONE_OPTION:
            options[payee.name] = payee.id
        if len(options) >= MAX_PAYEE_OPTIONS:
            break
    return options


def transaction_state(tx: Transaction) -> dict[str, Any]:
    amount = abs(tx.amount)
    return {
        "description": redact(tx.description),
        "payee": redact(tx.payee) or None,
        "direction": "money out" if tx.type == "debit" else "money in",
        "amount": f"{amount:.2f}",
        "currency": tx.currency,
    }


def build_request(
    model: str,
    tx: Transaction,
    categories: dict[str, uuid.UUID],
    payees: dict[str, uuid.UUID],
) -> dict[str, Any]:
    questions: dict[str, Any] = {
        "category": {
            "type": "choice",
            "instructions": (
                "Which budgeting category does this bank transaction belong to? "
                f"Answer '{NONE_OPTION}' when no listed category clearly fits."
            ),
            "criteria": {
                **{label: None for label in categories},
                NONE_OPTION: "No listed category clearly fits this transaction.",
            },
        },
        "transfer": {
            "type": "noul",
            "instructions": (
                "Is this a movement between the account holder's own accounts, such as "
                "a transfer to savings or a credit card bill payment, rather than income or spending?"
            ),
        },
        "recurring": {
            "type": "noul",
            "instructions": (
                "Is this a recurring payment or income, such as a subscription, rent, "
                "salary, insurance or a utility bill?"
            ),
        },
    }
    if payees:
        questions["payee"] = {
            "type": "choice",
            "instructions": "Which of these merchants or counterparties is this transaction with?",
            "criteria": {
                **{label: None for label in payees},
                NONE_OPTION: "The transaction is with none of the listed counterparties.",
            },
        }
    return {"model": model, "state": transaction_state(tx), "questions": questions}


def _probability(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and 0.0 <= value <= 1.0 else None


def _choice(answer: object, options: dict[str, uuid.UUID]) -> tuple[Optional[uuid.UUID], Optional[str], Optional[float], Optional[float]]:
    """(id, label, probability, confidence) of a Choice answer, or Nones."""
    if not isinstance(answer, dict) or answer.get("type") != "choice":
        return None, None, None, None
    label = answer.get("choice")
    if not isinstance(label, str) or label not in options:
        # "None of these", or a label the model made up: no suggestion.
        return None, None, None, None
    probabilities = answer.get("probabilities")
    probability = _probability(probabilities.get(label)) if isinstance(probabilities, dict) else None
    confidence = _probability(answer.get("confidence"))
    return options[label], label, probability, confidence if confidence is not None else probability


def _noul(answer: object) -> Optional[float]:
    if not isinstance(answer, dict) or answer.get("type") != "noul":
        return None
    return _probability(answer.get("noul"))


def parse_answers(
    tx_id: uuid.UUID,
    body: object,
    categories: dict[str, uuid.UUID],
    payees: dict[str, uuid.UUID],
) -> dict[str, Any]:
    answers = body.get("answers") if isinstance(body, dict) else None
    if not isinstance(answers, dict):
        raise ValueError("Response has no answers")
    category_id, _, category_probability, category_confidence = _choice(answers.get("category"), categories)
    payee_id, payee_name, payee_probability, _ = _choice(answers.get("payee"), payees)
    return {
        "transaction_id": tx_id,
        "category_id": category_id,
        "category_probability": category_probability,
        "category_confidence": category_confidence,
        "payee_id": payee_id,
        "payee_name": payee_name,
        "payee_probability": payee_probability,
        "transfer_probability": _noul(answers.get("transfer")),
        "recurring_probability": _noul(answers.get("recurring")),
        "error": None,
    }


@dataclass
class _Context:
    categories: dict[str, uuid.UUID]
    payees: list[Payee]


async def _load_context(session: AsyncSession, workspace_id: uuid.UUID) -> _Context:
    categories = (
        await session.execute(
            select(Category)
            .where(Category.workspace_id == workspace_id, Category.is_hidden.is_(False))
            .order_by(Category.name)
        )
    ).scalars().all()
    payees = (
        await session.execute(select(Payee).where(Payee.workspace_id == workspace_id))
    ).scalars().all()
    return _Context(categories=category_options(list(categories)), payees=list(payees))


async def suggest(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    transaction_ids: list[uuid.UUID],
    settings: DecisionSettings,
    client: Optional[httpx.AsyncClient] = None,
) -> dict[str, Any]:
    if settings.engine != "remote" or not settings.remote_configured:
        raise DecisionUnavailable()
    ids = list(dict.fromkeys(transaction_ids))[:MAX_TRANSACTIONS]
    rows = (
        await session.execute(
            select(Transaction).where(
                Transaction.workspace_id == workspace_id, Transaction.id.in_(ids)
            )
        )
    ).scalars().all()
    by_id = {tx.id: tx for tx in rows}
    transactions = [by_id[i] for i in ids if i in by_id]
    if not transactions:
        return {"model": settings.remote_model, "suggestions": []}

    context = await _load_context(session, workspace_id)
    headers = {"Content-Type": "application/json"}
    if settings.api_key:
        headers["Authorization"] = f"Bearer {settings.api_key}"
    limiter = asyncio.Semaphore(CONCURRENCY)

    async def one(http: httpx.AsyncClient, tx: Transaction) -> dict[str, Any]:
        payees = payee_shortlist(f"{tx.payee or ''} {tx.description}", context.payees)
        body = build_request(settings.remote_model, tx, context.categories, payees)
        async with limiter:
            try:
                response = await http.post(settings.remote_url, json=body, headers=headers)
                response.raise_for_status()
                return parse_answers(tx.id, response.json(), context.categories, payees)
            except (httpx.HTTPError, ValueError) as exc:
                status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
                return {"transaction_id": tx.id, "error": f"upstream_{status}" if status else "upstream_failed"}

    owned = client is None
    http = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False)
    try:
        results = await asyncio.gather(*(one(http, tx) for tx in transactions))
    finally:
        if owned:
            await http.aclose()

    if all(result.get("error") for result in results):
        raise DecisionUpstreamError(results[0]["error"])
    return {"model": settings.remote_model, "suggestions": results}
