"""Transaction suggestions from a decision model.

``GET /config`` tells the client which engine the administrator chose. The
browser engine runs entirely in the client; only the remote engine comes
back here, because its API key must stay on the server.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_active_user
from app.core.database import get_async_session
from app.core.workspace_context import WorkspaceContext, current_writable_workspace
from app.models.user import User
from app.schemas.decision import (
    DecisionConfigRead,
    DecisionSuggestRequest,
    DecisionSuggestResponse,
)
from app.services import decision_service
from app.services.decision_settings import load_settings

router = APIRouter(prefix="/api/decisions", tags=["decisions"])


@router.get("/config", response_model=DecisionConfigRead)
async def decision_config(
    session: AsyncSession = Depends(get_async_session),
    _user: User = Depends(current_active_user),
):
    settings = await load_settings(session)
    if settings.engine == "remote" and not settings.remote_configured:
        return DecisionConfigRead(engine="off")
    return DecisionConfigRead(
        engine=settings.engine,
        browser_model=settings.browser_model if settings.engine == "browser" else None,
        remote_model=settings.remote_model if settings.engine == "remote" else None,
    )


# Writers only: suggestions exist to be applied, and the remote engine sends
# transaction text to a third party on the workspace's behalf.
@router.post("/suggest", response_model=DecisionSuggestResponse)
async def suggest(
    data: DecisionSuggestRequest,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    settings = await load_settings(session)
    try:
        return await decision_service.suggest(
            session, ctx.workspace.id, data.transaction_ids, settings
        )
    except decision_service.DecisionUnavailable:
        raise HTTPException(status_code=409, detail="The remote decision engine is not enabled") from None
    except decision_service.DecisionUpstreamError as exc:
        raise HTTPException(status_code=502, detail=f"Decision API failed: {exc}") from None
