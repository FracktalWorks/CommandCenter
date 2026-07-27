"""Notes route package — the gateway `/notes` API (AI Note Taker).

Same layout as ``routes/tasks``: ``core`` is the leaf; the feature modules
register their routes on the shared ``router`` as an import side effect.
Spec: ai-company-brain/specs/note_taker_app.md §3.7.
"""

from gateway.routes.notes import actions as _actions  # noqa: F401
from gateway.routes.notes import copilot as _copilot  # noqa: F401
from gateway.routes.notes import copilot_context as _copilot_context  # noqa: F401
from gateway.routes.notes import events as _events  # noqa: F401
from gateway.routes.notes import glossary as _glossary  # noqa: F401
from gateway.routes.notes import live as _live  # noqa: F401
from gateway.routes.notes import live_session as _live_session  # noqa: F401
from gateway.routes.notes import live_transcript as _live_transcript  # noqa: F401
from gateway.routes.notes import meeting_bot as _meeting_bot  # noqa: F401
from gateway.routes.notes import meetings as _meetings  # noqa: F401
from gateway.routes.notes import qa as _qa  # noqa: F401
from gateway.routes.notes import recordings as _recordings  # noqa: F401
from gateway.routes.notes import share as _share  # noqa: F401
from gateway.routes.notes import speaker_id as _speaker_id  # noqa: F401
from gateway.routes.notes import summaries as _summaries  # noqa: F401
from gateway.routes.notes.core import router

__all__ = ["router"]
