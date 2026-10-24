import json
from typing import Any

import httpx

from .decode import decode_rows
from .models import Proposal


class SpacetimeClient:
    """
    Minimal SpacetimeDB HTTP client. Agents read with SQL and write only by
    calling reducers; they never touch systems of record directly.
    """

    def __init__(self, base_url: str, database: str, token: str | None = None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        self._db = database
        self._http = httpx.Client(base_url=base_url, headers=headers, timeout=10)

    def sql(self, query: str) -> list[dict[str, Any]]:
        res = self._http.post(f"/v1/database/{self._db}/sql", content=query)
        _raise_for_status(res)
        return decode_rows(res.json()[0])

    def call(self, reducer: str, *args: Any) -> None:
        # Reducer names are snake_case on the wire (proposeWorkItem -> propose_work_item).
        res = self._http.post(f"/v1/database/{self._db}/call/{reducer}", json=list(args))
        _raise_for_status(res)

    def propose(self, p: Proposal) -> None:
        self.call(
            "propose_work_item",
            p.kind.value,
            p.client_id,
            p.subject_id,
            p.title,
            p.amount_cents,
            json.dumps(p.proposal),
            p.reasoning,
            p.policy_ref,
            p.clauses_cited,
            json.dumps(p.boundaries),
            p.confidence,
            p.required_role.value,
        )

    def close(self) -> None:
        self._http.close()


class ReducerError(Exception):
    """A reducer refused the call (bad role, bad state). Nothing was written."""


def _raise_for_status(res: httpx.Response) -> None:
    if res.status_code == 530:
        raise ReducerError(res.text)
    res.raise_for_status()
