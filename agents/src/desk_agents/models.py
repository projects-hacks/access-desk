from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class WorkItemKind(StrEnum):
    PAYMENT_MATCH = "PAYMENT_MATCH"
    RESTRICTION = "RESTRICTION"
    RESTORE = "RESTORE"
    CUSTODY_DEBIT = "CUSTODY_DEBIT"
    REMINDER = "REMINDER"
    REFUND = "REFUND"
    CREDIT_REVIEW = "CREDIT_REVIEW"
    NOVEL_CASE = "NOVEL_CASE"
    EXPLOIT_FLAG = "EXPLOIT_FLAG"
    POLICY_DRAFT = "POLICY_DRAFT"
    # Raised by the system itself, never proposed by agents.
    PAYMENT_REVERSAL = "PAYMENT_REVERSAL"
    UNIDENTIFIED_CASH = "UNIDENTIFIED_CASH"
    BOOKS_BREAK = "BOOKS_BREAK"
    SYSTEM_EXCEPTION = "SYSTEM_EXCEPTION"


class Role(StrEnum):
    ACCOUNTANT = "ACCOUNTANT"
    CONTROLLER = "CONTROLLER"
    RELATIONSHIP_MANAGER = "RELATIONSHIP_MANAGER"


class Proposal(BaseModel):
    """What an agent asks the system of work to do. People approve; the gateway executes."""

    kind: WorkItemKind
    client_id: str
    subject_id: str
    title: str
    amount_cents: int = Field(ge=0)
    proposal: dict[str, Any]
    reasoning: str
    policy_ref: str
    clauses_cited: list[str] = []
    boundaries: list[dict[str, Any]] = []
    confidence: float = Field(ge=0, le=1)
    required_role: Role = Role.CONTROLLER
