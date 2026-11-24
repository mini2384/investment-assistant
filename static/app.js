document.addEventListener("DOMContentLoaded", () => {
  console.log("[PAGE]    페이지 로드 및 3탭 초기화 완료 (기본 탭: stock)");

  // =====================================================
  // 1. 탭 전환 UI 로직
  // =====================================================
  const tabButtons = document.querySelectorAll(".tab-btn[data-tab]");
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
  const levelButtons = document.querySelectorAll(".level-btn");
  const pinnedStocksRow = document.getElementById("pinnedStocksRow");
  const pinnedStocksList = document.getElementById("pinnedStocksList");
  const PINNED_STORAGE_KEY = "investment_assistant_pinned_stocks_v1";
  let stockExplainLevel = "intermediate";
  let lastCollectedData = null;

  function loadPinnedStocks() {
    try {
      const raw = localStorage.getItem(PINNED_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function savePinnedStocks(list) {
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // ignore storage errors
    }
  }

  function renderPinnedStocks() {
    const pinned = loadPinnedStocks();
    const pinnedCodes = new Set(pinned.map((item) => item.code));

    document.querySelectorAll(".pin-btn").forEach((btn) => {
      const isPinned = pinnedCodes.has(btn.dataset.code);
      btn.classList.toggle("pinned", isPinned);
      btn.title = isPinned ? "관심종목 고정 해제" : "관심종목 고정";
    });

    if (!pinnedStocksRow || !pinnedStocksList) return;
    pinnedStocksList.innerHTML = "";

    if (pinned.length === 0) {
      pinnedStocksRow.classList.add("hidden");
      return;
    }

    pinned.forEach((item) => {
      const group = document.createElement("span");
      group.className = "chip-group pinned-chip-group";

      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip-btn";
      chip.textContent = item.label || item.code;
      chip.addEventListener("click", () => {
        stockTabCode.value = item.code;
        runInitialStockAnalysis(item.code);
      });

      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.className = "pin-btn pinned";
      unpin.textContent = "✕";
      unpin.title = "고정 해제";
      unpin.addEventListener("click", () => togglePinnedStock(item.code, item.label));

      group.appendChild(chip);
      group.appendChild(unpin);
      pinnedStocksList.appendChild(group);
    });

    pinnedStocksRow.classList.remove("hidden");
  }

  function togglePinnedStock(code, label) {
    if (!code) return;
    const pinned = loadPinnedStocks();
    const idx = pinned.findIndex((item) => item.code === code);
    if (idx >= 0) {
      pinned.splice(idx, 1);
    } else {
      pinned.push({ code, label: label || code });
    }
    savePinnedStocks(pinned);
    renderPinnedStocks();
  }

  document.querySelectorAll(".pin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      togglePinnedStock(btn.dataset.code, btn.dataset.label);
    });
  });

  renderPinnedStocks();

  levelButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      stockExplainLevel = btn.dataset.level || "intermediate";
      levelButtons.forEach((b) => b.classList.toggle("active", b === btn));
      if (lastCollectedData) {
        renderLevelGuides(lastCollectedData, stockExplainLevel);
      }
    });
  });

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

  function formatCurrencyValue(val, currency) {
    const fmt = window.InvestmentApp.formatNumber;
    if (val === null || val === undefined) return "-";
    if (!currency || currency === "KRW") return fmt(val, "원");
    if (currency === "USD") return `$${fmt(val)}`;
    return fmt(val, ` ${currency}`);
  }

  function renderConsensusWidget(code, val, profile) {
    const widget = document.getElementById("tab1ConsensusWidget");
    if (!widget) return;

    const score = Number(val.investment_opinion);
    const hasScore = Number.isFinite(score) && score > 0;
    const hasTarget = val.target_price !== null && val.target_price !== undefined;

    if (!hasScore && !hasTarget) {
      widget.classList.add("hidden");
      return;
    }

    const isGlobal = Boolean(profile && profile.is_global);
    const currency = (profile && profile.currency) || "KRW";
    const link = document.getElementById("tab1ConsensusLink");
    if (link && code) {
      if (isGlobal) {
        const rc = (profile && profile.reuters_code) || code;
        link.href = `https://m.stock.naver.com/worldstock/stock/${rc}/consensus`;
      } else {
        link.href = `https://stock.naver.com/domestic/stock/${code}/info/consensus`;
      }
    }

    let activeStep = 0;
    if (hasScore) {
      if (score <= 1.5) activeStep = 1;
      else if (score <= 2.5) activeStep = 2;
      else if (score <= 3.5) activeStep = 3;
      else if (score <= 4.5) activeStep = 4;
      else activeStep = 5;
    }

    document.querySelectorAll("#tab1ConsensusGraph .consensus-step").forEach((el) => {
      const stepNum = Number(el.dataset.step);
      el.className = "consensus-step";
      const scoreEl = el.querySelector(".consensus-score");
      if (stepNum === activeStep) {
        el.classList.add("active", `step-${stepNum}`);
        if (scoreEl) scoreEl.textContent = score.toFixed(2);
      } else if (scoreEl) {
        scoreEl.textContent = "";
      }
    });

    const targetEl = document.getElementById("tab1ConsensusTargetPrice");
    if (targetEl) {
      targetEl.textContent = hasTarget ? formatCurrencyValue(val.target_price, currency) : "-";
    }

    const dateEl = document.getElementById("tab1ConsensusProviderDate");
    if (dateEl) {
      const provider = isGlobal ? "네이버 해외증권 컨센서스" : "에프앤가이드 제공";
      dateEl.textContent = val.consensus_date
        ? `${val.consensus_date} 기준 · ${provider}`
        : provider;
    }

    widget.classList.remove("hidden");
  }

  function renderLevelGuides(collected, level) {
    const widgetGuide = document.getElementById("tab1ConsensusGuide");
    const tableGuide = document.getElementById("tab1ConsensusTableGuide");
    if (!collected) return;

    const fmt = window.InvestmentApp.formatNumber;
    const esc = window.InvestmentApp.escapeHtml;
    const val = collected.valuation || {};
    const price = collected.price_info || {};
    const cRows = collected.consensus_table || [];
    const name = (collected.profile && collected.profile.name) || "이 종목";

    const levelLabels = {
      beginner: "🌱 초급 가이드",
      intermediate: "📘 중급 가이드",
      advanced: "🧠 고급 가이드"
    };
    const badgeText = levelLabels[level] || levelLabels.intermediate;

    const score = Number(val.investment_opinion);
    const hasScore = Number.isFinite(score) && score > 0;
    const opinionLabel = !hasScore
      ? "정보 없음"
      : score <= 1.5 ? "적극매도"
      : score <= 2.5 ? "매도"
      : score <= 3.5 ? "중립"
      : score <= 4.5 ? "매수"
      : "적극매수";

    const hasTarget = val.target_price !== null && val.target_price !== undefined;
    const hasCurrent = price.current_price !== null && price.current_price !== undefined;
    const gapPct = (hasTarget && hasCurrent && price.current_price > 0)
      ? (((val.target_price - price.current_price) / price.current_price) * 100).toFixed(1)
      : null;

    if (widgetGuide) {
      if (!hasScore && !hasTarget) {
        widgetGuide.classList.add("hidden");
      } else {
        let concept = "";
        let reading = "";

        const currency = (collected.profile && collected.profile.currency) || "KRW";
        const targetText = hasTarget ? formatCurrencyValue(val.target_price, currency) : "-";
        const currentText = hasCurrent ? formatCurrencyValue(price.current_price, currency) : "-";

        if (level === "beginner") {
          const multText = gapPct !== null && Number(gapPct) > 0
            ? ` (약 ${(1 + Number(gapPct) / 100).toFixed(1)}배)`
            : "";
          const priceCompareText = (hasCurrent && hasTarget)
            ? ` 현재 실시간 <strong>${currentText}</strong>인데 추후 <strong>${targetText}${multText}</strong>가 될 것이라고 보는 셈이에요!`
            : "";
          concept = "<strong>컨센서스란?</strong> 주식 전문가 선생님들이 이 회사를 보고 매긴 <strong>'5점 만점 추천 점수'와 '앞으로 예상 가격(목표주가)'</strong>이에요.";
          reading = `<strong>지금 표에서 읽을 수 있는 점:</strong> 전문가 선생님들이 5점 만점에 <strong>${hasScore ? `${score.toFixed(2)}점` : "-"} (${opinionLabel})</strong>을 주면서, 목표주가를 <strong>${targetText}</strong>로 보고 있어요.${gapPct !== null ? ` 현재 가격 대비 <strong>${gapPct > 0 ? `+${gapPct}%` : `${gapPct}%`}</strong> 차이예요.${priceCompareText}` : ""} <em>(단, 날씨 예보처럼 예상일 뿐이라 100% 그대로 된다는 보장은 없어요!)</em>`;
        } else if (level === "advanced") {
          concept = "<strong>컨센서스 해석:</strong> 최근 3개월 커버리지 증권사 추정치의 평균으로, 시장이 이미 주가에 선반영 중인 기대치(Market Expectation)의 기준선입니다.";
          reading = `<strong>핵심 시사점:</strong> 투자의견 <strong>${opinionLabel}${hasScore ? ` (${score.toFixed(2)})` : ""}</strong>, 목표주가 <strong>${targetText}</strong>${gapPct !== null ? ` (현 주가 대비 괴리율 <strong>${gapPct > 0 ? `+${gapPct}%` : `${gapPct}%`}</strong>)` : ""}입니다. 괴리율이 클수록 실적 가시성 확인 시 리레이팅 여력이 크지만, 추정치 하향(Earnings Revision) 리스크도 함께 점검해야 합니다.`;
        } else {
          concept = "<strong>컨센서스란?</strong> 최근 3개월간 증권사 애널리스트들이 제시한 투자의견(5점 만점)과 목표주가의 평균값입니다.";
          reading = `<strong>이 위젯에서 읽을 정보:</strong> 현재 투자의견은 <strong>${opinionLabel}${hasScore ? ` (${score.toFixed(2)}점)` : ""}</strong>, 목표주가는 <strong>${targetText}</strong>입니다.${gapPct !== null ? ` 현재가(${currentText}) 대비 괴리율은 <strong>${gapPct > 0 ? `+${gapPct}%` : `${gapPct}%`}</strong>로 시장의 기대 수준을 가늠할 수 있습니다.` : ""}`;
        }

        widgetGuide.innerHTML = `<span class="guide-badge">${badgeText}</span><p>${concept}</p><p>${reading}</p>`;
        widgetGuide.classList.remove("hidden");
      }
    }

    if (tableGuide) {
      if (cRows.length === 0) {
        tableGuide.classList.add("hidden");
      } else {
        const estRows = cRows.filter((r) => r.is_consensus);
        const firstEst = estRows[0];
        const lastEst = estRows[estRows.length - 1];
        const lastActual = [...cRows].reverse().find((r) => !r.is_consensus);

        let concept = "";
        let reading = "";

        if (level === "beginner") {
          concept = "<strong>컨센서스 표란?</strong> <code>(A)</code>는 실제로 이미 나온 성적표이고, <code>(E)</code>는 앞으로 벌 것으로 예상되는 성적표예요. <strong>YoY</strong>는 작년보다 매출이 몇 % 늘었는지, <strong>PER/PBR</strong>은 주가가 이익·자산에 비해 비싼지 싼지를 뜻해요.";
          if (firstEst) {
            reading = `<strong>지금 표에서 읽을 수 있는 점:</strong> ${esc(name)}의 <strong>${esc(firstEst.period)}</strong> 예상 매출은 <strong>${fmt(firstEst.revenue, "억원")}</strong>(전년 대비 <strong>${firstEst.yoy ?? "-"}%</strong>), 예상 영업이익은 <strong>${fmt(firstEst.operating_income, "억원")}</strong>입니다.${lastEst && lastEst !== firstEst ? ` <strong>${esc(lastEst.period)}</strong>까지 매출이 ${fmt(lastEst.revenue, "억원")}으로 성장할 것으로 기대되고 있어요.` : ""}`;
          } else {
            reading = `<strong>지금 표에서 읽을 수 있는 점:</strong> 과거 <code>(A)</code> 실적 흐름을 통해 매출과 영업이익이 꾸준히 늘고 있는지 확인할 수 있습니다.`;
          }
        } else if (level === "advanced") {
          concept = "<strong>컨센서스 시계열(cTB511):</strong> 확정 실적<code>(A)</code>과 향후 추정치<code>(E)</code>를 연결해 탑라인 성장률(YoY), 이익 레버리지(OP/NP), 멀티플(PER·PBR·EV/EBITDA) 및 ROE 변화를 한눈에 비교하는 표입니다.";
          if (firstEst) {
            const perTrend = (lastActual && lastActual.per && lastEst && lastEst.per)
              ? ` PER은 ${esc(lastActual.period)} <strong>${lastActual.per}배</strong> → ${esc(lastEst.period)} <strong>${lastEst.per}배</strong>로 ${lastEst.per < lastActual.per ? "이익 증가에 따른 멀티플 하향(밸류 부담 완화)" : "변화"}가 예상됩니다.`
              : "";
            reading = `<strong>핵심 시사점:</strong> ${esc(firstEst.period)} 매출 YoY <strong>${firstEst.yoy ?? "-"}%</strong>, 영업이익 <strong>${fmt(firstEst.operating_income, "억원")}</strong>, ROE <strong>${firstEst.roe ?? "-"}%</strong>, EV/EBITDA <strong>${firstEst.ev_ebitda ?? "-"}배</strong>가 컨센서스입니다.${perTrend}`;
          } else {
            reading = `<strong>핵심 시사점:</strong> 확정 실적 기준 ROE·EV/EBITDA 추이를 통해 자본효율성과 현금창출력 대비 밸류에이션 수준을 점검할 수 있습니다.`;
          }
        } else {
          concept = "<strong>컨센서스 표란?</strong> 과거 확정 실적<code>(A)</code>과 향후 증권사 추정 실적<code>(E)</code>을 나란히 두고 매출 성장률(YoY), 영업이익, 주당지표(EPS/BPS), 밸류에이션(PER/PBR/EV·EBITDA)을 비교하는 표입니다.";
          if (firstEst) {
            reading = `<strong>이 표에서 읽을 정보:</strong> <strong>${esc(firstEst.period)}</strong> 기준 매출액 <strong>${fmt(firstEst.revenue, "억원")}</strong>(YoY <strong>${firstEst.yoy ?? "-"}%</strong>), 영업이익 <strong>${fmt(firstEst.operating_income, "억원")}</strong>, 예상 PER <strong>${firstEst.per ?? "-"}배</strong>, ROE <strong>${firstEst.roe ?? "-"}%</strong>가 전망됩니다.${lastEst && lastEst !== firstEst ? ` (${esc(lastEst.period)} 예상 영업이익 ${fmt(lastEst.operating_income, "억원")})` : ""}`;
          } else {
            reading = `<strong>이 표에서 읽을 정보:</strong> 연도별 매출·영업이익 증감과 PER·PBR·ROE 추이를 통해 실적 성장성과 주가 수준을 함께 확인할 수 있습니다.`;
          }
        }

        tableGuide.innerHTML = `<span class="guide-badge">${badgeText}</span><p>${concept}</p><p>${reading}</p>`;
        tableGuide.classList.remove("hidden");
      }
    }
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

  function renderTab1ConsensusRows(tbodyId, rows) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!rows || rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 12;
      td.textContent = "컨센서스 데이터가 없습니다.";
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
        fmt(row.yoy, "%"),
        fmt(row.operating_income),
        fmt(row.net_income),
        fmt(row.eps),
        fmt(row.bps),
        fmt(row.per),
        fmt(row.pbr),
        fmt(row.roe, "%"),
        fmt(row.ev_ebitda),
        row.accounting_standard || "-"
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
    lastCollectedData = collected;
    const fmt = window.InvestmentApp.formatNumber;
    const p = collected.profile;
    const price = collected.price_info || {};
    const val = collected.valuation || {};
    const currency = p.currency || "KRW";
    const fmtCur = (v) => formatCurrencyValue(v, currency);

    document.getElementById("tab1StockMarket").textContent = p.nation && p.is_global ? `${p.nation} · ${p.market || "-"}` : (p.market || "-");
    document.getElementById("tab1StockName").textContent = p.name || "-";
    document.getElementById("tab1StockCode").textContent = collected.code || "-";

    const trendClass = getTrendClass(price.change_price);
    const cpEl = document.getElementById("tab1CurrentPrice");
    cpEl.textContent = fmtCur(price.current_price);
    cpEl.className = `current-price ${trendClass}`;

    const sign = price.change_price > 0 ? "▲ " : price.change_price < 0 ? "▼ " : "";
    const rateSign = price.change_rate > 0 ? "+" : "";
    const pcEl = document.getElementById("tab1PriceChange");
    pcEl.textContent = price.change_price !== null && price.change_price !== undefined
      ? `${sign}${fmtCur(Math.abs(price.change_price))} (${rateSign}${price.change_rate ?? 0}%)`
      : "-";
    pcEl.className = `price-change ${trendClass}`;

    const priceGrid = document.getElementById("tab1PriceGrid");
    priceGrid.innerHTML = "";
    priceGrid.appendChild(createInfoBox("전일 종가", fmtCur(price.prev_close)));
    priceGrid.appendChild(createInfoBox("시가", fmtCur(price.open_price)));
    priceGrid.appendChild(createInfoBox("고가", fmtCur(price.high_price), "up"));
    priceGrid.appendChild(createInfoBox("저가", fmtCur(price.low_price), "down"));
    priceGrid.appendChild(createInfoBox("52주 최고", fmtCur(price.high_52w)));
    priceGrid.appendChild(createInfoBox("52주 최저", fmtCur(price.low_52w)));
    priceGrid.appendChild(createInfoBox("거래량", fmt(price.volume, "주")));
    priceGrid.appendChild(createInfoBox("거래대금", price.trading_value_text || fmt(price.trading_value_million, "백만")));

    document.getElementById("tab1ConsensusDate").textContent = val.consensus_date ? `컨센서스 기준일: ${val.consensus_date}` : "";
    let targetGapText = fmtCur(val.target_price);
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
    valGrid.appendChild(createInfoBox("EPS (현재)", fmtCur(val.eps)));
    valGrid.appendChild(createInfoBox("추정EPS (미래)", fmtCur(val.cns_eps)));
    valGrid.appendChild(createInfoBox("PBR / BPS", `${fmt(val.pbr, "배")} / ${fmtCur(val.bps)}`));
    valGrid.appendChild(createInfoBox("배당수익률 / 주당배당금", `${fmt(val.dividend_yield, "%")} / ${fmtCur(val.dps)}`));
    valGrid.appendChild(createInfoBox("목표주가 (괴리율)", targetGapText));
    valGrid.appendChild(createInfoBox("투자의견 (5점 만점)", fmt(val.investment_opinion, "점")));

    renderConsensusWidget(collected.code, val, p);

    const peersList = document.getElementById("tab1PeersList");
    peersList.innerHTML = "";
    (val.industry_peers || []).forEach((peer) => {
      const chip = document.createElement("span");
      chip.className = "peer-chip";
      const rClass = getTrendClass(peer.change_rate);
      const rSign = peer.change_rate > 0 ? "+" : "";
      chip.innerHTML = `${window.InvestmentApp.escapeHtml(peer.name)} (${fmtCur(peer.current_price)}) <strong class="${rClass}">${rSign}${peer.change_rate ?? "-"}%</strong>`;
      peersList.appendChild(chip);
    });

    const fin = collected.financials || {};
    renderTab1FinancialRows("tab1AnnualBody", fin.annual || []);
    renderTab1FinancialRows("tab1QuarterlyBody", fin.quarterly || []);
    const cTableSection = document.getElementById("tab1ConsensusTableSection");
    if (cTableSection) {
      cTableSection.classList.toggle("hidden", Boolean(p.is_global));
    }
    renderTab1ConsensusRows("tab1ConsensusBody", collected.consensus_table || []);
    renderLevelGuides(collected, stockExplainLevel);
    renderTab4Summary(collected);

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
    document.body.classList.add("is-loading");
    stockAnalyzeBtn.disabled = true;
    stockAnalyzeBtn.textContent = "⏳ 분석 중...";
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
        body: JSON.stringify({ code, mode: "initial_analysis", level: stockExplainLevel })
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
      document.body.classList.remove("is-loading");
      stockAnalyzeBtn.disabled = false;
      stockAnalyzeBtn.textContent = "종목 조회 & AI 분석";
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
    document.body.classList.add("is-loading");
    stockChatSendBtn.disabled = true;
    stockChatSendBtn.textContent = "⏳ 전송 중...";

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
          level: stockExplainLevel,
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
      document.body.classList.remove("is-loading");
      stockChatSendBtn.disabled = false;
      stockChatSendBtn.textContent = "전송";
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

  // =====================================================
  // 6. 탭 4: 주린이를 위한 한줄 정리 (컨센서스 + 투자자 평균단가)
  // =====================================================
  const tab4AvgState = {
    totalInvestors: "237,947명",
    avgPrice: "1,635,748원",
    avgReturn: "-28.29%"
  };

  function renderTab4Summary(collected) {
    const oneLineBox = document.getElementById("tab4OneLineBox");
    const tbody = document.getElementById("tab4SummaryBody");
    const stockLabel = document.getElementById("tab4StockLabel");
    const elInv = document.getElementById("tab4TotalInvestors");
    const elPrice = document.getElementById("tab4AvgPrice");
    const elRet = document.getElementById("tab4AvgReturn");
    if (!oneLineBox || !tbody) return;

    const esc = window.InvestmentApp.escapeHtml;
    const fmt = window.InvestmentApp.formatNumber;

    if (elInv) elInv.textContent = tab4AvgState.totalInvestors;
    if (elPrice) elPrice.textContent = tab4AvgState.avgPrice;
    if (elRet) {
      elRet.textContent = tab4AvgState.avgReturn;
      const retNum = parseFloat(String(tab4AvgState.avgReturn).replace(/[^0-9.-]/g, ""));
      elRet.className = `avg-value ${Number.isFinite(retNum) ? (retNum < 0 ? "down" : retNum > 0 ? "up" : "") : ""}`;
    }

    const p = (collected && collected.profile) || {};
    const val = (collected && collected.valuation) || {};
    const price = (collected && collected.price_info) || {};
    const currency = p.currency || "KRW";
    const fmtCur = (v) => formatCurrencyValue(v, currency);

    const stockName = p.name || "예시 종목";
    if (stockLabel) {
      stockLabel.textContent = p.name
        ? `현재 기준 종목: ${p.name} (${collected.code || "-"})`
        : "탭 1에서 종목을 조회하면 해당 종목의 컨센서스가 자동 반영됩니다 (현재 예시 데이터)";
    }

    const score = Number(val.investment_opinion);
    const hasScore = Number.isFinite(score) && score > 0;
    const opinionText = !hasScore
      ? "매수 (4.00점 · 예시)"
      : `${score <= 1.5 ? "적극매도" : score <= 2.5 ? "매도" : score <= 3.5 ? "중립" : score <= 4.5 ? "매수" : "적극매수"} (${score.toFixed(2)}점)`;

    const hasTarget = val.target_price !== null && val.target_price !== undefined;
    const targetText = hasTarget ? fmtCur(val.target_price) : "465,714원 (예시)";
    const currentText = price.current_price !== null && price.current_price !== undefined ? fmtCur(price.current_price) : "-";
    const gapPct = (hasTarget && price.current_price)
      ? (((val.target_price - price.current_price) / price.current_price) * 100).toFixed(1)
      : null;
    const gapText = gapPct !== null ? `${gapPct > 0 ? "+" : ""}${gapPct}%` : "-";
    const consensusDate = val.consensus_date || "2026-11-23";

    const retNum = parseFloat(String(tab4AvgState.avgReturn).replace(/[^0-9.-]/g, ""));
    const investorMood = Number.isFinite(retNum) && retNum < 0
      ? "지금 이 주식을 산 사람들은 평균적으로 손실(-%) 중이라 '본전만 오면 팔아야지' 하는 사람이 많을 수 있어요."
      : "대체로 수익을 내고 있는 사람이 많아 비교적 편안한 분위기예요.";

    const gapNum = gapPct !== null ? Number(gapPct) : null;
    const multNum = gapNum !== null ? (1 + gapNum / 100) : null;
    const realPriceExample = (currentText !== "-" && hasTarget)
      ? `현재 실시간 ${currentText}인데 추후 ${targetText}${gapNum !== null && gapNum > 0 ? `(약 ${multNum.toFixed(1)}배)` : ""}가 될 것이라고 보는 셈이에요!`
      : "";

    oneLineBox.innerHTML =
      `<strong>🐣 ${esc(stockName)} 주린이 한줄 정리:</strong> 전문가 선생님들이 5점 만점에 <strong>${esc(opinionText)}</strong>을 주면서, 목표주가를 <strong>${esc(targetText)}</strong>` +
      (gapPct !== null ? ` (현재가 대비 <strong>${esc(gapText)}</strong>)` : "") +
      `로 보고 있어요! ${realPriceExample ? `쉽게 말해 <strong>${esc(realPriceExample)}</strong> ` : ""}` +
      `<br><span style="font-size:0.88rem; color:#475569;">💡 투자자 현황: 평균 단가 <strong>${esc(tab4AvgState.avgPrice)}</strong> 기준 평균 수익률은 <strong>${esc(tab4AvgState.avgReturn)}</strong>로, ${investorMood} (단, 날씨 예보처럼 예상일 뿐 100% 맞지는 않으니 조심해서 살펴봐야 해요!)</span>`;

    const scorePercent = hasScore ? Math.round((score / 5) * 100) : 80;
    const rows = [
      {
        group: "컨센서스",
        metric: "투자의견 (5점 만점)",
        value: opinionText,
        desc: `전문가 선생님들이 1점(사지 마) ~ 5점(무조건 사!) 중 점수를 매긴 거예요. ${scorePercent}점 정도로 "꽤 좋아요! 👍"라는 뜻이에요.`
      },
      {
        group: "컨센서스",
        metric: "목표주가",
        value: targetText,
        desc: "전문가 선생님들이 '이 주식, 이 정도 가격은 받을 만해!'라고 예상한 목표 가격표예요."
      },
      {
        group: "컨센서스",
        metric: "현재가 / 괴리율",
        value: currentText !== "-" ? `${currentText} (${gapText})` : gapText,
        desc: realPriceExample
          ? `지금 가격보다 얼마나 더 오를지(%) 보여줘요. ${realPriceExample}`
          : "지금 가격과 목표주가의 차이를 %로 보여줘요."
      },
      {
        group: "컨센서스",
        metric: "기준일",
        value: consensusDate,
        desc: "최근 3개월 동안 전문가들이 낸 예상 점수를 모은 날짜예요."
      },
      {
        group: "투자자 현황",
        metric: "총 투자자",
        value: tab4AvgState.totalInvestors,
        desc: "지금 이 주식 카드를 가지고 있는 사람이 몇 명인지 보여줘요. 많을수록 인기 종목이에요!"
      },
      {
        group: "투자자 현황",
        metric: "평균 단가",
        value: tab4AvgState.avgPrice,
        desc: "다른 사람들이 이 주식을 평균 얼마에 샀는지 알려줘요. 내가 산 가격과 비교해 보세요."
      },
      {
        group: "투자자 현황",
        metric: "평균 수익률",
        value: tab4AvgState.avgReturn,
        desc: "다른 사람들이 지금 돈을 벌고 있는지(+) 잃고 있는지(-) 보여주는 성적표예요."
      }
    ];

    tbody.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(r.group)}</td><td>${esc(r.metric)}</td><td><strong>${esc(r.value)}</strong></td><td>${esc(r.desc)}</td>`;
      tbody.appendChild(tr);
    });
  }

  const tab4AvgForm = document.getElementById("tab4AvgForm");
  if (tab4AvgForm) {
    tab4AvgForm.addEventListener("submit", (e) => {
      e.preventDefault();
      tab4AvgState.totalInvestors = document.getElementById("tab4InputInvestors").value.trim() || "-";
      tab4AvgState.avgPrice = document.getElementById("tab4InputAvgPrice").value.trim() || "-";
      tab4AvgState.avgReturn = document.getElementById("tab4InputAvgReturn").value.trim() || "-";
      renderTab4Summary(lastCollectedData);
    });
  }

  renderTab4Summary(null);
});
