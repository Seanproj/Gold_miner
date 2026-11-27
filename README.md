# Gold Miner — 금거래소 매입·매도 타이밍 인텔리전스

금 가격 측정과 과거 데이터 기반 미래 분석으로 금거래소의 매입·매도 판단을 돕는 대시보드입니다.

## 바로 보기
- `site/dist/gold_miner.html` — 데이터가 들어 있는 단일 파일. 브라우저로 열면 됩니다.
- `site/index.html` — 개발용 (`site/data/gm_data.js`를 읽음)

## 데이터 갱신 (Phase 1 ETL)
```bash
python etl/gold_miner_etl.py        # 수집 → 품질 검사 → data/clean, site/data/gm_data.js 생성
python etl/build_standalone.py      # site/dist/gold_miner.html 재생성
python -m unittest discover etl     # 테스트
```
표준 라이브러리만 사용합니다(Python 3.9+). 네트워크 허용 필요 호스트: `fred.stlouisfed.org`, `query1.finance.yahoo.com` (`stooq.com`은 예비).

| 데이터 | 소스 | 시리즈 |
|---|---|---|
| 금 가격 (일별) | Yahoo Finance | COMEX 금 선물 GC=F (2000-08~) |
| 실질금리 | FRED | DFII10 |
| 달러 인덱스 | FRED | DTWEXBGS |
| 기대인플레이션 | FRED | T10YIE |
| 10Y 국채 | FRED | DGS10 |
| USD/KRW | FRED | DEXKOUS |

미연결(수동 입력): KRX 금 시세, WGC 중앙은행 수요, CFTC 포지션 → 이후 Phase에서 연결.

## 문서
- `docs/01_feasibility.md` — 실현 가능성 평가
- `docs/02_master_prompt.md` — 마스터 프롬프트 · 단계별 프롬프트
- `docs/design/` — 디자인 콘셉트와 시안 이미지
- `site/concept_v0.2.html` — 이전 디자인 시안(보관용)

정보 제공 목적이며 투자 권유가 아닙니다.
