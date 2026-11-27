# Gold Miner — 금거래소 매입·매도 타이밍 인텔리전스

금 가격 측정과 과거 데이터 기반 미래 분석으로 금거래소의 매입·매도 판단을 돕는 대시보드입니다.

## 바로 보기
- `site/dist/gold_miner.html` — 데이터가 들어 있는 단일 파일. 브라우저로 열면 됩니다.
- `site/index.html` — 개발용 (`site/data/gm_data.js`를 읽음)

## 데이터 갱신 (Phase 1 ETL)
```bash
python etl/gold_miner_etl.py        # 수집 → 품질 검사 → data/clean, site/data/gm_data.js 생성
python etl/build_standalone.py      # site/dist/gold_miner.html 재생성
python -m unittest discover etl     # ETL 테스트
node --test site/js/engine.test.js  # 백테스트 엔진 테스트 (미래 데이터 참조 방지 포함)
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

## 기능 현황
| Phase | 내용 | 상태 |
|---|---|---|
| 1 | 데이터 파이프라인 (FRED, COMEX 금), 품질 검사 | 완료 |
| 2 | 대시보드, 금 vs 실질금리·달러, 52주 롤링 상관, 계절성(월·요일), 연도×월 히트맵 | 완료 |
| 3 | 일별 백테스트 랩: 전략 6종, 거래비용·현금 이자·체결 지연·리밸런싱 밴드, 성과지표, 낙폭, 연도별 수익률, 롤링 수익률, 파라미터 민감도, 워크포워드 | 완료 |
| 4 | 시그널 검증(분위별 이후 수익률), 분위수 예측, 레짐 모델 | 예정 |
| 5 | KRX 시세, 알림, 브리핑 | 예정 |

### 백테스트 규칙 (`site/js/engine.js`)
- 목표 비중은 그날 종가까지의 정보로만 계산하고, 체결은 다음 날 종가(기본) 또는 당일 종가에 합니다.
- 거시 지표는 관측일 다음 날부터만 사용합니다(발표 지연 반영).
- 거래비용은 매매한 비중에 편도 비율로 차감하고, 금을 보유하지 않은 비중은 현금 금리를 받습니다.
- 워크포워드: 매년 직전 5년 데이터로 이동평균 조합(빠른 10~100일 × 느린 100~250일) 중 샤프 최고를 고르고, 다음 1년은 처음 보는 데이터로 운용합니다.

## 문서
- `docs/01_feasibility.md` — 실현 가능성 평가
- `docs/02_master_prompt.md` — 마스터 프롬프트 · 단계별 프롬프트
- `docs/design/` — 디자인 콘셉트와 시안 이미지
- `site/concept_v0.2.html` — 이전 디자인 시안(보관용)

정보 제공 목적이며 투자 권유가 아닙니다.
