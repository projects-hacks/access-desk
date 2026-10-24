import unittest

from desk_agents.pushback import by_keywords


class Keywords(unittest.TestCase):
    def test_payment_claim(self):
        r = by_keywords("Don't freeze Kestrel, wire sent yesterday for $148,200, IMAD 20260302MMQFMP2K009911")
        self.assertEqual(r.intent, "already_paid")
        self.assertEqual(r.claimed_amount_usd, 148_200.0)
        self.assertEqual(r.payment_reference, "20260302MMQFMP2K009911")

    def test_exception_request(self):
        r = by_keywords("Please hold off on Juniper until 2026-03-20, their new CFO is sorting out payables")
        self.assertEqual((r.intent, r.grace_until), ("exception_request", "2026-03-20"))

    def test_acquisition_outranks_hold_off(self):
        r = by_keywords("Cobalt is being acquired by Meridian Holdings, closing 2026-04-15. Please hold off until then.")
        self.assertEqual(
            (r.intent, r.event_type, r.counterparty, r.effective_date, r.grace_until),
            ("material_event", "acquisition", "Meridian Holdings", "2026-04-15", None),
        )

    def test_other(self):
        self.assertEqual(by_keywords("FYI their CFO changed last week.").intent, "other")


if __name__ == "__main__":
    unittest.main()
