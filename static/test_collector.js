document.addEventListener("DOMContentLoaded", () => {
  console.log("[PAGE]    페이지 로드 완료");

  const searchForm = document.getElementById("searchForm");
  const stockCodeInput = document.getElementById("stockCodeInput");
  const searchBtn = document.getElementById("searchBtn");
  const loadingBox = document.getElementById("loadingBox");
  const errorBanner = document.getElementById("errorBanner");
  const resultSection = document.getElementById("resultSection");
  const rawJsonToggle = document.getElementById("rawJsonToggle");
  const rawJsonOutput = document.getElementById("rawJsonOutput");

  // 빠른 테스트 버튼 클릭 이벤트
  document.querySelectorAll(".chip-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code;
      stockCodeInput.value = code;
      fetchStockData(code);
    });
  });

  // 폼 제출 이벤트
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = stockCodeInput.value.trim();
    fetchStockData(code);
  });

  // 원본 JSON 토글
  rawJsonToggle.addEventListener("click", () => {
    rawJsonOutput.classList.toggle("hidden");
  });

  function formatNumber(val, suffix = "") {
    if (val === null || val === undefined || Number.isNaN(val)) {
      return "-";
    }
    return `${Number(val).toLocaleString("ko-KR")}${suffix}`;
  }

  function getTrendClass(val) {
    if (val === null || val === undefined || val === 0) return "flat";
    return val > 0 ? "up" : "down";
  }

  function showErrors(errors) {
    if (!errors || errors.length === 0) {
      errorBanner.classList.add("hidden");
      errorBanner.innerHTML = "";
      return;
    }
    errorBanner.classList.remove("hidden");
    const ul = document.createElement("ul");
    errors.forEach((msg) => {
      const li = document.createElement("li");
      li.textContent = msg;
      ul.appendChild(li);
    });
    errorBanner.innerHTML = "<strong>⚠️ 일부 데이터 수집 안내</strong>";
    errorBanner.appendChild(ul);
  }

  function createMetricBox(label, valueText, extraClass = "") {
    const box = document.createElement("div");
    box.className = "metric-box";

    const labelEl = document.createElement("span");
    labelEl.className = "metric-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = `metric-value ${extraClass}`.trim();
    valueEl.textContent = valueText;

    box.appendChild(labelEl);
    box.appendChild(valueEl);
    return box;
  }

  function renderProfileAndPrice(data) {
    const profile = data.profile || {};
    const price = data.price_info || {};

    document.getElementById("stockMarket").textContent = profile.market || "-";
    document.getElementById("stockName").textContent = profile.name || "종목명 없음";
    document.getElementById("stockCode").textContent = data.code || "-";

    const trendClass = getTrendClass(price.change_price);
    const currentPriceEl = document.getElementById("currentPrice");
    currentPriceEl.textContent = formatNumber(price.current_price, "원");
    currentPriceEl.className = `current-price ${trendClass}`;

    const sign = price.change_price > 0 ? "▲ " : price.change_price < 0 ? "▼ " : "";
    const rateSign = price.change_rate > 0 ? "+" : "";
    const priceChangeEl = document.getElementById("priceChange");
    if (price.change_price !== null && price.change_price !== undefined) {
      priceChangeEl.textContent = `${sign}${formatNumber(Math.abs(price.change_price))}원 (${rateSign}${price.change_rate ?? 0}%)`;
    } else {
      priceChangeEl.textContent = "-";
    }
    priceChangeEl.className = `price-change ${trendClass}`;

    const priceGrid = document.getElementById("priceGrid");
    priceGrid.innerHTML = "";
    priceGrid.appendChild(createMetricBox("전일 종가", formatNumber(price.prev_close, "원")));
    priceGrid.appendChild(createMetricBox("시가", formatNumber(price.open_price, "원")));
    priceGrid.appendChild(createMetricBox("고가", formatNumber(price.high_price, "원"), "up"));
    priceGrid.appendChild(createMetricBox("저가", formatNumber(price.low_price, "원"), "down"));
    priceGrid.appendChild(createMetricBox("52주 최고", formatNumber(price.high_52w, "원")));
    priceGrid.appendChild(createMetricBox("52주 최저", formatNumber(price.low_52w, "원")));
    priceGrid.appendChild(createMetricBox("거래량", formatNumber(price.volume, "주")));
    priceGrid.appendChild(createMetricBox("거래대금", price.trading_value_text || formatNumber(price.trading_value_million, "백만")));
  }

  function renderValuation(data) {
    const val = data.valuation || {};
    const price = data.price_info || {};

    const consensusNote = document.getElementById("consensusDateNote");
    consensusNote.textContent = val.consensus_date ? `컨센서스 기준일: ${val.consensus_date}` : "";

    // 목표주가 괴리율 계산 (표시용)
    let targetGapText = formatNumber(val.target_price, "원");
    if (val.target_price && price.current_price) {
      const gap = (((val.target_price - price.current_price) / price.current_price) * 100).toFixed(1);
      targetGapText += ` (${gap > 0 ? "+" : ""}${gap}%)`;
    }

    const valuationGrid = document.getElementById("valuationGrid");
    valuationGrid.innerHTML = "";
    valuationGrid.appendChild(createMetricBox("시가총액", val.market_cap_text || "-"));
    valuationGrid.appendChild(createMetricBox("외인소진율", formatNumber(val.foreign_rate, "%")));
    valuationGrid.appendChild(createMetricBox("PER (현재)", formatNumber(val.per, "배")));
    valuationGrid.appendChild(createMetricBox("추정PER (미래)", formatNumber(val.cns_per, "배")));
    valuationGrid.appendChild(createMetricBox("EPS (현재)", formatNumber(val.eps, "원")));
    valuationGrid.appendChild(createMetricBox("추정EPS (미래)", formatNumber(val.cns_eps, "원")));
    valuationGrid.appendChild(createMetricBox("PBR / BPS", `${formatNumber(val.pbr, "배")} / ${formatNumber(val.bps, "원")}`));
    valuationGrid.appendChild(createMetricBox("배당수익률 / 주당배당금", `${formatNumber(val.dividend_yield, "%")} / ${formatNumber(val.dps, "원")}`));
    valuationGrid.appendChild(createMetricBox("목표주가 (괴리율)", targetGapText));
    valuationGrid.appendChild(createMetricBox("투자의견 (5점 만점)", formatNumber(val.investment_opinion, "점")));

    const peersList = document.getElementById("peersList");
    peersList.innerHTML = "";
    const peers = val.industry_peers || [];
    if (peers.length === 0) {
      peersList.textContent = "비교 종목 정보 없음";
      return;
    }

    peers.forEach((p) => {
      const chip = document.createElement("span");
      chip.className = "peer-chip";
      const rateClass = getTrendClass(p.change_rate);
      const rateSign = p.change_rate > 0 ? "+" : "";
      chip.innerHTML = `${p.name} (${formatNumber(p.current_price, "원")}) <strong class="${rateClass}">${rateSign}${p.change_rate ?? "-"}%</strong>`;
      peersList.appendChild(chip);
    });
  }

  function renderFinancialTable(tbodyId, rows) {
    const tbody = document.getElementById(tbodyId);
    tbody.innerHTML = "";

    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 11;
      td.textContent = "실적 데이터가 없습니다.";
      td.style.textAlign = "center";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (row.is_consensus) {
        tr.className = "consensus-row";
      }

      const tdPeriod = document.createElement("td");
      tdPeriod.textContent = row.period || "-";
      if (row.is_consensus) {
        const badge = document.createElement("span");
        badge.className = "badge-consensus";
        badge.textContent = "추정(E)";
        tdPeriod.appendChild(badge);
      }
      tr.appendChild(tdPeriod);

      const cells = [
        formatNumber(row.revenue),
        formatNumber(row.operating_income),
        formatNumber(row.net_income),
        formatNumber(row.operating_margin, "%"),
        formatNumber(row.roe, "%"),
        formatNumber(row.debt_ratio, "%"),
        formatNumber(row.eps),
        formatNumber(row.per),
        formatNumber(row.pbr),
        formatNumber(row.dps)
      ];

      cells.forEach((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  function renderNews(news) {
    const newsList = document.getElementById("newsList");
    const newsCountNote = document.getElementById("newsCountNote");
    newsList.innerHTML = "";
    newsCountNote.textContent = `총 ${news.length}건`;

    if (!news || news.length === 0) {
      const li = document.createElement("li");
      li.className = "news-item";
      li.textContent = "수집된 뉴스가 없습니다.";
      newsList.appendChild(li);
      return;
    }

    news.forEach((item) => {
      const li = document.createElement("li");
      li.className = "news-item";

      const a = document.createElement("a");
      a.className = "news-title";
      a.href = item.url || "#";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = item.title || "제목 없음";

      const meta = document.createElement("div");
      meta.className = "news-meta";
      meta.textContent = `${item.source || "언론사"} · ${item.published || ""}`;

      const desc = document.createElement("p");
      desc.className = "news-desc";
      desc.textContent = item.description || "";

      li.appendChild(a);
      li.appendChild(meta);
      li.appendChild(desc);
      newsList.appendChild(li);
    });
  }

  async function fetchStockData(code) {
    if (!code) {
      showErrors(["종목코드를 입력해 주세요."]);
      return;
    }

    console.log(`[SEARCH]  종목 수집 요청 시작 (${code})`);
    searchBtn.disabled = true;
    loadingBox.classList.remove("hidden");
    errorBanner.classList.add("hidden");

    try {
      const response = await fetch("/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });

      const data = await response.json();

      if (!response.ok) {
        console.error(`[ERROR]   수집 중 오류 발생 (${(data.errors || []).join(", ")})`);
        showErrors(data.errors || ["요청 처리에 실패했습니다."]);
        resultSection.classList.add("hidden");
        return;
      }

      const stockName = data.profile?.name || "알 수 없음";
      const currentPrice = data.price_info?.current_price ?? "-";
      console.log(`[PARSED]  기본 정보 및 밸류에이션 수집 완료 (${stockName}, ${currentPrice}원)`);

      const annualList = data.financials?.annual || [];
      const quarterlyList = data.financials?.quarterly || [];
      console.log(`[FINANCE] 연간/분기 실적 데이터 수신 완료 (연간 ${annualList.length}건, 분기 ${quarterlyList.length}건)`);

      const newsList = data.news || [];
      console.log(`[NEWS]    뉴스 수집 완료 (${newsList.length}건)`);

      if (data.errors && data.errors.length > 0) {
        console.warn(`[ERROR]   일부 수집 오류: ${data.errors.join(" / ")}`);
      }
      showErrors(data.errors);

      // 종목명이 정상적으로 수집된 경우에만 결과 카드 렌더링
      if (data.profile && data.profile.name) {
        renderProfileAndPrice(data);
        renderValuation(data);
        renderFinancialTable("annualTableBody", annualList);
        renderFinancialTable("quarterlyTableBody", quarterlyList);
        renderNews(newsList);

        rawJsonOutput.textContent = JSON.stringify(data, null, 2);
        resultSection.classList.remove("hidden");
        console.log("[RENDER]  화면 데이터 카드 렌더링 완료");
      } else {
        resultSection.classList.add("hidden");
      }
    } catch (err) {
      console.error(`[ERROR]   수집 중 오류 발생 (${err.message})`);
      showErrors([`서버 통신 중 오류가 발생했습니다: ${err.message}`]);
      resultSection.classList.add("hidden");
    } finally {
      searchBtn.disabled = false;
      loadingBox.classList.add("hidden");
    }
  }
});
