import uuid
from typing import Literal, Optional

from pydantic import BaseModel, Field


class DecisionModelSettingsRead(BaseModel):
    engine: Literal["off", "browser", "remote"]
    remote_url: str
    remote_model: str
    api_key_configured: bool
    api_key_invalid: bool
    browser_model: str
    default_browser_model: str
    can_store_secrets: bool


class DecisionConfigRead(BaseModel):
    """What every member's client needs to pick an engine. No secrets, no URL."""

    engine: Literal["off", "browser", "remote"]
    browser_model: Optional[str] = None
    remote_model: Optional[str] = None


class DecisionSuggestRequest(BaseModel):
    transaction_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class DecisionSuggestion(BaseModel):
    transaction_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    category_probability: Optional[float] = None
    category_confidence: Optional[float] = None
    payee_id: Optional[uuid.UUID] = None
    payee_name: Optional[str] = None
    payee_probability: Optional[float] = None
    transfer_probability: Optional[float] = None
    recurring_probability: Optional[float] = None
    # Set instead of the answers when this one request failed upstream.
    error: Optional[str] = None


class DecisionSuggestResponse(BaseModel):
    model: str
    suggestions: list[DecisionSuggestion]
