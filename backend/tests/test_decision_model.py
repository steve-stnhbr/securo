import json
import secrets

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import get_settings
from app.models.app_settings import AppSetting
from app.models.payee import Payee
from app.services import decision_service
from app.services.decision_settings import (
    DEFAULT_BROWSER_MODEL,
    REMOTE_API_KEY_KEY,
    load_settings,
    update_settings,
)


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
    from app.agents.services.crypto import _fernet

    monkeypatch.setattr(get_settings(), "secret_key", SecretStr(secrets.token_hex(32)))
    _fernet.cache_clear()
    yield
    _fernet.cache_clear()


def test_redact_masks_ibans_and_long_numbers():
    text = "SEPA AT61 1904 3002 3457 3201 card 4111 1111 1111 1111 REWE 0815"
    redacted = decision_service.redact(text)
    assert "AT61" not in redacted and "4111" not in redacted
    assert "[IBAN]" in redacted and "REWE 0815" in redacted


def test_category_options_keep_names_and_make_them_unique():
    class Cat:
        def __init__(self, name):
            import uuid

            self.id, self.name = uuid.uuid4(), name

    cats = [Cat("Food"), Cat("Food"), Cat("None of these")]
    options = decision_service.category_options(cats)
    assert list(options) == ["Food", "Food (2)", "None of these (2)"]


@pytest.mark.asyncio
async def test_settings_default_off_and_remote_needs_url_and_model(session, clean_db):
    settings = await load_settings(session)
    assert settings.engine == "off"
    assert settings.browser_model == DEFAULT_BROWSER_MODEL
    with pytest.raises(ValueError):
        await update_settings(session, {"engine": "remote"})
    with pytest.raises(ValueError):
        await update_settings(session, {"remote_url": "ftp://example.com"})
    with pytest.raises(ValueError):
        await update_settings(session, {"remote_url": "https://user:pw@example.com/v1/systemone"})
    with pytest.raises(ValueError):
        await update_settings(session, {"browser_model": "not a model id"})
    saved = await update_settings(
        session,
        {
            "engine": "remote",
            "remote_url": "http://ollaya.local:11435/v1/systemone",
            "remote_model": "kev:0.8b",
            "api_key": "sk-test",
        },
    )
    assert saved.engine == "remote" and saved.api_key == "sk-test"
    stored = await session.get(AppSetting, REMOTE_API_KEY_KEY)
    assert stored is not None and "sk-test" not in stored.value


@pytest.mark.asyncio
async def test_admin_routes_never_return_the_key(client, admin_auth_headers, session):
    response = await client.patch(
        "/api/admin/decision-model",
        headers=admin_auth_headers,
        json={
            "engine": "remote",
            "remote_url": "https://api.typesafe.ai/v1/systemone",
            "remote_model": "jev-1.13.0",
            "api_key": "sk-secret-value",
        },
    )
    assert response.status_code == 200, response.text
    assert "sk-secret-value" not in response.text
    assert response.json()["api_key_configured"] is True

    bad = await client.patch(
        "/api/admin/decision-model", headers=admin_auth_headers,
        json={"api_key": "sk-secret-value", "engine": "nope"},
    )
    assert bad.status_code == 400 and "sk-secret-value" not in bad.text

    raw = await client.get(f"/api/admin/settings/{REMOTE_API_KEY_KEY}", headers=admin_auth_headers)
    assert raw.status_code == 404


@pytest.mark.asyncio
async def test_config_and_suggest_when_off(client, auth_headers, test_transactions):
    config = await client.get("/api/decisions/config", headers=auth_headers)
    assert config.json() == {"engine": "off", "browser_model": None, "remote_model": None}
    response = await client.post(
        "/api/decisions/suggest", headers=auth_headers,
        json={"transaction_ids": [str(test_transactions[4].id)]},
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_browser_engine_config_names_the_model(client, auth_headers, session, clean_db, test_user):
    await update_settings(session, {"engine": "browser"})
    config = await client.get("/api/decisions/config", headers=auth_headers)
    assert config.json()["engine"] == "browser"
    assert config.json()["browser_model"] == DEFAULT_BROWSER_MODEL


@pytest.mark.asyncio
async def test_remote_suggest_maps_answers(session, test_transactions, test_categories):
    netflix = test_transactions[4]
    netflix.description = "NETFLIX.COM AT61 1904 3002 3457 3201"
    session.add(Payee(workspace_id=netflix.workspace_id, user_id=netflix.user_id, name="Netflix"))
    await session.commit()
    settings = await update_settings(
        session,
        {
            "engine": "remote",
            "remote_url": "https://decisions.example/v1/systemone",
            "remote_model": "jev-1.13.0",
            "api_key": "sk-test",
        },
    )
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append((request, body))
        assert set(body["questions"]) == {"category", "payee", "transfer", "recurring"}
        return httpx.Response(200, json={
            "model": "jev-1.13.0",
            "answers": {
                "category": {"type": "choice", "choice": "Transporte", "confidence": 0.7,
                             "probabilities": {"Transporte": 0.8, "None of these": 0.2}},
                "payee": {"type": "choice", "choice": "Netflix", "confidence": 0.9,
                          "probabilities": {"Netflix": 0.95, "None of these": 0.05}},
                "transfer": {"type": "noul", "noul": 0.02},
                "recurring": {"type": "noul", "noul": 0.97},
            },
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await decision_service.suggest(
            session, netflix.workspace_id, [netflix.id], settings, client=http
        )

    request, body = seen[0]
    assert request.headers["Authorization"] == "Bearer sk-test"
    assert "AT61" not in json.dumps(body)
    assert body["state"]["direction"] == "money out"
    [suggestion] = result["suggestions"]
    assert suggestion["category_id"] == test_categories[1].id
    assert suggestion["category_probability"] == 0.8
    assert suggestion["category_confidence"] == 0.7
    assert suggestion["payee_name"] == "Netflix"
    assert suggestion["recurring_probability"] == 0.97


@pytest.mark.asyncio
async def test_remote_suggest_none_option_and_upstream_failure(session, test_transactions):
    tx = test_transactions[3]
    settings = await update_settings(
        session,
        {"engine": "remote", "remote_url": "https://decisions.example/v1/systemone", "remote_model": "clef"},
    )

    def none_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"answers": {
            "category": {"type": "choice", "choice": "None of these", "probabilities": {"None of these": 1.0}},
            "transfer": {"type": "noul", "noul": 1.5},
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(none_handler)) as http:
        result = await decision_service.suggest(session, tx.workspace_id, [tx.id], settings, client=http)
    [suggestion] = result["suggestions"]
    assert suggestion["category_id"] is None
    assert suggestion["transfer_probability"] is None  # out of range is dropped

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(401))) as http:
        with pytest.raises(decision_service.DecisionUpstreamError, match="upstream_401"):
            await decision_service.suggest(session, tx.workspace_id, [tx.id], settings, client=http)
