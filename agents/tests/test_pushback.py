import unittest

from desk_agents.pushback import by_keywords


class Keywords(unittest.TestCase):
    def test_payment_claim(self):
        r = by_keywords("Don't freeze Kestrel, wire sent yesterday for $148,200, IMAD 20260302MMQFMP2K009911")
        self.assertEqual(r.intent, "already_paid")
        self.assertEqual(r.claimed_amount_usd, 148_200.0)
        self.assertEqual(r.payment_reference, "20260302MMQFMP2K009911")

    def test_exception_request(self):
        r = by_keywords("Please hold off on Cobalt until 2026-03-20, the acquisition closes then")
        self.assertEqual((r.intent, r.grace_until), ("exception_request", "2026-03-20"))

    def test_other(self):
        self.assertEqual(by_keywords("FYI their CFO changed last week.").intent, "other")


if __name__ == "__main__":
    unittest.main()
