"""Which engine suggests transaction categories, and how to reach a remote one.

Instance-wide and administrator-managed, stored in ``app_settings``:

- ``off``: no suggestions.
- ``browser``: each user's browser runs a small embedding model (WebGPU, or
  WebAssembly as a fallback) and votes from that user's own categorized
  history. Transactions never leave the browser; only the model weights are
  downloaded, by name, from the model hub.
- ``remote``: the backend asks a decision-model API that speaks TypeSafe's
  ``/v1/systemone`` wire format. That covers TypeSafe Jev, OpenRouter's
  decisions route, Clef, and a self-hosted Ollaya server running open
  models such as Kev or Laya on the user's own hardware.

The API key is encrypted with the same helper as the provider credentials
and is never returned; reads only say whether one is saved.
"""

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.services.crypto import decrypt, encrypt
from app.models.app_settings import AppSetting
from app.services.provider_settings import SecretStorageUnavailable, can_store_secrets

ENGINES = ("off", "browser", "remote")

ENGINE_KEY = "decision_engine"
REMOTE_URL_KEY = "decision_remote_url"
REMOTE_MODEL_KEY = "decision_remote_model"
REMOTE_API_KEY_KEY = "decision_remote_api_key"
BROWSER_MODEL_KEY = "decision_browser_model"

SETTING_KEYS = {
    ENGINE_KEY,
    REMOTE_URL_KEY,
    REMOTE_MODEL_KEY,
    REMOTE_API_KEY_KEY,
    BROWSER_MODEL_KEY,
}
#: Keys the generic ``/api/admin/settings/{key}`` route must never return.
HIDDEN_KEYS = {REMOTE_API_KEY_KEY}

#: Multilingual, small (about 120 MB quantized) and the same model the
#: backend's agents use for embeddings by default.
DEFAULT_BROWSER_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2"

# Request fields of PATCH /api/admin/decision-model, mapped to storage keys.
FIELDS = {
    "engine": ENGINE_KEY,
    "remote_url": REMOTE_URL_KEY,
    "remote_model": REMOTE_MODEL_KEY,
    "api_key": REMOTE_API_KEY_KEY,
    "browser_model": BROWSER_MODEL_KEY,
}

_MODEL_HUB_ID = re.compile(r"^[A-Za-z0-9][\w.-]{0,95}/[\w.-]{1,96}$")


@dataclass(frozen=True)
class DecisionSettings:
    engine: str
    remote_url: str
    remote_model: str
    api_key: str
    api_key_stored: bool
    browser_model: str

    @property
    def remote_configured(self) -> bool:
        return bool(self.remote_url and self.remote_model)


async def load_settings(session: AsyncSession) -> DecisionSettings:
    rows = await session.execute(
        select(AppSetting.key, AppSetting.value).where(AppSetting.key.in_(SETTING_KEYS))
    )
    stored = {key: value for key, value in rows.all()}
    engine = stored.get(ENGINE_KEY, "off")
    return DecisionSettings(
        engine=engine if engine in ENGINES else "off",
        remote_url=stored.get(REMOTE_URL_KEY, ""),
        remote_model=stored.get(REMOTE_MODEL_KEY, ""),
        # A key that no longer decrypts (SECRET_KEY rotated) counts as absent
        # rather than being sent as ciphertext.
        api_key=decrypt(stored.get(REMOTE_API_KEY_KEY)) or "",
        api_key_stored=REMOTE_API_KEY_KEY in stored,
        browser_model=stored.get(BROWSER_MODEL_KEY) or DEFAULT_BROWSER_MODEL,
    )


def admin_view(settings: DecisionSettings) -> dict:
    return {
        "engine": settings.engine,
        "remote_url": settings.remote_url,
        "remote_model": settings.remote_model,
        "api_key_configured": bool(settings.api_key),
        # Stored but unreadable: the admin has to enter it again.
        "api_key_invalid": settings.api_key_stored and not settings.api_key,
        "browser_model": settings.browser_model,
        "default_browser_model": DEFAULT_BROWSER_MODEL,
        "can_store_secrets": can_store_secrets(),
    }


def _validate_url(value: str) -> str:
    value = value.strip()
    if len(value) > 500:
        raise ValueError("URL too long")
    parts = urlsplit(value)
    # Plain http stays allowed for a decision server on the local network.
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("URL must be http(s)")
    if parts.username or parts.password:
        raise ValueError("Put credentials in the API key, not the URL")
    return value


def _validate(field: str, value: object) -> str | None:
    if value is None:
        if field == "engine":
            raise ValueError("Engine cannot be cleared")
        return None
    if not isinstance(value, str):
        raise ValueError("Values must be strings")
    if field == "engine":
        if value not in ENGINES:
            raise ValueError("Unknown engine")
        return value
    if field == "remote_url":
        return _validate_url(value)
    stripped = value.strip()
    if not stripped:
        raise ValueError("Values cannot be empty; send null to clear")
    if field == "remote_model":
        if len(stripped) > 200:
            raise ValueError("Model name too long")
        return stripped
    if field == "browser_model":
        if not _MODEL_HUB_ID.match(stripped):
            raise ValueError("Browser model must be a model hub id like owner/name")
        return stripped
    if field == "api_key":
        if len(stripped) > 4000:
            raise ValueError("API key too long")
        return stripped
    raise ValueError("Unknown field")


async def update_settings(session: AsyncSession, values: dict) -> DecisionSettings:
    if not values or set(values) - set(FIELDS):
        raise ValueError("Unknown decision model field")
    # Validate the whole patch before writing anything. Never echo input.
    cleaned = {field: _validate(field, value) for field, value in values.items()}
    if cleaned.get("api_key") is not None and not can_store_secrets():
        raise SecretStorageUnavailable(
            "Set a unique SECRET_KEY of at least 32 characters before saving credentials"
        )

    current = await load_settings(session)
    engine = cleaned.get("engine", current.engine)
    url = cleaned["remote_url"] if "remote_url" in cleaned else current.remote_url
    model = cleaned["remote_model"] if "remote_model" in cleaned else current.remote_model
    if engine == "remote" and not (url and model):
        raise ValueError("The remote engine needs a URL and a model")

    for field, value in cleaned.items():
        key = FIELDS[field]
        row = await session.get(AppSetting, key)
        if value is None:
            if row is not None:
                await session.delete(row)
            continue
        stored = encrypt(value) if field == "api_key" else value
        if stored is None:
            raise ValueError("Value cannot be empty")
        if row is None:
            session.add(AppSetting(key=key, value=stored))
        else:
            row.value = stored
    await session.commit()
    return await load_settings(session)
