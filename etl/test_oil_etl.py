import math
import unittest
from datetime import date, timedelta

import oil_miner_etl as oil


EIA_HTML = """<table>
<tr> <td class='B6'>&nbsp;&nbsp;2025-Dec</td> <td class='B5'>12/05&nbsp;</td> <td class='B3'>424,000&nbsp;&nbsp;</td>
 <td class='B5'>12/26&nbsp;</td> <td class='B3'>420,500&nbsp;&nbsp;</td> <td class='B5'>&nbsp;</td> <td class='B3'>&nbsp;&nbsp;</td></tr>
<tr> <td class='B6'>&nbsp;&nbsp;2026-Jan</td> <td class='B5'>01/02&nbsp;</td> <td class='B3'>419,100&nbsp;&nbsp;</td>
 <td class='B5'>01/09&nbsp;</td> <td class='B3'>95.2&nbsp;&nbsp;</td></tr>
</table>"""


class ParseTests(unittest.TestCase):
    def test_eia_leaf_rows(self):
        s = oil.parse_eia_leaf(EIA_HTML)
        self.assertEqual(s[date(2025, 12, 5)], 424000.0)
        self.assertEqual(s[date(2026, 1, 2)], 419100.0)
        self.assertEqual(s[date(2026, 1, 9)], 95.2)
        self.assertEqual(len(s), 4)

    def test_eia_empty_raises(self):
        with self.assertRaises(ValueError):
            oil.parse_eia_leaf("<html>maintenance</html>")

    def test_cot_picks_wti_contract(self):
        head = ("Market and Exchange Names,As of Date in Form YYMMDD,As of Date in Form YYYY-MM-DD,CFTC Contract Market Code,"
                "CFTC Market Code in Initials,CFTC Region Code,CFTC Commodity Code,Open Interest (All),"
                "Noncommercial Positions-Long (All),Noncommercial Positions-Short (All)\n")
        rows = ('"WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE",251230,2025-12-30,067651,NYME,01,067 , 1000,  300,  100\n'
                '"BRENT LAST DAY - NEW YORK MERCANTILE EXCHANGE",251230,2025-12-30,06765T,NYME,01,067 , 50,  10,  5\n')
        self.assertEqual(oil.parse_cot_csv(head + rows), {date(2025, 12, 30): (1000.0, 200.0)})

    def test_naver_stock(self):
        txt = '[{"localTradedAt":"2026-11-27","closePrice":"25,825"},{"localTradedAt":"2026-11-26","closePrice":"25,230"}]'
        self.assertEqual(oil.parse_naver_stock(txt), {date(2026, 11, 27): 25825.0, date(2026, 11, 26): 25230.0})
        with self.assertRaises(ValueError):
            oil.parse_naver_stock('{"code":"error"}')


class DeriveTests(unittest.TestCase):
    def test_splice_uses_futures_only_after_spot_ends(self):
        spot = {date(2026, 11, 20): 80.0, date(2026, 11, 24): 82.0}
        fut = {date(2026, 11, 24): 99.0, date(2026, 11, 25): 83.0, date(2026, 11, 27): 84.0}
        s, start = oil.splice(spot, fut)
        self.assertEqual(s[date(2026, 11, 24)], 82.0)  # spot wins where both exist
        self.assertEqual(s[date(2026, 11, 27)], 84.0)
        self.assertEqual(start, date(2026, 11, 25))

    def test_crack_321(self):
        d = date(2026, 1, 2)
        # 2 × 2.40 × 42 + 1 × 2.70 × 42 − 3 × 80 = 201.6 + 113.4 − 240 = 75 → ÷3 = 25
        self.assertAlmostEqual(oil.crack_321({d: 80.0}, {d: 2.40}, {d: 2.70})[d], 25.0)

    def test_seasonal_stats_uses_only_past_years(self):
        s = {}
        for y in range(2015, 2027):
            for k in range(52):
                d = date(y, 1, 2) + timedelta(days=7 * k)
                s[d] = 100.0 + (y - 2015)  # level rises by 1 each year
        st = oil.seasonal_stats(s)
        last = max(st)
        self.assertEqual(last.year, 2026)
        # previous 5 years: 106..110 → mean 108; this year 111
        self.assertAlmostEqual(st[last]["avg"], 108.0)
        self.assertEqual((st[last]["min"], st[last]["max"]), (106.0, 110.0))
        self.assertAlmostEqual(st[last]["dev"], (111 / 108 - 1) * 100)
        self.assertNotIn(date(2016, 1, 2), st)  # needs 5 full prior years

    def test_realized_roll_is_log_gap(self):
        d0, d1 = date(2025, 1, 2), date(2026, 1, 2)
        fut = {d0: 10.0, d1: 20.0}
        spot = {d0: 50.0, d1: 50.0}
        rr = oil.realized_roll(fut, spot)
        self.assertAlmostEqual(rr[d1], math.log(2) * 100)
        self.assertNotIn(d0, rr)

    def test_contract_months_roll_year(self):
        m = oil.contract_months(date(2026, 11, 28), 3)
        self.assertEqual(m, [("2026-11", "CLX26.NYM"), ("2026-12", "CLZ26.NYM"), ("2027-01", "CLF27.NYM")])

    def test_percentile(self):
        self.assertEqual(oil.percentile_of([1, 2, 3, 4], 3), 50.0)


if __name__ == "__main__":
    unittest.main()
