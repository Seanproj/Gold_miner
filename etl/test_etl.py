import unittest
from datetime import date

import gold_miner_etl as etl


class ParseTests(unittest.TestCase):
    def test_fred_skips_missing(self):
        s = etl.parse_fred_csv("observation_date,DFII10\n2024-01-02,1.7\n2024-01-03,.\n2024-01-04,-0.1\n")
        self.assertEqual(s, {date(2024, 1, 2): 1.7, date(2024, 1, 4): -0.1})

    def test_ohlc_close(self):
        s = etl.parse_ohlc_csv("Date,Open,High,Low,Close\n2024-01-02,2060,2070,2050,2064.5\nbad,1,1,1,x\n")
        self.assertEqual(s, {date(2024, 1, 2): 2064.5})

    def test_yahoo_chart(self):
        txt = '{"chart":{"result":[{"meta":{"gmtoffset":-18000},"timestamp":[1704207600,1704294000],"indicators":{"quote":[{"close":[2064.4,null]}]}}]}}'
        self.assertEqual(etl.parse_yahoo_chart(txt), {date(2024, 1, 2): 2064.4})

    def test_ohlc_rejects_rate_limit_page(self):
        with self.assertRaises(ValueError):
            etl.parse_ohlc_csv("Exceeded the daily hits limit")


class NaverTests(unittest.TestCase):
    def test_parse_prices(self):
        txt = '{"isSuccess":true,"result":[{"localTradedAt":"2026-11-27T00:00:00+09:00","closePrice":"157,350"},{"localTradedAt":"2026-11-26","closePrice":"1,344.00"}]}'
        self.assertEqual(etl.parse_naver_prices(txt), {date(2026, 11, 27): 157350.0, date(2026, 11, 26): 1344.0})

    def test_parse_error(self):
        with self.assertRaises(ValueError):
            etl.parse_naver_prices('{"result":"pageSize: must be less than or equal to 60"}')

    def test_premium_uses_previous_us_close(self):
        krx = {date(2024, 1, 3): 102000.0}
        gold = {date(2024, 1, 2): 3110.35, date(2024, 1, 3): 9999.0}  # same-day US close is not yet known
        fx = {date(2024, 1, 3): 1000.0}
        self.assertAlmostEqual(etl.premium_series(krx, gold, fx)[date(2024, 1, 3)], 2.0, places=6)


class QualityTests(unittest.TestCase):
    def test_flags_jumps_and_drops_nonpositive(self):
        s = {date(2024, 1, 1): 100, date(2024, 1, 2): 0, date(2024, 1, 3): 110, date(2024, 1, 10): 111}
        clean, rep = etl.check_quality("X", s, jump_pct=8, today=date(2024, 1, 12))
        self.assertEqual(rep.dropped, 1)
        self.assertEqual(rep.jumps, [("2024-01-03", 10.0)])
        self.assertEqual(rep.max_gap_days, 7)
        self.assertEqual(rep.stale_days, 2)
        self.assertTrue(rep.ok())

    def test_negative_allowed_for_rates(self):
        clean, rep = etl.check_quality("DFII10", {date(2021, 1, 1): -1.0}, positive=False)
        self.assertEqual(clean, {date(2021, 1, 1): -1.0})


class DeriveTests(unittest.TestCase):
    def test_krw_per_gram(self):
        self.assertAlmostEqual(etl.krw_per_gram(3110.35, 1000), 100000, places=6)

    def test_premium(self):
        self.assertAlmostEqual(etl.domestic_premium(102000, 3110.35, 1000), 2.0, places=6)

    def test_align_never_looks_ahead(self):
        base = {date(2024, 1, 1): 1, date(2024, 1, 3): 1, date(2024, 1, 5): 1}
        other = {date(2024, 1, 2): 10, date(2024, 1, 5): 20}
        self.assertEqual(etl.align(base, other), {date(2024, 1, 3): 10, date(2024, 1, 5): 20})

    def test_week_end_keeps_last_obs(self):
        s = {date(2024, 1, 1): 1, date(2024, 1, 5): 2, date(2024, 1, 8): 3}
        self.assertEqual(etl.week_end(s), {date(2024, 1, 5): 2, date(2024, 1, 8): 3})

    def test_pct_change(self):
        s = {date(2024, 1, 1): 100, date(2024, 2, 1): 110}
        self.assertAlmostEqual(etl.pct_change(s, 30), 10.0)


if __name__ == "__main__":
    unittest.main()
