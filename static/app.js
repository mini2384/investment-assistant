document.addEventListener("DOMContentLoaded", () => {
  console.log("[PAGE]    페이지 로드 및 3탭 초기화 완료 (기본 탭: stock)");

  // =====================================================
  // 1. 탭 전환 UI 로직
  // =====================================================
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;

      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      tabPanels.forEach((panel) => {
        if (panel.id === `tab-${targetTab}`) {
          panel.classList.remove("hidden");
          panel.classList.add("active");
        } else {
          panel.classList.add("hidden");
          panel.classList.remove("active");
        }
      });

      console.log(`[PAGE]    페이지 로드 및 탭 전환 (${targetTab})`);
    });
  });

  // =====================================================
  // 2. 공통 유틸리티 (Step 7 이후 각 탭 구현 시 사용)
  // =====================================================
  window.InvestmentApp = {
    stockConversationId: null,
    taConversationId: null,
    taLatestData: null,

    escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    },

    renderMarkdown(text) {
      if (!text) return "";
      const escaped = this.escapeHtml(text);
      const lines = escaped.split(/\r?\n/);
      let html = "";
      let inUl = false;
      let inOl = false;

      const closeLists = () => {
        if (inUl) { html += "</ul>"; inUl = false; }
        if (inOl) { html += "</ol>"; inOl = false; }
      };

      const inlineFormat = (s) =>
        s
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/`([^`]+)`/g, "<code>$1</code>");

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          closeLists();
          continue;
        }
        if (/^---+$/.test(line)) {
          closeLists();
          html += "<hr />";
          continue;
        }
        const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
        if (hMatch) {
          closeLists();
          const level = Math.min(4, Math.max(2, hMatch[1].length));
          html += `<h${level}>${inlineFormat(hMatch[2])}</h${level}>`;
          continue;
        }
        const ulMatch = line.match(/^[-*•]\s+(.*)$/);
        if (ulMatch) {
          if (inOl) { html += "</ol>"; inOl = false; }
          if (!inUl) { html += "<ul>"; inUl = true; }
          html += `<li>${inlineFormat(ulMatch[1])}</li>`;
          continue;
        }
        const olMatch = line.match(/^\d+\.\s+(.*)$/);
        if (olMatch) {
          if (inUl) { html += "</ul>"; inUl = false; }
          if (!inOl) { html += "<ol>"; inOl = true; }
          html += `<li>${inlineFormat(olMatch[1])}</li>`;
          continue;
        }
        closeLists();
        html += `<p>${inlineFormat(line)}</p>`;
      }
      closeLists();
      return html;
    },

    setBubbleContent(bubble, role, text) {
      if (role === "assistant") {
        bubble.innerHTML = this.renderMarkdown(text);
      } else {
        bubble.textContent = text;
      }
    },

    appendChatMessage(containerEl, role, text) {
      const msgDiv = document.createElement("div");
      msgDiv.className = `chat-msg ${role}`;
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      this.setBubbleContent(bubble, role, text);
      msgDiv.appendChild(bubble);
      containerEl.appendChild(msgDiv);
      containerEl.scrollTop = containerEl.scrollHeight;
      return bubble;
    },

    showError(errorEl, message) {
      if (!message) {
        errorEl.classList.add("hidden");
        errorEl.textContent = "";
        return;
      }
      errorEl.classList.remove("hidden");
      errorEl.textContent = `⚠️ ${message}`;
    },

    formatNumber(val, suffix = "") {
      if (val === null || val === undefined || Number.isNaN(val)) return "-";
      return `${Number(val).toLocaleString("ko-KR")}${suffix}`;
    }
  };

  // 빠른 선택 칩 기본 연결
  document.querySelectorAll(".stock-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.getElementById("stockTabCode").value = chip.dataset.code;
    });
  });

  document.querySelectorAll(".rebal-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.getElementById("rebalCodesInput").value = chip.dataset.codes;
    });
  });

  document.querySelectorAll(".ta-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.getElementById("taCodeInput").value = chip.dataset.code;
    });
  });

  // =====================================================
  // 3. 탭 1: 종목 조회 & AI 심층분석 채팅 (/api/chat/stock)
  // =====================================================
  const stockAnalyzeForm = document.getElementById("stockAnalyzeForm");
  const stockAnalyzeBtn = document.getElementById("stockAnalyzeBtn");
  const stockTabCode = document.getElementById("stockTabCode");
  const stockLoading = document.getElementById("stockLoading");
  const stockDataPanel = document.getElementById("stockDataPanel");
  const stockChatMessages = document.getElementById("stockChatMessages");
  const stockChatForm = document.getElementById("stockChatForm");
  const stockChatInput = document.getElementById("stockChatInput");
  const stockChatSendBtn = document.getElementById("stockChatSendBtn");
  const stockTabError = document.getElementById("stockTabError");
  const resetStockChatBtn = document.getElementById("resetStockChatBtn");

  function getTrendClass(val) {
    if (val === null || val === undefined || val === 0) return "flat";
    return val > 0 ? "up" : "down";
  }

  function createInfoBox(label, valueText, extraClass = "") {
    const box = document.createElement("div");
    box.className = "metric-box";
    const lbl = document.createElement("span");
    lbl.className = "metric-label";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = `metric-value ${extraClass}`.trim();
    val.textContent = valueText;
    box.appendChild(lbl);
    box.appendChild(val);
    return box;
  }

  function renderTab1FinancialRows(tbodyId, rows) {
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
    const fmt = window.InvestmentApp.formatNumber;
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      if (row.is_consensus) tr.className = "consensus-row";

      const tdPeriod = document.createElement("td");
      tdPeriod.textContent = row.period || "-";
      if (row.is_consensus) {
        const badge = document.createElement("span");
        badge.className = "badge-consensus";
        badge.textContent = "추정(E)";
        tdPeriod.appendChild(badge);
      }
      tr.appendChild(tdPeriod);

      [
        fmt(row.revenue),
        fmt(row.operating_income),
        fmt(row.net_income),
        fmt(row.operating_margin, "%"),
        fmt(row.roe, "%"),
        fmt(row.debt_ratio, "%"),
        fmt(row.eps),
        fmt(row.per),
        fmt(row.pbr),
        fmt(row.dps)
      ].forEach((txt) => {
        const td = document.createElement("td");
        td.textContent = txt;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function renderCollectedDataPanel(collected) {
    if (!collected || !collected.profile || !collected.profile.name) return;
    const fmt = window.InvestmentApp.formatNumber;
    const p = collected.profile;
    const price = collected.price_info || {};
    const val = collected.valuation || {};

    document.getElementById("tab1StockMarket").textContent = p.market || "-";
    document.getElementById("tab1StockName").textContent = p.name || "-";
    document.getElementById("tab1StockCode").textContent = collected.code || "-";

    const trendClass = getTrendClass(price.change_price);
    const cpEl = document.getElementById("tab1CurrentPrice");
    cpEl.textContent = fmt(price.current_price, "원");
    cpEl.className = `current-price ${trendClass}`;

    const sign = price.change_price > 0 ? "▲ " : price.change_price < 0 ? "▼ " : "";
    const rateSign = price.change_rate > 0 ? "+" : "";
    const pcEl = document.getElementById("tab1PriceChange");
    pcEl.textContent = price.change_price !== null && price.change_price !== undefined
      ? `${sign}${fmt(Math.abs(price.change_price))}원 (${rateSign}${price.change_rate ?? 0}%)`
      : "-";
    pcEl.className = `price-change ${trendClass}`;

    const priceGrid = document.getElementById("tab1PriceGrid");
    priceGrid.innerHTML = "";
    priceGrid.appendChild(createInfoBox("전일 종가", fmt(price.prev_close, "원")));
    priceGrid.appendChild(createInfoBox("시가", fmt(price.open_price, "원")));
    priceGrid.appendChild(createInfoBox("고가", fmt(price.high_price, "원"), "up"));
    priceGrid.appendChild(createInfoBox("저가", fmt(price.low_price, "원"), "down"));
    priceGrid.appendChild(createInfoBox("52주 최고", fmt(price.high_52w, "원")));
    priceGrid.appendChild(createInfoBox("52주 최저", fmt(price.low_52w, "원")));
    priceGrid.appendChild(createInfoBox("거래량", fmt(price.volume, "주")));
    priceGrid.appendChild(createInfoBox("거래대금", price.trading_value_text || fmt(price.trading_value_million, "백만")));

    document.getElementById("tab1ConsensusDate").textContent = val.consensus_date ? `컨센서스 기준일: ${val.consensus_date}` : "";
    let targetGapText = fmt(val.target_price, "원");
    if (val.target_price && price.current_price) {
      const gap = (((val.target_price - price.current_price) / price.current_price) * 100).toFixed(1);
      targetGapText += ` (${gap > 0 ? "+" : ""}${gap}%)`;
    }

    const valGrid = document.getElementById("tab1ValuationGrid");
    valGrid.innerHTML = "";
    valGrid.appendChild(createInfoBox("시가총액", val.market_cap_text || "-"));
    valGrid.appendChild(createInfoBox("외인소진율", fmt(val.foreign_rate, "%")));
    valGrid.appendChild(createInfoBox("PER (현재)", fmt(val.per, "배")));
    valGrid.appendChild(createInfoBox("추정PER (미래)", fmt(val.cns_per, "배")));
    valGrid.appendChild(createInfoBox("EPS (현재)", fmt(val.eps, "원")));
    valGrid.appendChild(createInfoBox("추정EPS (미래)", fmt(val.cns_eps, "원")));
    valGrid.appendChild(createInfoBox("PBR / BPS", `${fmt(val.pbr, "배")} / ${fmt(val.bps, "원")}`));
    valGrid.appendChild(createInfoBox("배당수익률 / 주당배당금", `${fmt(val.dividend_yield, "%")} / ${fmt(val.dps, "원")}`));
    valGrid.appendChild(createInfoBox("목표주가 (괴리율)", targetGapText));
    valGrid.appendChild(createInfoBox("투자의견 (5점 만점)", fmt(val.investment_opinion, "점")));

    const peersList = document.getElementById("tab1PeersList");
    peersList.innerHTML = "";
    (val.industry_peers || []).forEach((peer) => {
      const chip = document.createElement("span");
      chip.className = "peer-chip";
      const rClass = getTrendClass(peer.change_rate);
      const rSign = peer.change_rate > 0 ? "+" : "";
      chip.innerHTML = `${window.InvestmentApp.escapeHtml(peer.name)} (${fmt(peer.current_price, "원")}) <strong class="${rClass}">${rSign}${peer.change_rate ?? "-"}%</strong>`;
      peersList.appendChild(chip);
    });

    const fin = collected.financials || {};
    renderTab1FinancialRows("tab1AnnualBody", fin.annual || []);
    renderTab1FinancialRows("tab1QuarterlyBody", fin.quarterly || []);

    const newsList = document.getElementById("tab1NewsList");
    newsList.innerHTML = "";
    const newsItems = collected.news || [];
    if (newsItems.length === 0) {
      const li = document.createElement("li");
      li.className = "news-item";
      li.textContent = "수집된 뉴스가 없습니다.";
      newsList.appendChild(li);
    } else {
      newsItems.forEach((n) => {
        const li = document.createElement("li");
        li.className = "news-item";
        const a = document.createElement("a");
        a.className = "news-title";
        a.href = n.url || "#";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = n.title || "제목 없음";
        const meta = document.createElement("div");
        meta.className = "news-meta";
        meta.textContent = `${n.source || "언론사"} · ${n.published || ""}`;
        const desc = document.createElement("p");
        desc.className = "news-desc";
        desc.textContent = n.description || "";
        li.appendChild(a);
        li.appendChild(meta);
        li.appendChild(desc);
        newsList.appendChild(li);
      });
    }

    stockDataPanel.classList.remove("hidden");
  }

  function resetStockChat() {
    window.InvestmentApp.stockConversationId = null;
    stockDataPanel.classList.add("hidden");
    window.InvestmentApp.showError(stockTabError, "");
    stockChatMessages.innerHTML = "";
    window.InvestmentApp.appendChatMessage(
      stockChatMessages,
      "assistant",
      "새 대화가 시작되었습니다. 위에서 종목코드를 선택하고 **종목 조회 & AI 분석** 버튼을 눌러주세요!"
    );
  }

  resetStockChatBtn.addEventListener("click", resetStockChat);

  async function runInitialStockAnalysis(code) {
    if (!code) {
      window.InvestmentApp.showError(stockTabError, "종목코드 6자리를 입력해 주세요.");
      return;
    }

    window.InvestmentApp.stockConversationId = null;
    window.InvestmentApp.showError(stockTabError, "");
    stockAnalyzeBtn.disabled = true;
    stockChatSendBtn.disabled = true;
    stockLoading.classList.remove("hidden");

    stockChatMessages.innerHTML = "";
    const loadingBubble = window.InvestmentApp.appendChatMessage(
      stockChatMessages,
      "assistant",
      `\`${code}\` 데이터를 수집하고 AI 애널리스트 1차 종합 리포트를 작성 중입니다...`
    );

    console.log(`[SEARCH]  종목 조회 및 AI 1차 심층분석 시작 (code=${code})`);

    try {
      const res = await fetch("/api/chat/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, mode: "initial_analysis" })
      });
      const data = await res.json();

      if (data.collected) {
        renderCollectedDataPanel(data.collected);
      }

      if (!res.ok) {
        window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `오류: ${data.error || "분석 요청에 실패했습니다."}`);
        window.InvestmentApp.showError(stockTabError, data.error || "분석 요청에 실패했습니다.");
        console.error(`[ERROR]   탭1 1차 분석 실패: ${data.error}`);
        return;
      }

      window.InvestmentApp.stockConversationId = data.conversation_id;
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", data.answer || "(응답 내용이 비어 있습니다.)");
      console.log(`[DIFY]    1차 심층분석 리포트 수신 완료 (conversation_id=${data.conversation_id})`);
    } catch (err) {
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `통신 오류: ${err.message}`);
      window.InvestmentApp.showError(stockTabError, `서버 통신 오류: ${err.message}`);
      console.error(`[ERROR]   탭1 통신 오류: ${err.message}`);
    } finally {
      stockAnalyzeBtn.disabled = false;
      stockChatSendBtn.disabled = false;
      stockLoading.classList.add("hidden");
      stockChatMessages.scrollTop = stockChatMessages.scrollHeight;
    }
  }

  stockAnalyzeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    runInitialStockAnalysis(stockTabCode.value.trim());
  });

  // 빠른 선택 칩 클릭 시 바로 조회 & AI 분석 실행
  document.querySelectorAll(".stock-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const code = chip.dataset.code;
      stockTabCode.value = code;
      runInitialStockAnalysis(code);
    });
  });

  stockChatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = stockTabCode.value.trim();
    const query = stockChatInput.value.trim();
    if (!query) return;

    window.InvestmentApp.showError(stockTabError, "");
    window.InvestmentApp.appendChatMessage(stockChatMessages, "user", query);
    stockChatInput.value = "";
    stockChatSendBtn.disabled = true;

    const loadingBubble = window.InvestmentApp.appendChatMessage(
      stockChatMessages,
      "assistant",
      "답변을 생성하고 있습니다..."
    );

    console.log(`[SEARCH]  탭1 후속 질문 전송 (code=${code}, conv=${window.InvestmentApp.stockConversationId || "NEW"})`);

    try {
      const res = await fetch("/api/chat/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          query,
          mode: "chat",
          conversation_id: window.InvestmentApp.stockConversationId || ""
        })
      });
      const data = await res.json();

      if (data.collected) {
        renderCollectedDataPanel(data.collected);
      }

      if (!res.ok) {
        window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `오류: ${data.error || "요청 처리에 실패했습니다."}`);
        window.InvestmentApp.showError(stockTabError, data.error || "요청 처리에 실패했습니다.");
        console.error(`[ERROR]   탭1 요청 실패: ${data.error}`);
        return;
      }

      window.InvestmentApp.stockConversationId = data.conversation_id;
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", data.answer || "(응답 내용이 비어 있습니다.)");
      console.log(`[DIFY]    Dify 응답 수신 (conversation_id=${data.conversation_id})`);
    } catch (err) {
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `통신 오류: ${err.message}`);
      window.InvestmentApp.showError(stockTabError, `서버 통신 오류: ${err.message}`);
      console.error(`[ERROR]   탭1 통신 오류: ${err.message}`);
    } finally {
      stockChatSendBtn.disabled = false;
      stockChatMessages.scrollTop = stockChatMessages.scrollHeight;
    }
  });

  // =====================================================
  // 4. 탭 2: 리밸런싱 도우미 (/api/rebalance) — Dify 미사용
  // =====================================================
  const rebalanceForm = document.getElementById("rebalanceForm");
  const rebalCodesInput = document.getElementById("rebalCodesInput");
  const rebalCalcBtn = document.getElementById("rebalCalcBtn");
  const rebalLoading = document.getElementById("rebalLoading");
  const rebalTabError = document.getElementById("rebalTabError");
  const rebalResultBox = document.getElementById("rebalResultBox");
  const rebalMetricsGrid = document.getElementById("rebalMetricsGrid");
  const rebalWeightsGrid = document.getElementById("rebalWeightsGrid");

  let frontierChartInstance = null;
  let weightChartInstance = null;

  function createRebalMetric(label, valueText) {
    const box = document.createElement("div");
    box.className = "metric-box";
    const lbl = document.createElement("span");
    lbl.className = "metric-label";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = "metric-value";
    val.textContent = valueText;
    box.appendChild(lbl);
    box.appendChild(val);
    return box;
  }

  function renderRebalanceResult(data) {
    const best = data.max_sharpe;
    rebalMetricsGrid.innerHTML = "";
    rebalMetricsGrid.appendChild(createRebalMetric("분석 기간 (거래일)", `${data.period} (${data.trading_days}일)`));
    rebalMetricsGrid.appendChild(createRebalMetric("연 기대수익률", `${best.expected_return}%`));
    rebalMetricsGrid.appendChild(createRebalMetric("연 변동성 (위험)", `${best.volatility}%`));
    rebalMetricsGrid.appendChild(createRebalMetric("샤프 지수 (가성비)", `${best.sharpe_ratio}`));
    rebalMetricsGrid.appendChild(createRebalMetric("최대낙폭 (MDD)", `${best.mdd}%`));

    rebalWeightsGrid.innerHTML = "";
    best.weights.forEach((w) => {
      rebalWeightsGrid.appendChild(createRebalMetric(`${w.name} (${w.code})`, `${w.weight}%`));
    });

    // 효율적 프론티어 산점도 차트
    if (frontierChartInstance) frontierChartInstance.destroy();
    const frontierCtx = document.getElementById("rebalFrontierChart").getContext("2d");
    frontierChartInstance = new Chart(frontierCtx, {
      type: "scatter",
      data: {
        datasets: [
          {
            label: "시뮬레이션 포트폴리오",
            data: (data.frontier_points || []).map((pt) => ({ x: pt.volatility, y: pt.expected_return })),
            backgroundColor: "rgba(148, 163, 184, 0.55)",
            pointRadius: 3
          },
          {
            label: "최대 샤프지수 (추천)",
            data: [{ x: best.volatility, y: best.expected_return }],
            backgroundColor: "#dc2626",
            pointRadius: 8
          },
          {
            label: "최소 변동성",
            data: [{ x: data.min_volatility.volatility, y: data.min_volatility.expected_return }],
            backgroundColor: "#2563eb",
            pointRadius: 8
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: "연 변동성 (%)" } },
          y: { title: { display: true, text: "연 기대수익률 (%)" } }
        }
      }
    });

    // 권장 비중 도넛 차트
    if (weightChartInstance) weightChartInstance.destroy();
    const weightCtx = document.getElementById("rebalWeightChart").getContext("2d");
    weightChartInstance = new Chart(weightCtx, {
      type: "doughnut",
      data: {
        labels: best.weights.map((w) => `${w.name} (${w.weight}%)`),
        datasets: [{
          data: best.weights.map((w) => w.weight),
          backgroundColor: ["#2563eb", "#dc2626", "#16a34a", "#f59e0b", "#8b5cf6", "#06b6d4"]
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });

    rebalResultBox.classList.remove("hidden");
  }

  rebalanceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const codesText = rebalCodesInput.value.trim();
    window.InvestmentApp.showError(rebalTabError, "");
    rebalCalcBtn.disabled = true;
    rebalLoading.classList.remove("hidden");
    console.log(`[REBAL]   리밸런싱 계산 요청 시작 (${codesText})`);

    try {
      const res = await fetch("/api/rebalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: codesText })
      });
      const data = await res.json();

      if (!res.ok) {
        window.InvestmentApp.showError(rebalTabError, data.error || "리밸런싱 계산에 실패했습니다.");
        rebalResultBox.classList.add("hidden");
        console.error(`[ERROR]   리밸런싱 계산 실패: ${data.error}`);
        return;
      }

      renderRebalanceResult(data);
      console.log(`[REBAL]   리밸런싱 계산 및 시각화 완료 (샤프=${data.max_sharpe.sharpe_ratio})`);
    } catch (err) {
      window.InvestmentApp.showError(rebalTabError, `서버 통신 오류: ${err.message}`);
      console.error(`[ERROR]   리밸런싱 통신 오류: ${err.message}`);
    } finally {
      rebalCalcBtn.disabled = false;
      rebalLoading.classList.add("hidden");
    }
  });

  // =====================================================
  // 5. 탭 3: 기술지표 차트 + AI 해석 채팅 (/api/ta/chart, /api/chat/ta)
  // =====================================================
  const taForm = document.getElementById("taForm");
  const taCodeInput = document.getElementById("taCodeInput");
  const taLoadBtn = document.getElementById("taLoadBtn");
  const taLoading = document.getElementById("taLoading");
  const taTabError = document.getElementById("taTabError");
  const taResultBox = document.getElementById("taResultBox");
  const taSummaryGrid = document.getElementById("taSummaryGrid");
  const taChatMessages = document.getElementById("taChatMessages");
  const taChatForm = document.getElementById("taChatForm");
  const taChatInput = document.getElementById("taChatInput");
  const taChatSendBtn = document.getElementById("taChatSendBtn");
  const resetTaChatBtn = document.getElementById("resetTaChatBtn");

  let taPriceChartInstance = null;
  let taRsiChartInstance = null;

  function resetTaChat() {
    window.InvestmentApp.taConversationId = null;
    taChatMessages.innerHTML = "";
    window.InvestmentApp.appendChatMessage(
      taChatMessages,
      "assistant",
      "새 대화가 시작되었습니다. 계산된 RSI, 이동평균선, 볼린저밴드 수치에 대해 질문해 보세요!"
    );
  }

  resetTaChatBtn.addEventListener("click", resetTaChat);

  function renderTaCharts(data) {
    const s = data.summary;
    const series = data.series;
    window.InvestmentApp.taLatestData = s;

    taSummaryGrid.innerHTML = "";
    const summaryItems = [
      ["종목 (기준일)", `${s.name} (${s.date})`],
      ["종가", window.InvestmentApp.formatNumber(s.close, "원")],
      ["MA5 / MA20", `${window.InvestmentApp.formatNumber(s.ma5)} / ${window.InvestmentApp.formatNumber(s.ma20)}`],
      ["MA60 / MA120", `${window.InvestmentApp.formatNumber(s.ma60)} / ${window.InvestmentApp.formatNumber(s.ma120)}`],
      ["볼린저 상단 / 하단", `${window.InvestmentApp.formatNumber(s.bb_upper)} / ${window.InvestmentApp.formatNumber(s.bb_lower)}`],
      ["RSI (14)", s.rsi14 !== null ? `${s.rsi14}` : "-"],
      ["MACD / Signal", `${s.macd ?? "-"} / ${s.macd_signal ?? "-"}`]
    ];
    summaryItems.forEach(([label, val]) => {
      taSummaryGrid.appendChild(createRebalMetric(label, val));
    });

    if (taPriceChartInstance) taPriceChartInstance.destroy();
    const priceCtx = document.getElementById("taPriceChart").getContext("2d");
    taPriceChartInstance = new Chart(priceCtx, {
      type: "line",
      data: {
        labels: series.dates,
        datasets: [
          { label: "종가", data: series.close, borderColor: "#0f172a", borderWidth: 2, pointRadius: 0 },
          { label: "MA20", data: series.ma20, borderColor: "#2563eb", borderWidth: 1.5, pointRadius: 0 },
          { label: "MA60", data: series.ma60, borderColor: "#f59e0b", borderWidth: 1.5, pointRadius: 0 },
          { label: "볼린저 상단", data: series.bb_upper, borderColor: "#dc2626", borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
          { label: "볼린저 하단", data: series.bb_lower, borderColor: "#16a34a", borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false }
      }
    });

    if (taRsiChartInstance) taRsiChartInstance.destroy();
    const rsiCtx = document.getElementById("taRsiChart").getContext("2d");
    taRsiChartInstance = new Chart(rsiCtx, {
      type: "line",
      data: {
        labels: series.dates,
        datasets: [
          { label: "RSI (14)", data: series.rsi14, borderColor: "#8b5cf6", borderWidth: 2, pointRadius: 0 },
          { label: "과매수(70)", data: series.dates.map(() => 70), borderColor: "#dc2626", borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
          { label: "과매도(30)", data: series.dates.map(() => 30), borderColor: "#2563eb", borderDash: [4, 4], borderWidth: 1, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { min: 0, max: 100 } }
      }
    });

    taResultBox.classList.remove("hidden");
  }

  taForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = taCodeInput.value.trim();
    window.InvestmentApp.showError(taTabError, "");
    taLoadBtn.disabled = true;
    taLoading.classList.remove("hidden");

    try {
      const res = await fetch("/api/ta/chart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });
      const data = await res.json();

      if (!res.ok) {
        window.InvestmentApp.showError(taTabError, data.error || "기술지표 조회에 실패했습니다.");
        taResultBox.classList.add("hidden");
        console.error(`[ERROR]   기술지표 조회 실패: ${data.error}`);
        return;
      }

      window.InvestmentApp.taConversationId = null;
      renderTaCharts(data);
      console.log(`[TA]      기술 지표 차트 렌더링 완료 (code=${code}, RSI=${data.summary.rsi14})`);
    } catch (err) {
      window.InvestmentApp.showError(taTabError, `서버 통신 오류: ${err.message}`);
      console.error(`[ERROR]   기술지표 통신 오류: ${err.message}`);
    } finally {
      taLoadBtn.disabled = false;
      taLoading.classList.add("hidden");
    }
  });

  taChatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = taChatInput.value.trim();
    if (!query) return;

    const code = taCodeInput.value.trim();
    window.InvestmentApp.showError(taTabError, "");
    window.InvestmentApp.appendChatMessage(taChatMessages, "user", query);
    taChatInput.value = "";
    taChatSendBtn.disabled = true;

    const loadingBubble = window.InvestmentApp.appendChatMessage(
      taChatMessages,
      "assistant",
      "계산된 기술지표 숫자를 바탕으로 Dify 지표설명기가 해석 중입니다..."
    );

    try {
      const res = await fetch("/api/chat/ta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          query,
          indicators: window.InvestmentApp.taLatestData,
          conversation_id: window.InvestmentApp.taConversationId || ""
        })
      });
      const data = await res.json();

      if (!res.ok) {
        window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `오류: ${data.error || "요청 처리에 실패했습니다."}`);
        window.InvestmentApp.showError(taTabError, data.error || "요청 처리에 실패했습니다.");
        console.error(`[ERROR]   탭3 채팅 실패: ${data.error}`);
        return;
      }

      window.InvestmentApp.taConversationId = data.conversation_id;
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", data.answer || "(응답 내용이 비어 있습니다.)");
      console.log(`[DIFY]    Dify 지표설명기 응답 수신 (conversation_id=${data.conversation_id})`);
    } catch (err) {
      window.InvestmentApp.setBubbleContent(loadingBubble, "assistant", `통신 오류: ${err.message}`);
      window.InvestmentApp.showError(taTabError, `서버 통신 오류: ${err.message}`);
      console.error(`[ERROR]   탭3 통신 오류: ${err.message}`);
    } finally {
      taChatSendBtn.disabled = false;
      taChatMessages.scrollTop = taChatMessages.scrollHeight;
    }
  });
});
