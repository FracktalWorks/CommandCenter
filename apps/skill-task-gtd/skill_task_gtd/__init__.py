"""skill-task-gtd — provider-agnostic GTD tools over the gateway /tasks API."""

from skill_task_gtd.core import (
    gtd_accounts,
    gtd_capture,
    gtd_capture_many,
    gtd_clarify,
    gtd_inbox_insights,
    gtd_list,
    gtd_list_projects,
    gtd_organize,
    gtd_people,
    gtd_update,
)

__all__ = [
    "gtd_accounts",
    "gtd_capture",
    "gtd_capture_many",
    "gtd_clarify",
    "gtd_inbox_insights",
    "gtd_list",
    "gtd_list_projects",
    "gtd_organize",
    "gtd_people",
    "gtd_update",
]
