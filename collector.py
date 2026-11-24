import os
import re
import logging
import requests

logger = logging.getLogger(__name__)

# 네이버 서버 문전박대 방지를 위한 매너 명찰(User-Agent 및 Referer)
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Referer": "https://m.stock.naver.com/"
}


def clean_number(value):
    """
    문자열 지표(예: '1,223,000', '5.46배', '48.01%', '-18,000')에서
    콤마(,)와 단위를 제거하고 순수 숫자(int 또는 float)로 변환한다.
    적자 등으로 값이 없거나('N/A', '-', None, '') 변환할 수 없으면 None을 반환한다.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value

    text = str(value).strip()
    if not text or text in ("-", "N/A", "nan", "null", "None"):
        return None

    # '4조 3,341억'처럼 조/억 단위가 섞인 한글 금액 표기 처리 (백만 원 단위로 변환)
    if "조" in text or "억" in text:
        total_eok = 0
        jo_match = re.search(r"([\d,]+)\s*조", text)
        eok_match = re.search(r"([\d,]+)\s*억", text)
        if jo_match:
            total_eok += int(jo_match.group(1).replace(",", "")) * 10000
        if eok_match:
            total_eok += int(eok_match.group(1).replace(",", ""))
        if jo_match or eok_match:
            # 1억 원 = 100백만 원
            return total_eok * 100

    # 콤마 및 공백 제거 후 숫자와 부호(+/-), 소수점(.)만 추출
    cleaned = text.replace(",", "").strip()
    match = re.search(r"[-+]?\d+(?:\.\d+)?", cleaned)
    if not match:
        return None

    num_str = match.group(0)
    try:
        if "." in num_str:
            return float(num_str)
        return int(num_str)
    except ValueError:
        return None


def fetch_naver_json(url, timeout=10):
    """네이버 증권 내부 JSON API를 호출하여 dict로 반환한다."""
    response = requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
    if response.status_code == 404:
        raise ValueError("존재하지 않는 종목코드입니다 (404).")
    response.raise_for_status()
    return response.json()


def extract_profile_and_price(basic_data, integration_data):
    """
    basic 및 integration JSON 응답에서
    1) 기업 프로필(profile)과 2) 시세 정보(price_info)를 추출한다.
    """
    # totalInfos 리스트를 code 기준 딕셔너리로 변환하여 빠르게 조회
    total_infos = {}
    for item in integration_data.get("totalInfos", []):
        code_key = item.get("code")
        if code_key:
            total_infos[code_key] = item.get("value")

    # 1) 기업 프로필 추출
    exchange_info = basic_data.get("stockExchangeType") or {}
    market_name = exchange_info.get("nameKor") or exchange_info.get("name") or "KOSPI"
    stock_name = basic_data.get("stockName") or integration_data.get("stockName")

    profile = {
        "name": stock_name,
        "market": market_name,
        "industry_code": integration_data.get("industryCode")
    }

    # 2) 시세 정보(price_info) 추출
    price_info = {
        "current_price": clean_number(basic_data.get("closePrice")),
        "change_price": clean_number(basic_data.get("compareToPreviousClosePrice")),
        "change_rate": clean_number(basic_data.get("fluctuationsRatio")),
        "prev_close": clean_number(total_infos.get("lastClosePrice")),
        "open_price": clean_number(total_infos.get("openPrice")),
        "high_price": clean_number(total_infos.get("highPrice")),
        "low_price": clean_number(total_infos.get("lowPrice")),
        "low_52w": clean_number(total_infos.get("lowPriceOf52Weeks")),
        "high_52w": clean_number(total_infos.get("highPriceOf52Weeks")),
        "volume": clean_number(total_infos.get("accumulatedTradingVolume")),
        "trading_value_million": clean_number(total_infos.get("accumulatedTradingValue")),
        "trading_value_text": total_infos.get("accumulatedTradingValue")
    }

    return profile, price_info


def extract_valuation(integration_data):
    """
    integration JSON 응답에서
    투자정보 및 밸류에이션(valuation: 시총, 외인소진율, PER/EPS, 추정PER/EPS, PBR/BPS,
    배당수익률/주당배당금, 컨센서스 목표주가/투자의견, 동일업종 비교 종목 요약)을 추출한다.
    """
    total_infos = {}
    for item in integration_data.get("totalInfos", []):
        code_key = item.get("code")
        if code_key:
            total_infos[code_key] = item.get("value")

    consensus = integration_data.get("consensusInfo") or {}

    # 동일업종 대표 비교 종목 리스트(industryCompareInfo)에서 평균 등락률 및 비교 종목 요약 추출
    peers_raw = integration_data.get("industryCompareInfo") or []
    peers = []
    peer_rates = []
    for p in peers_raw[:5]:
        rate = clean_number(p.get("fluctuationsRatio"))
        if rate is not None:
            peer_rates.append(rate)
        peers.append({
            "code": p.get("itemCode"),
            "name": p.get("stockName"),
            "current_price": clean_number(p.get("closePrice")),
            "change_rate": rate
        })

    avg_peer_change_rate = round(sum(peer_rates) / len(peer_rates), 2) if peer_rates else None

    valuation = {
        "market_cap_text": total_infos.get("marketValue"),
        "market_cap_million": clean_number(total_infos.get("marketValue")),
        "foreign_rate": clean_number(total_infos.get("foreignRate")),
        "per": clean_number(total_infos.get("per")),
        "eps": clean_number(total_infos.get("eps")),
        "cns_per": clean_number(total_infos.get("cnsPer")),
        "cns_eps": clean_number(total_infos.get("cnsEps")),
        "pbr": clean_number(total_infos.get("pbr")),
        "bps": clean_number(total_infos.get("bps")),
        "dividend_yield": clean_number(total_infos.get("dividendYieldRatio")),
        "dps": clean_number(total_infos.get("dividend")),
        "target_price": clean_number(consensus.get("priceTargetMean")),
        "investment_opinion": clean_number(consensus.get("recommMean")),
        "consensus_date": consensus.get("createDate"),
        "peer_avg_change_rate": avg_peer_change_rate,
        "industry_peers": peers
    }

    return valuation


# 네이버 finance JSON의 한글 행 이름을 영문 JSON 키로 매핑
FINANCE_ROW_MAP = {
    "매출액": "revenue",
    "영업이익": "operating_income",
    "당기순이익": "net_income",
    "지배주주순이익": "controlling_net_income",
    "영업이익률": "operating_margin",
    "순이익률": "net_margin",
    "ROE": "roe",
    "부채비율": "debt_ratio",
    "당좌비율": "quick_ratio",
    "유보율": "reserve_ratio",
    "EPS": "eps",
    "PER": "per",
    "BPS": "bps",
    "PBR": "pbr",
    "주당배당금": "dps",
}


def parse_finance_period_list(finance_json):
    """
    finance/annual 또는 finance/quarter 응답 JSON에서
    기간별(연도/분기) 실적 카드 리스트를 생성하고 is_consensus 신호등을 구분한다.
    """
    finance_info = finance_json.get("financeInfo") or {}
    tr_titles = finance_info.get("trTitleList") or []
    row_list = finance_info.get("rowList") or []

    # 행 이름 -> columns 딕셔너리 매핑
    rows_by_title = {}
    for row in row_list:
        title = row.get("title")
        if title in FINANCE_ROW_MAP:
            rows_by_title[FINANCE_ROW_MAP[title]] = row.get("columns") or {}

    periods = []
    for col_meta in tr_titles:
        col_key = col_meta.get("key")
        raw_title = (col_meta.get("title") or "").strip().rstrip(".")
        is_consensus = (col_meta.get("isConsensus") == "Y")

        entry = {
            "period": raw_title,
            "is_consensus": is_consensus
        }
        for field_name in FINANCE_ROW_MAP.values():
            col_data = rows_by_title.get(field_name, {}).get(col_key) or {}
            entry[field_name] = clean_number(col_data.get("value"))

        periods.append(entry)

    return periods


def extract_financials(code):
    """
    네이버 증권 연간(annual) 및 분기(quarter) 실적 JSON API를 호출하여
    분리된 시계열 실적 데이터를 반환한다.
    """
    annual_url = f"https://m.stock.naver.com/api/stock/{code}/finance/annual"
    quarter_url = f"https://m.stock.naver.com/api/stock/{code}/finance/quarter"

    annual_json = fetch_naver_json(annual_url)
    quarter_json = fetch_naver_json(quarter_url)

    return {
        "unit": "억원 (비율: %, 주당지표: 원/배)",
        "annual": parse_finance_period_list(annual_json),
        "quarterly": parse_finance_period_list(quarter_json),
    }


def fetch_serper_news(stock_name, num=5, timeout=10):
    """
    네이버에서 확인한 정식 종목명으로 Serper News API를 호출하여 최신 뉴스를 최대 5개 수집한다.
    API Key는 절대 로그에 출력하지 않는다.
    """
    api_key = os.getenv("SERPER_API_KEY", "").strip()
    if not api_key or api_key == "your_serper_api_key_here":
        raise ValueError("SERPER_API_KEY가 설정되지 않았습니다. .env 파일을 확인해 주세요.")

    query = f"{stock_name} 주가"
    logger.info(f"[SERPER] Serper News API 호출 시작 (query={query})")

    url = "https://google.serper.dev/news"
    headers = {
        "X-API-KEY": api_key,
        "Content-Type": "application/json"
    }
    payload = {
        "q": query,
        "gl": "kr",
        "hl": "ko",
        "num": num
    }

    response = requests.post(url, headers=headers, json=payload, timeout=timeout)
    response.raise_for_status()
    data = response.json()

    news_items = []
    for item in (data.get("news") or [])[:num]:
        news_items.append({
            "title": item.get("title", ""),
            "url": item.get("link", ""),
            "description": item.get("snippet", ""),
            "source": item.get("source", ""),
            "published": item.get("date", "")
        })

    return news_items


def collect_stock_data(code):
    """
    종목코드(6자리)를 받아 네이버 증권 데이터와 Serper 뉴스를 통합 수집한다.
    (Step 15: 4차 구현 — 정식 종목명 기반 Serper News API 연동)
    """
    result = {
        "code": code,
        "profile": {},
        "price_info": {},
        "valuation": {},
        "financials": {"unit": "억원 (비율: %, 주당지표: 원/배)", "annual": [], "quarterly": []},
        "news": [],
        "errors": []
    }

    if not code or not re.fullmatch(r"\d{6}", str(code).strip()):
        result["errors"].append("종목코드는 6자리 숫자로 입력해 주세요.")
        return result

    code = str(code).strip()
    basic_url = f"https://m.stock.naver.com/api/stock/{code}/basic"
    integration_url = f"https://m.stock.naver.com/api/stock/{code}/integration"

    try:
        logger.info(f"[NAVER] 네이버 증권 JSON API 호출 시작 (code={code}, User-Agent 적용)")
        basic_data = fetch_naver_json(basic_url)
        integration_data = fetch_naver_json(integration_url)

        profile, price_info = extract_profile_and_price(basic_data, integration_data)
        valuation = extract_valuation(integration_data)

        result["profile"] = profile
        result["price_info"] = price_info
        result["valuation"] = valuation

        # 기업실적분석(연간/분기) 수집 — 일부 오류가 나도 기본 시세/밸류에이션은 유지
        try:
            financials = extract_financials(code)
            result["financials"] = financials
        except Exception as fe:
            logger.error(f"[ERROR] 실적 데이터 수집 실패: {fe}", exc_info=True)
            result["errors"].append(f"기업실적분석 데이터를 가져오지 못했습니다: {fe}")

        logger.info(
            f"[PARSE] 프로필, 시세, 밸류에이션, 실적(연간 {len(result['financials']['annual'])}건, "
            f"분기 {len(result['financials']['quarterly'])}건) 정제 완료 (name={profile.get('name')})"
        )
    except ValueError as ve:
        logger.error(f"[ERROR] 종목 조회 실패: {ve}")
        result["errors"].append(str(ve))
    except requests.exceptions.Timeout:
        logger.error("[ERROR] 네이버 API 호출 타임아웃", exc_info=True)
        result["errors"].append("네이버 금융 서버 응답 시간이 초과되었습니다 (타임아웃).")
    except Exception as e:
        logger.error(f"[ERROR] 네이버 API 수집 중 오류 발생: {e}", exc_info=True)
        result["errors"].append(f"네이버 금융 데이터 수집에 실패했습니다: {e}")

    # 정식 종목명을 확보한 경우에만 Serper News API 호출
    stock_name = result["profile"].get("name")
    if stock_name:
        try:
            result["news"] = fetch_serper_news(stock_name, num=5)
        except ValueError as ve:
            logger.warning(f"[SERPER] 뉴스 수집 건너뜀: {ve}")
            result["errors"].append(str(ve))
        except requests.exceptions.Timeout:
            logger.error("[ERROR] Serper API 호출 타임아웃", exc_info=True)
            result["errors"].append("뉴스 검색(Serper API) 응답 시간이 초과되었습니다.")
        except Exception as se:
            logger.error(f"[ERROR] Serper API 호출 실패: {se}", exc_info=True)
            result["errors"].append(f"뉴스 수집(Serper API)에 실패했습니다: {se}")
    else:
        logger.warning("[SERPER] 종목명을 확인하지 못해 뉴스 검색을 생략합니다.")
        result["errors"].append("종목명 확인에 실패하여 뉴스 검색을 건너뛰었습니다.")

    return result
