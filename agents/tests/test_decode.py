import unittest
from datetime import UTC, datetime

from desk_agents.decode import decode_rows

OPTION_STR = {
    "Sum": {
        "variants": [
            {"name": {"some": "some"}, "algebraic_type": {"String": []}},
            {"name": {"some": "none"}, "algebraic_type": {"Product": {"elements": []}}},
        ]
    }
}
TIMESTAMP = {
    "Product": {
        "elements": [
            {
                "name": {"some": "__timestamp_micros_since_unix_epoch__"},
                "algebraic_type": {"I64": []},
            },
        ]
    }
}
IDENTITY = {
    "Product": {"elements": [{"name": {"some": "__identity__"}, "algebraic_type": {"U256": []}}]}
}


def col(name, t):
    return {"name": {"some": name}, "algebraic_type": t}


class DecodeTest(unittest.TestCase):
    def test_decodes_options_timestamps_identities_arrays(self):
        result = {
            "schema": {
                "elements": [
                    col("renewal_on", OPTION_STR),
                    col("created_at", TIMESTAMP),
                    col("proposed_by", IDENTITY),
                    col("refs", {"Array": {"String": []}}),
                    col("tier", {"U8": []}),
                ]
            },
            "rows": [
                [[0, "2026-03-12"], [1792835819041579], ["0xc200"], ["INV-1", "INV-2"], 3],
                [[1, []], [0], ["0xabc"], [], 1],
            ],
        }
        a, b = decode_rows(result)
        self.assertEqual(a["renewal_on"], "2026-03-12")
        self.assertIsNone(b["renewal_on"])
        self.assertEqual(a["created_at"], datetime.fromtimestamp(1792835819.041579, tz=UTC))
        self.assertEqual(a["proposed_by"], "0xc200")
        self.assertEqual(a["refs"], ["INV-1", "INV-2"])
        self.assertEqual(b["tier"], 1)


if __name__ == "__main__":
    unittest.main()
