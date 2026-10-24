from enum import StrEnum

from pydantic import BaseModel


class WorkItemKind(StrEnum):
    PAYMENT_MATCH = "PAYMENT_MATCH"
    RESTRICTION = "RESTRICTION"
    RESTORE = "RESTORE"
    CREDIT_REVIEW = "CREDIT_REVIEW"
    POLICY_DRAFT = "POLICY_DRAFT"


class Proposal(BaseModel):
    """What an agent asks the system of work to do. Humans approve; the gateway executes."""

    kind: WorkItemKind
    client_id: str
    summary: str
    detail: dict
    policy_version: str
