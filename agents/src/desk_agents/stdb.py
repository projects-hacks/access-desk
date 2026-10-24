import json
from typing import Any

import httpx

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
        res.raise_for_status()
        # Response: [{schema: {elements: [{name: {some: col}}...]}, rows: [[...], ...]}]
        result = res.json()[0]
        cols = [e["name"]["some"] for e in result["schema"]["elements"]]
        return [dict(zip(cols, row)) for row in result["rows"]]

    def call(self, reducer: str, *args: Any) -> None:
        # Reducer names are snake_case on the wire (proposeWorkItem -> propose_work_item).
        res = self._http.post(f"/v1/database/{self._db}/call/{reducer}", json=list(args))
        res.raise_for_status()

    def propose(self, p: Proposal) -> None:
        self.call(
            "propose_work_item",
            p.kind.value,
            p.client_id,
            p.summary,
            json.dumps(p.detail),
            p.policy_version,
        )

    def close(self) -> None:
        self._http.close()
