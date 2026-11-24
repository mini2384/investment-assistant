import os
import re
import json
import time
import hmac
import secrets
import logging
from pathlib import Path
from datetime import datetime, timedelta
import requests
import numpy as np
import pandas as pd
import FinanceDataReader as fdr
from flask import Flask, jsonify, request, render_template, session
from dotenv import load_dotenv
from collector import collect_stock_data, fetch_naver_json

# .env 파일에서 환경변수 불러오기
load_dotenv()

# Python logging 설정 (print 대신 사용)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "").strip() or secrets.token_hex(32)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.permanent_session_lifetime = timedelta(hours=1)

PIN_MAX_ATTEMPTS = 5
PIN_LOCKOUT_SECONDS = 14 * 3600
PIN_SESSION_SECONDS = 3600
PIN_LOCK_FILE = Path(__file__).resolve().parent / ".pin_lock.json"


def _load_lock_state():
    if not PIN_LOCK_FILE.exists():
        return {}
    try:
        data = json.loads(PIN_LOCK_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_lock_state(state):
    try:
        PIN_LOCK_FILE.write_text(json.dumps(state), encoding="utf-8")
    except Exception as e:
        logger.warning(f"[AUTH] 잠금 상태 저장 실패: {e}")


def _client_key():
    return request.remote_addr or "local"


def is_pin_authenticated():
    unlocked_until = session.get("unlocked_until", 0)
    return isinstance(unlocked_until, (int, float)) and time.time() < unlocked_until


@app.before_request
def require_pin_gate():
    path = request.path or "/"
    if path in (
        "/api/auth/login",
        "/api/auth/logout",
        "/static/style.css",
        "/static/manifest.json",
        "/static/images/app-icon.png",
    ):
        return None
    if is_pin_authenticated():
        return None
    if path.startswith("/api/") or path == "/health":
        return jsonify({"error": "인증이 필요합니다."}), 401
    return render_template("login.html"), 200


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    """4자리 비밀번호 검증 (1시간 유지, 5회 실패 시 14시간 잠금)"""
    data = request.get_json(silent=True) or {}
    entered_pin = str(data.get("pin", "")).strip()
    expected_pin = os.getenv("APP_PIN", "").strip()

    if not expected_pin:
        return jsonify({"error": "서버에 비밀번호가 설정되지 않았습니다."}), 500

    now = time.time()
    key = _client_key()
    state = _load_lock_state()
    rec = state.get(key, {"attempts": 0, "locked_until": 0})

    locked_until = float(rec.get("locked_until", 0))
    if locked_until > now:
        rem = int(locked_until - now)
        hrs = rem // 3600
        mins = (rem % 3600 + 59) // 60
        return jsonify({
            "error": f"입력 횟수 초과로 잠금 상태입니다. 약 {hrs}시간 {mins}분 후 다시 시도해 주세요."
        }), 429

    if locked_until and locked_until <= now:
        rec = {"attempts": 0, "locked_until": 0}

    if len(entered_pin) == 4 and hmac.compare_digest(entered_pin, expected_pin):
        state[key] = {"attempts": 0, "locked_until": 0}
        _save_lock_state(state)
        session.permanent = True
        session["unlocked_until"] = now + PIN_SESSION_SECONDS
        logger.info(f"[AUTH] 접속 인증 성공 (client={key})")
        return jsonify({"ok": True}), 200

    attempts = int(rec.get("attempts", 0)) + 1
    if attempts >= PIN_MAX_ATTEMPTS:
        state[key] = {"attempts": attempts, "locked_until": now + PIN_LOCKOUT_SECONDS}
        _save_lock_state(state)
        logger.warning(f"[AUTH] 5회 실패로 14시간 잠금 (client={key})")
        return jsonify({
            "error": "비밀번호를 5회 틀려 14시간 동안 접속이 제한됩니다."
        }), 429

    state[key] = {"attempts": attempts, "locked_until": 0}
    _save_lock_state(state)
    remaining = PIN_MAX_ATTEMPTS - attempts
    return jsonify({
        "error": f"비밀번호가 올바르지 않습니다. (남은 기회: {remaining}회)"
    }), 401


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True}), 200


@app.route("/", methods=["GET"])
def index():
    """메인 웹 페이지(index.html) 반환"""
    return render_template("index.html")


@app.route("/collector-test", methods=["GET"])
def collector_test():
    """기존 1차 수집기 단독 테스트 페이지(test_collector.html) 반환"""
    return render_template("test_collector.html")


@app.route("/health", methods=["GET"])
def health_check():
    """서버 상태 및 API Key 설정 여부만 반환 (키 값 자체는 절대 노출 금지)"""
    serper_key = os.getenv("SERPER_API_KEY", "").strip()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    gemini_model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite").strip()
    dify_base_url = os.getenv("DIFY_BASE_URL", "https://api.dify.ai/v1").strip()
    dify_stock_key = os.getenv("DIFY_STOCK_API_KEY", "").strip()
    dify_ta_key = os.getenv("DIFY_TA_API_KEY", "").strip()

    has_serper_key = bool(serper_key and serper_key != "your_serper_api_key_here")
    has_gemini_key = bool(gemini_key and gemini_key != "your_google_ai_studio_api_key_here")
    has_dify_stock_key = bool(dify_stock_key and dify_stock_key != "your_dify_stock_chatbot_api_key_here")
    has_dify_ta_key = bool(dify_ta_key and dify_ta_key != "your_dify_ta_chatbot_api_key_here")

    logger.info(
        f"[HEALTH] GET /health - serper={has_serper_key}, gemini={has_gemini_key}, "
        f"dify_stock={has_dify_stock_key}, dify_ta={has_dify_ta_key}"
    )

    return jsonify({
        "status": "ok",
        "serper_api_key_configured": has_serper_key,
        "gemini_api_key_configured": has_gemini_key,
        "gemini_model": gemini_model,
        "dify_base_url": dify_base_url,
        "dify_stock_api_key_configured": has_dify_stock_key,
        "dify_ta_api_key_configured": has_dify_ta_key
    }), 200


@app.route("/fetch", methods=["POST"])
@app.route("/api/collector", methods=["POST"])
def fetch_stock():
    """종목코드를 받아 네이버 증권 JSON API + Serper 뉴스 검색을 통합 실행하고 최종 JSON 반환"""
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "")).strip()

    logger.info(f"[REQUEST] POST /fetch code={code}")

    if not code:
        logger.warning("[RESPONSE] 종목코드 미입력 (400)")
        return jsonify({
            "code": "",
            "errors": ["종목코드를 입력해 주세요."]
        }), 400

    if not re.fullmatch(r"\d{6}", code):
        logger.warning(f"[RESPONSE] 잘못된 종목코드 형식: {code} (400)")
        return jsonify({
            "code": code,
            "errors": ["종목코드는 6자리 숫자(예: 000660)로 입력해 주세요."]
        }), 400

    result = collect_stock_data(code)
    error_count = len(result.get("errors", []))
    news_count = len(result.get("news", []))
    stock_name = result.get("profile", {}).get("name")

    logger.info(
        f"[RESPONSE] 수집 완료 (code={code}, name={stock_name}, news={news_count}건, errors={error_count}건)"
    )

    return jsonify(result), 200


def call_dify_chat(api_key, query, conversation_id="", user_id="investment-user", inputs=None, timeout=60):
    """
    Dify 기본 챗봇 API(POST /chat-messages)를 호출하여 답변과 conversation_id를 반환한다.
    API Key는 절대 로그에 출력하지 않는다.
    """
    if not api_key or api_key.startswith("your_"):
        raise ValueError("Dify API Key가 설정되지 않았습니다. .env 파일을 확인해 주세요.")

    base_url = os.getenv("DIFY_BASE_URL", "https://api.dify.ai/v1").strip().rstrip("/")
    endpoint = f"{base_url}/chat-messages"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "inputs": inputs or {},
        "query": query,
        "response_mode": "blocking",
        "user": user_id
    }
    if conversation_id:
        payload["conversation_id"] = conversation_id

    logger.info(f"[DIFY]     Dify API 호출 시작 (endpoint={endpoint}, conversation_id={conversation_id or 'NEW'})")

    response = requests.post(endpoint, headers=headers, json=payload, timeout=timeout)
    if response.status_code == 401:
        raise ValueError("Dify API Key 인증에 실패했습니다 (401). 키 값을 확인해 주세요.")
    if response.status_code == 404:
        raise ValueError("Dify 앱 또는 대화를 찾을 수 없습니다 (404). 새 대화를 시작해 주세요.")
    response.raise_for_status()

    res_json = response.json()
    answer = res_json.get("answer", "")
    new_conv_id = res_json.get("conversation_id", conversation_id)
    logger.info(f"[RESPONSE] Dify 응답 성공 status={response.status_code}, conversation_id={new_conv_id}")
    return answer, new_conv_id


LEVEL_INSTRUCTIONS = {
    "beginner": (
        "설명 수준: [초급 - 주식 입문자]\n"
        "- PER, PBR, ROE, EV/EBITDA, 컨센서스, 괴리율 같은 전문 용어가 나올 때마다 괄호나 짧은 문장으로 쉬운 비유와 뜻을 함께 설명해 주세요.\n"
        "- 복잡한 재무 수치 나열은 줄이고, '이 회사가 돈을 잘 버는지 / 주가가 비싼 편인지 싼 편인지 / 지금 무엇을 조심해야 하는지'를 일상 언어로 친절하게 풀어주세요."
    ),
    "intermediate": (
        "설명 수준: [중급 - 일반 투자자]\n"
        "- 기본 투자 용어(PER, PBR, ROE, 컨센서스)는 알고 있는 독자를 대상으로 핵심 지표의 의미와 전후 맥락을 균형 있게 해석해 주세요.\n"
        "- 데이터 수치 근거와 실전적인 대응 전략(매수·보유·축소 기준)을 명확하고 읽기 쉽게 제시하세요."
    ),
    "advanced": (
        "설명 수준: [고급 - 숙련 투자자/애널리스트]\n"
        "- 기초 용어 설명은 생략하고, 멀티플 리레이팅/디레이팅 논리, 매출 YoY 및 영업레버리지 추세, ROE-PBR 정합성, EV/EBITDA 밸류에이션, 컨센서스 상·하향 리스크와 정량적 손익비 시나리오를 압축적이고 깊이 있게 분석하세요."
    ),
}


@app.route("/api/chat/stock", methods=["POST"])
def chat_stock():
    """[탭 1] 종목 데이터 수집 후 Dify 종목분석기 챗봇 API 연동 대화"""
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "")).strip()
    query = str(data.get("query", "")).strip()
    mode = str(data.get("mode", "chat")).strip()
    level = str(data.get("level", "intermediate")).strip()
    if level not in LEVEL_INSTRUCTIONS:
        level = "intermediate"
    level_guide = LEVEL_INSTRUCTIONS[level]
    conversation_id = str(data.get("conversation_id", "")).strip()

    logger.info(f"[REQUEST]  POST /api/chat/stock code={code}, mode={mode}, level={level}, conversation_id={conversation_id or 'NEW'}")

    if mode != "initial_analysis" and not query:
        return jsonify({"error": "질문 내용을 입력해 주세요."}), 400

    collected_data = None
    dify_query = f"[{level_guide}]\n\n{query}" if query else query

    # 새 대화 시작 시(conversation_id 없음) 또는 initial_analysis 모드에서는 종목 데이터를 수집해 전문가 프롬프트에 합성
    if not conversation_id or mode == "initial_analysis":
        conversation_id = ""
        if not re.fullmatch(r"[A-Za-z0-9.\-]{1,15}", code):
            return jsonify({"error": "새 분석을 시작하려면 국내 6자리 종목코드(예: 000660) 또는 해외 티커(예: AAPL, NVDA)를 입력해 주세요."}), 400

        collected_data = collect_stock_data(code)
        logger.info(
            f"[COLLECT]  collector.py 데이터 수집 완료 (code={code}, name={collected_data.get('profile', {}).get('name')})"
        )

        if not collected_data.get("profile", {}).get("name"):
            err_msg = " / ".join(collected_data.get("errors", [])) or "종목 데이터를 수집하지 못했습니다."
            return jsonify({"error": err_msg, "collected": collected_data}), 400

        context_json = json.dumps(collected_data, ensure_ascii=False)
        stock_name = collected_data["profile"]["name"]

        if mode == "initial_analysis":
            user_instruction = (
                f"'{stock_name}({code})'에 대한 종합 심층 분석 리포트를 작성해 주세요.\n"
                "아래 5개 항목을 구조화된 마크다운(제목, 글머리 기호, 굵은 강조)으로 정리해 주세요:\n"
                "1. **현재 주가 위치 및 수급** (현재가, 52주 최고/최저 대비 위치, 거래대금, 외인소진율)\n"
                "2. **밸류에이션 및 시장 기대치** (PER vs 추정PER 비교, PBR/BPS, 목표주가 괴리율, 동종업종 대비, `consensus_table` 기반 향후 3년 매출 YoY·영업이익·EPS·EV/EBITDA 컨센서스 추이)\n"
                "3. **연간·분기 실적 추세 및 재무 안정성** (매출/영업이익/영업이익률 흐름, ROE, 부채비율, 배당 — 추정치(E)는 반드시 추정치임을 명시)\n"
                "4. **최신 뉴스 핵심 이슈** (수집된 뉴스 기사 기반 핵심 쟁점 요약)\n"
                "5. **PB 종합 결론 및 대응 전략** (데이터 근거 기반 현재 포지션 의견: 비중확대/보유/축소 중 명확한 방향 제시 및 핵심 리스크·기준선)"
            )
        else:
            user_instruction = query

        currency = collected_data.get("profile", {}).get("currency", "KRW")
        fin_unit = collected_data.get("financials", {}).get("unit", "억원")
        unit_note = (
            f"(주의: 이 종목의 주가·목표주가는 '{currency}' 기준이며, financials의 매출액·영업이익·순이익 단위는 '{fin_unit}'입니다. 통화와 자릿수를 정확히 지켜주세요.)"
            if currency != "KRW"
            else "(주의: financials의 매출액·영업이익·순이익 숫자는 이미 '억 원' 단위입니다. 예: 327657은 327,657억 원 = 약 32조 7,657억 원입니다. 자릿수를 임의로 줄이지 마세요.)"
        )

        dify_query = (
            f"당신은 사용자 개인을 전담하는 시니어 프라이빗 뱅커(PB)이자 퀀트 애널리스트입니다.\n"
            f"이 대화는 개인 자산관리 의사결정을 돕기 위한 사적 분석이므로, 사용자가 보유/매도/매수 중 선택을 요청할 때는 양비론으로 회피하지 말고 수집된 데이터에 근거해 가장 합리적인 **단 하나의 명확한 전략(PB 결론)**과 그 이유, 그리고 판단을 바꿀 기준 조건(가격·실적)을 직접적으로 제시하세요.\n"
            f"단, 모든 수치와 팩트는 반드시 아래 JSON 데이터에 근거해야 하며 없는 수치는 지어내지 마세요.\n"
            f"{unit_note}\n\n"
            f"{level_guide}\n\n"
            f"[수집된 종목 데이터 JSON]\n{context_json}\n\n"
            f"[분석 요청]\n{user_instruction}"
        )

    dify_stock_key = os.getenv("DIFY_STOCK_API_KEY", "").strip()
    try:
        answer, new_conv_id = call_dify_chat(
            api_key=dify_stock_key,
            query=dify_query,
            conversation_id=conversation_id
        )
        return jsonify({
            "answer": answer,
            "conversation_id": new_conv_id,
            "collected": collected_data
        }), 200
    except ValueError as ve:
        logger.warning(f"[ERROR]    Dify 종목분석 호출 실패: {ve}")
        return jsonify({"error": str(ve), "collected": collected_data}), 400
    except requests.exceptions.Timeout:
        logger.error("[ERROR]    Dify API 호출 타임아웃", exc_info=True)
        return jsonify({"error": "Dify 챗봇 응답 시간이 초과되었습니다.", "collected": collected_data}), 504
    except Exception as e:
        logger.error(f"[ERROR]    Dify API 호출 중 오류: {e}", exc_info=True)
        return jsonify({"error": f"Dify 연동 중 오류가 발생했습니다: {e}", "collected": collected_data}), 500


def get_stock_name_safe(code):
    """종목코드에 해당하는 정식 종목명을 네이버 basic API에서 가볍게 조회한다."""
    try:
        data = fetch_naver_json(f"https://m.stock.naver.com/api/stock/{code}/basic", timeout=5)
        return data.get("stockName") or code
    except Exception:
        return code


def calculate_mdd(daily_portfolio_returns):
    """일별 포트폴리오 수익률 시리즈에서 최대낙폭(MDD, %)을 계산한다."""
    cumulative = (1.0 + daily_portfolio_returns).cumprod()
    peak = cumulative.cummax()
    drawdown = (cumulative - peak) / peak
    return round(float(drawdown.min() * 100), 2)


@app.route("/api/rebalance", methods=["POST"])
def api_rebalance():
    """[탭 2] FDR 최근 1년 데이터 기반 몬테카를로 시뮬레이션 및 효율적 프론티어 계산 (Dify 미사용)"""
    data = request.get_json(silent=True) or {}
    raw_codes = data.get("codes", [])

    if isinstance(raw_codes, str):
        codes = [c.strip().upper() for c in raw_codes.split(",") if c.strip()]
    elif isinstance(raw_codes, list):
        codes = [str(c).strip().upper() for c in raw_codes if str(c).strip()]
    else:
        codes = []

    # 중복 제거 (순서 유지)
    codes = list(dict.fromkeys(codes))
    logger.info(f"[REQUEST]  POST /api/rebalance codes={codes}")

    if len(codes) < 2:
        return jsonify({"error": "리밸런싱 계산을 위해 종목코드를 2개 이상 입력해 주세요."}), 400

    end_date = datetime.now()
    start_date = end_date - timedelta(days=365)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    close_dict = {}
    name_map = {}

    try:
        logger.info(f"[FDR]      FinanceDataReader 1년 주가 조회 시작 (codes={codes}, {start_str}~{end_str})")
        for code in codes:
            df = fdr.DataReader(code, start_str, end_str)
            if df is None or df.empty or "Close" not in df.columns:
                return jsonify({"error": f"종목코드 '{code}'의 최근 1년 주가 데이터를 찾을 수 없습니다."}), 400
            series = df["Close"].dropna()
            if len(series) < 20:
                return jsonify({"error": f"종목코드 '{code}'의 거래일 데이터가 부족합니다(최소 20일 필요)."}), 400
            close_dict[code] = series
            name_map[code] = get_stock_name_safe(code)

        prices_df = pd.DataFrame(close_dict).dropna()
        if len(prices_df) < 20:
            return jsonify({"error": "입력된 종목들의 공통 거래일 데이터가 부족합니다."}), 400

        returns_df = prices_df.pct_change().dropna()
        mean_returns = returns_df.mean() * 252
        cov_matrix = returns_df.cov() * 252
        risk_free_rate = 0.035  # 무위험 이자율 연 3.5% 가정

        num_assets = len(codes)
        num_portfolios = 3000

        all_weights = np.zeros((num_portfolios, num_assets))
        ret_arr = np.zeros(num_portfolios)
        vol_arr = np.zeros(num_portfolios)
        sharpe_arr = np.zeros(num_portfolios)

        for i in range(num_portfolios):
            weights = np.random.random(num_assets)
            weights /= np.sum(weights)
            all_weights[i, :] = weights

            port_ret = float(np.sum(mean_returns.values * weights))
            port_vol = float(np.sqrt(np.dot(weights.T, np.dot(cov_matrix.values, weights))))
            sharpe = (port_ret - risk_free_rate) / port_vol if port_vol > 0 else 0.0

            ret_arr[i] = port_ret
            vol_arr[i] = port_vol
            sharpe_arr[i] = sharpe

        max_sharpe_idx = int(np.argmax(sharpe_arr))
        min_vol_idx = int(np.argmin(vol_arr))

        def build_portfolio_summary(idx):
            w = all_weights[idx]
            port_daily_ret = returns_df.values @ w
            return {
                "expected_return": round(float(ret_arr[idx] * 100), 2),
                "volatility": round(float(vol_arr[idx] * 100), 2),
                "sharpe_ratio": round(float(sharpe_arr[idx]), 2),
                "mdd": calculate_mdd(pd.Series(port_daily_ret)),
                "weights": [
                    {
                        "code": codes[j],
                        "name": name_map[codes[j]],
                        "weight": round(float(w[j] * 100), 2)
                    }
                    for j in range(num_assets)
                ]
            }

        max_sharpe_port = build_portfolio_summary(max_sharpe_idx)
        min_vol_port = build_portfolio_summary(min_vol_idx)

        # 산점도 시각화용 샘플링 (최대 250개 점)
        step = max(1, num_portfolios // 250)
        frontier_points = [
            {
                "volatility": round(float(vol_arr[i] * 100), 2),
                "expected_return": round(float(ret_arr[i] * 100), 2),
                "sharpe": round(float(sharpe_arr[i]), 2)
            }
            for i in range(0, num_portfolios, step)
        ]

        logger.info(
            f"[QUANT]    몬테카를로 {num_portfolios}회 완료 (최대 샤프={max_sharpe_port['sharpe_ratio']}, "
            f"기대수익률={max_sharpe_port['expected_return']}%)"
        )

        return jsonify({
            "period": f"{start_str} ~ {end_str}",
            "trading_days": len(prices_df),
            "simulations": num_portfolios,
            "max_sharpe": max_sharpe_port,
            "min_volatility": min_vol_port,
            "frontier_points": frontier_points
        }), 200
    except Exception as e:
        logger.error(f"[ERROR]    리밸런싱 계산 실패: {e}", exc_info=True)
        return jsonify({"error": f"리밸런싱 계산 중 오류가 발생했습니다: {e}"}), 500


def _to_clean_list(series):
    """Pandas Series의 NaN을 None으로 바꿔 JSON 직렬화 가능한 리스트로 반환한다."""
    return [None if pd.isna(v) else round(float(v), 2) for v in series]


def compute_technical_indicators(code):
    """FinanceDataReader로 주가를 조회해 MA, 볼린저밴드, RSI(14), MACD를 계산한다."""
    end_date = datetime.now()
    start_date = end_date - timedelta(days=270)
    start_str = start_date.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    logger.info(f"[FDR]      기술지표용 주가 조회 시작 (code={code}, {start_str}~{end_str})")
    df = fdr.DataReader(code, start_str, end_str)
    if df is None or df.empty or "Close" not in df.columns:
        raise ValueError(f"종목코드 '{code}'의 주가 데이터를 찾을 수 없습니다.")

    df = df.dropna(subset=["Close"]).copy()
    if len(df) < 30:
        raise ValueError(f"종목코드 '{code}'의 거래일 데이터가 부족합니다(최소 30일 필요).")

    close = df["Close"]
    df["MA5"] = close.rolling(5).mean()
    df["MA20"] = close.rolling(20).mean()
    df["MA60"] = close.rolling(60).mean()
    df["MA120"] = close.rolling(120).mean()

    std20 = close.rolling(20).std()
    df["BB_UPPER"] = df["MA20"] + (std20 * 2)
    df["BB_LOWER"] = df["MA20"] - (std20 * 2)

    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    df["RSI14"] = 100 - (100 / (1 + rs))

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_SIGNAL"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_HIST"] = df["MACD"] - df["MACD_SIGNAL"]

    # 최근 90거래일만 차트용으로 추출
    chart_df = df.tail(90)
    dates = [idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx) for idx in chart_df.index]

    last = chart_df.iloc[-1]
    stock_name = get_stock_name_safe(code)

    def _val(col):
        v = last[col]
        return None if pd.isna(v) else round(float(v), 2)

    latest_summary = {
        "code": code,
        "name": stock_name,
        "date": dates[-1],
        "close": _val("Close"),
        "ma5": _val("MA5"),
        "ma20": _val("MA20"),
        "ma60": _val("MA60"),
        "ma120": _val("MA120"),
        "bb_upper": _val("BB_UPPER"),
        "bb_lower": _val("BB_LOWER"),
        "rsi14": _val("RSI14"),
        "macd": _val("MACD"),
        "macd_signal": _val("MACD_SIGNAL"),
        "macd_hist": _val("MACD_HIST")
    }

    series_data = {
        "dates": dates,
        "close": _to_clean_list(chart_df["Close"]),
        "ma20": _to_clean_list(chart_df["MA20"]),
        "ma60": _to_clean_list(chart_df["MA60"]),
        "bb_upper": _to_clean_list(chart_df["BB_UPPER"]),
        "bb_lower": _to_clean_list(chart_df["BB_LOWER"]),
        "rsi14": _to_clean_list(chart_df["RSI14"]),
        "macd": _to_clean_list(chart_df["MACD"]),
        "macd_signal": _to_clean_list(chart_df["MACD_SIGNAL"])
    }

    logger.info(
        f"[QUANT]    기술지표 계산 완료 (code={code}, name={stock_name}, close={latest_summary['close']}, rsi14={latest_summary['rsi14']})"
    )
    return latest_summary, series_data


@app.route("/api/ta/chart", methods=["POST"])
def api_ta_chart():
    """[탭 3] FDR 기반 기술지표(MA, RSI, MACD, 볼린저밴드) 계산 결과 반환"""
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "")).strip().upper()
    logger.info(f"[REQUEST]  POST /api/ta/chart code={code}")

    if not code:
        return jsonify({"error": "종목코드를 입력해 주세요."}), 400

    try:
        latest_summary, series_data = compute_technical_indicators(code)
        return jsonify({
            "summary": latest_summary,
            "series": series_data
        }), 200
    except ValueError as ve:
        return jsonify({"error": str(ve)}), 400
    except Exception as e:
        logger.error(f"[ERROR]    기술지표 계산 실패: {e}", exc_info=True)
        return jsonify({"error": f"기술지표 계산 중 오류가 발생했습니다: {e}"}), 500


@app.route("/api/chat/ta", methods=["POST"])
def api_chat_ta():
    """[탭 3] Python이 계산한 기술지표 숫자를 숨겨서 Dify 지표설명기 API에 주입 후 대화"""
    data = request.get_json(silent=True) or {}
    code = str(data.get("code", "")).strip().upper()
    query = str(data.get("query", "")).strip()
    indicators = data.get("indicators")
    conversation_id = str(data.get("conversation_id", "")).strip()

    logger.info(f"[REQUEST]  POST /api/chat/ta code={code}, conversation_id={conversation_id or 'NEW'}")

    if not query:
        return jsonify({"error": "질문 내용을 입력해 주세요."}), 400

    dify_query = query
    if not conversation_id:
        if not indicators:
            if not code:
                return jsonify({"error": "먼저 종목을 조회하거나 종목코드를 입력해 주세요."}), 400
            try:
                indicators, _ = compute_technical_indicators(code)
            except Exception as e:
                return jsonify({"error": str(e)}), 400

        indicators_json = json.dumps(indicators, ensure_ascii=False)
        dify_query = (
            f"아래는 Python(FinanceDataReader)이 '{indicators.get('name')}({indicators.get('code')})'에 대해 계산한 최신 기술지표 수치입니다.\n"
            f"반드시 아래 계산된 숫자만을 근거로 초보자가 이해하기 쉽게 설명해 주세요. (매수/매도 추천 금지)\n\n"
            f"[계산된 기술지표 수치]\n{indicators_json}\n\n"
            f"[사용자 질문]\n{query}"
        )

    dify_ta_key = os.getenv("DIFY_TA_API_KEY", "").strip()
    try:
        answer, new_conv_id = call_dify_chat(
            api_key=dify_ta_key,
            query=dify_query,
            conversation_id=conversation_id
        )
        return jsonify({
            "answer": answer,
            "conversation_id": new_conv_id
        }), 200
    except ValueError as ve:
        logger.warning(f"[ERROR]    Dify 지표설명기 호출 실패: {ve}")
        return jsonify({"error": str(ve)}), 400
    except requests.exceptions.Timeout:
        logger.error("[ERROR]    Dify 지표설명기 타임아웃", exc_info=True)
        return jsonify({"error": "Dify 지표설명기 응답 시간이 초과되었습니다."}), 504
    except Exception as e:
        logger.error(f"[ERROR]    Dify 지표설명기 오류: {e}", exc_info=True)
        return jsonify({"error": f"Dify 연동 중 오류가 발생했습니다: {e}"}), 500


if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "true").lower() == "true"
    logger.info(f"[SERVER] Flask 서버 시작 (debug={debug_mode}, port=5000)")
    app.run(host="127.0.0.1", port=5000, debug=debug_mode)
