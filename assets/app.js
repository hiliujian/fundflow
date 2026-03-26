let funds = JSON.parse(localStorage.getItem('funds') || '[]');
        let selectedFund = null;
        let holdingsCache = {}; // { [fundCode]: { holdings: [{code, ratio, chg}], top10Weight, top10Contribution, estDayChg, timestamp } }
        let chart = null;
        let miniCharts = {};
        let currentTimeRange = 'realtime';
        let historyCache = {}; // { [fundCode]: [{x, y}, ...] } 缓存 pingzhongdata 全部历史
        let historyTableState = { code: null, rendered: 0, pageSize: 10 };
        let fundgzQueue = Promise.resolve();
        let marketIndices = {};
        let selectedIndexKey = null;
        let indexCharts = {};
        let indexTrendCache = {}; // { [indexKey]: { times: [], prices: [], preClose: number, updatedAt: number } }
        let refreshInterval = null;
        let refreshLock = Promise.resolve();
        let lastFundRefreshAt = 0;
        let lastIndicesRefreshAt = 0;
        let lastHoldingsRefreshAt = 0;
        let refreshTick = 0;
        let fundRefreshCursor = 0;
        
        // 性能优化：防抖渲染
        let renderFundListTimer = null;

        // 添加基金区域折叠
        function toggleAddFund() {
            const body = document.getElementById('addFundBody');
            const arrow = document.getElementById('addFundArrow');
            body.classList.toggle('open');
            arrow.classList.toggle('open');
        }

        function setAddFundOpen(open) {
            const body = document.getElementById('addFundBody');
            if (!body) return;
            const isOpen = body.classList.contains('open');
            if (open === isOpen) return;
            toggleAddFund();
        }

        function closeAddFundPanel() {
            const body = document.getElementById('addFundBody');
            const arrow = document.getElementById('addFundArrow');
            if (!body) return;
            body.classList.remove('open');
            if (arrow) arrow.classList.remove('open');
        }

        function initMobileAddFundSwipeCollapse() {
            const root = document;

            let startX = 0;
            let startY = 0;
            let tracking = false;
            let triggered = false;
            let startedInSection = false;

            const isMobile = () => window.innerWidth <= 768;

            root.addEventListener('touchstart', (e) => {
                if (!isMobile()) return;
                const body = document.getElementById('addFundBody');
                if (!body || !body.classList.contains('open')) return;
                const t0 = e.touches && e.touches[0];
                if (!t0) return;

                const target = e.target;
                startedInSection = !!(target && target.closest && target.closest('.add-fund-section'));
                if (!startedInSection) return;

                startX = t0.clientX;
                startY = t0.clientY;
                tracking = true;
                triggered = false;
            }, { passive: true, capture: true });

            root.addEventListener('touchmove', (e) => {
                if (!tracking || triggered || !startedInSection) return;
                const t = e.touches && e.touches[0];
                if (!t) return;

                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                const ratio = 1.2;
                const threshold = 70;

                if (dx > -threshold) return;
                if (Math.abs(dx) <= Math.abs(dy) * ratio) return;

                triggered = true;
                tracking = false;
                closeAddFundPanel();
                try { document.activeElement?.blur?.(); } catch {}
            }, { passive: true, capture: true });

            const stop = () => { tracking = false; startedInSection = false; };
            root.addEventListener('touchend', stop, { passive: true, capture: true });
            root.addEventListener('touchcancel', stop, { passive: true, capture: true });
        }

        function setFundCardCollapsed(code, shouldCollapse) {
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            const body = document.getElementById('body_' + code);
            const arrow = document.getElementById('arrow_' + code);
            if (!body) return;

            const wasCollapsed = body.classList.contains('collapsed');
            if (shouldCollapse === wasCollapsed) return;

            body.classList.toggle('collapsed', shouldCollapse);
            if (arrow) arrow.classList.toggle('collapsed', shouldCollapse);
            fund._cardCollapsed = shouldCollapse;
            const root = body.closest('.fund-item');
            if (root) {
                root.classList.toggle('card-collapsed', shouldCollapse);
                root.classList.toggle('card-expanded', !shouldCollapse);
            }

            if (!shouldCollapse && wasCollapsed) {
                setTimeout(() => {
                    if (miniCharts[code]) { miniCharts[code].dispose(); delete miniCharts[code]; }
                    initMiniChart(fund);
                }, 50);
            }
        }

        function initMobileCollapseExpandSwipe() {
            const root = document;
            let startX = 0;
            let startY = 0;
            let tracking = false;
            let targetKind = '';
            let targetCode = '';
            let scrollEl = null;

            const isMobile = () => window.innerWidth <= 768;
            const ratio = 1.2;
            const threshold = 70;

            function reset() {
                tracking = false;
                targetKind = '';
                targetCode = '';
                scrollEl = null;
            }

            root.addEventListener('touchstart', (e) => {
                if (!isMobile()) return;
                const t = e.touches && e.touches[0];
                if (!t) return;

                const el = e.target;
                const fundHeader = el?.closest?.('.fund-header');
                const fundBody = el?.closest?.('.fund-body');
                const indicesArea = el?.closest?.('.market-indices');
                const indicesContent = el?.closest?.('#indicesContent');
                const addFundArea = el?.closest?.('.add-fund-section');
                const addFundBody = el?.closest?.('#addFundBody');

                if (el && (el.closest('button') || el.closest('a'))) {
                    return;
                }

                if (fundHeader) {
                    const item = fundHeader.closest('.fund-item');
                    const code = item?.getAttribute?.('data-code') || '';
                    if (!code) return;
                    targetKind = 'fund';
                    targetCode = code;
                } else if (fundBody) {
                    if (fundBody.classList.contains('collapsed')) return;
                    const item = fundBody.closest('.fund-item');
                    const code = item?.getAttribute?.('data-code') || '';
                    if (!code) return;
                    targetKind = 'fund';
                    targetCode = code;
                } else if (indicesArea || indicesContent) {
                    targetKind = 'indices';
                    scrollEl = indicesContent || null;
                } else if (addFundArea || addFundBody) {
                    if (el && (el.closest('input') || el.closest('textarea') || el.closest('select') || el.closest('.fund-suggest') || el.closest('.fund-suggest-item'))) return;
                    targetKind = 'addfund';
                    scrollEl = addFundBody || null;
                } else {
                    return;
                }

                startX = t.clientX;
                startY = t.clientY;
                tracking = true;
            }, { passive: true, capture: true });

            root.addEventListener('touchend', (e) => {
                if (!tracking) return;
                const t = e.changedTouches && e.changedTouches[0];
                if (!t) { reset(); return; }

                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                if (Math.abs(dy) < threshold) { reset(); return; }
                if (Math.abs(dy) <= Math.abs(dx) * ratio) { reset(); return; }

                const shouldCollapse = dy < 0;
                const shouldExpand = dy > 0;

                if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 1) {
                    const atTop = scrollEl.scrollTop <= 0;
                    const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1;
                    if (shouldCollapse && !atBottom) { reset(); return; }
                    if (shouldExpand && !atTop) { reset(); return; }
                }

                if (targetKind === 'fund') {
                    const body = document.getElementById('body_' + targetCode);
                    const isCollapsed = body?.classList?.contains('collapsed');
                    if (shouldCollapse && isCollapsed === false) setFundCardCollapsed(targetCode, true);
                    if (shouldExpand && isCollapsed === true) setFundCardCollapsed(targetCode, false);
                }

                if (targetKind === 'indices') {
                    const content = document.getElementById('indicesContent');
                    const isOpen = content?.classList?.contains('open');
                    if (shouldCollapse && isOpen) setIndicesOpen(false);
                    if (shouldExpand && !isOpen) setIndicesOpen(true);
                }

                if (targetKind === 'addfund') {
                    const body = document.getElementById('addFundBody');
                    const isOpen = body?.classList?.contains('open');
                    if (shouldCollapse && isOpen) setAddFundOpen(false);
                    if (shouldExpand && !isOpen) setAddFundOpen(true);
                }

                reset();
            }, { passive: true, capture: true });

            root.addEventListener('touchcancel', reset, { passive: true, capture: true });
        }

        function initMobilePullToRefresh() {
            const isMobile = () => window.innerWidth <= 768;
            const ratio = 1.6;
            const threshold = 70;
            const cooldownMs = 1500;
            const decideMinMove = 10;
            const showMinDy = 12;
            const fireDxLimit = 18;

            let lastFireAt = 0;

            function ensureIndicator(container) {
                if (!container) return null;
                container.classList.add('ptr-host');
                const existed = container.querySelector(':scope > .pull-refresh-indicator');
                if (existed) return existed;
                const el = document.createElement('div');
                el.className = 'pull-refresh-indicator';
                el.innerHTML = '<div class="pill"><span class="spinner" aria-hidden="true"></span><span class="text">下拉刷新</span></div>';
                container.insertBefore(el, container.firstChild);
                return el;
            }

            function setIndicator(ind, state, pullDy) {
                if (!ind) return;
                if (!state) {
                    ind.classList.remove('show');
                    ind.classList.remove('refreshing');
                    ind.classList.remove('bounce');
                    ind.style.transition = 'transform 260ms cubic-bezier(0.18, 0.89, 0.32, 1.18)';
                    ind.style.transform = '';
                    const t = ind.querySelector('.text');
                    if (t) t.textContent = '下拉刷新';
                    return;
                }

                ind.classList.add('show');
                ind.classList.remove('bounce');
                const t = ind.querySelector('.text');
                if (state === 'pull') {
                    ind.classList.remove('refreshing');
                    if (t) t.textContent = '下拉刷新';
                } else if (state === 'ready') {
                    ind.classList.remove('refreshing');
                    if (t) t.textContent = '松手刷新';
                } else if (state === 'refreshing') {
                    ind.classList.add('refreshing');
                    if (t) t.textContent = '刷新中...';
                }
                if (Number.isFinite(pullDy) && pullDy > 0 && state !== 'refreshing') {
                    ind.style.transition = 'none';
                    const dy = Math.min(pullDy, 90);
                    ind.style.transform = `translateY(${dy * 0.2}px)`;
                } else {
                    ind.style.transition = 'transform 260ms cubic-bezier(0.18, 0.89, 0.32, 1.18)';
                    ind.style.transform = '';
                }
            }

            function bindPull(attachEl, scrollEl, indicatorHostEl, getAction) {
                if (!attachEl) return;
                const getScrollTop = () => {
                    const el = scrollEl || attachEl;
                    return el && typeof el.scrollTop === 'number' ? el.scrollTop : 0;
                };

                const indicator = ensureIndicator(indicatorHostEl || scrollEl || attachEl);

                let startX = 0;
                let startY = 0;
                let tracking = false;
                let eligible = false;
                let fired = false;
                let actionFn = null;
                let decided = false;
                let allowVertical = false;
                let readyToRefresh = false;
                let lastPullDy = 0;

                const reset = () => { tracking = false; eligible = false; fired = false; actionFn = null; decided = false; allowVertical = false; readyToRefresh = false; lastPullDy = 0; setIndicator(indicator, null); };

                attachEl.addEventListener('touchstart', (e) => {
                    if (!isMobile()) return;
                    if (Date.now() - lastFireAt < cooldownMs) return;
                    if (getScrollTop() > 0) return;

                    const target = e && e.target;
                    if (target && target.closest && (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('textarea') || target.closest('select'))) {
                        return;
                    }

                    actionFn = (getAction && getAction()) || null;
                    if (typeof actionFn !== 'function') { actionFn = null; return; }

                    const t0 = e.touches && e.touches[0];
                    if (!t0) return;
                    startX = t0.clientX;
                    startY = t0.clientY;
                    tracking = true;
                    eligible = true;
                    fired = false;
                    decided = false;
                    allowVertical = false;
                    readyToRefresh = false;
                    lastPullDy = 0;
                }, { passive: true });

                attachEl.addEventListener('touchmove', (e) => {
                    if (!tracking || !eligible || fired) return;
                    if (getScrollTop() > 0) { reset(); return; }
                    const t = e.touches && e.touches[0];
                    if (!t) return;
                    const dx = t.clientX - startX;
                    const dy = t.clientY - startY;

                    // 方向判定：一旦确认是横向为主，立即取消（避免左右滑误触）
                    if (!decided) {
                        if (Math.abs(dx) + Math.abs(dy) < decideMinMove) return;
                        decided = true;
                        if (Math.abs(dx) > Math.abs(dy) * ratio) { reset(); return; }
                        allowVertical = true;
                    }
                    if (!allowVertical) return;
                    if (Math.abs(dx) > Math.abs(dy) * ratio) { reset(); return; }

                    if (dy <= 0) return;
                    if (Math.abs(dy) <= Math.abs(dx) * ratio) return;
                    lastPullDy = dy;
                    readyToRefresh = dy >= threshold;
                    if (dy >= showMinDy) setIndicator(indicator, readyToRefresh ? 'ready' : 'pull', dy);
                }, { passive: true });

                attachEl.addEventListener('touchend', () => {
                    if (!tracking || !eligible) { reset(); return; }
                    if (readyToRefresh && typeof actionFn === 'function') {
                        if (Math.abs(lastPullDy) > 0) setIndicator(indicator, 'ready', lastPullDy);
                        indicator.classList.add('bounce');
                        fired = true;
                        lastFireAt = Date.now();
                        tracking = false;
                        eligible = false;
                        setIndicator(indicator, 'refreshing');
                        const ret = actionFn();
                        Promise.resolve(ret).finally(() => {
                            setTimeout(() => reset(), 600);
                        });
                        return;
                    }
                    reset();
                }, { passive: true });
                attachEl.addEventListener('touchcancel', () => { reset(); }, { passive: true });
            }

            const overviewEl = document.getElementById('fundOverviewView');
            bindPull(overviewEl, overviewEl, overviewEl, () => {
                const mainContent = document.querySelector('.main-content');
                const inOverview = !!(mainContent && mainContent.classList.contains('overview-mode'));
                return inOverview ? (() => refreshAllFunds()) : null;
            });

            const detailScrollEl = document.querySelector('.fund-detail-view .chart-section');
            const detailViewEl = document.querySelector('.fund-detail-view');
            bindPull(detailViewEl, detailScrollEl, detailViewEl, () => {
                const mainContent = document.querySelector('.main-content');
                const inOverview = !!(mainContent && mainContent.classList.contains('overview-mode'));
                if (inOverview) return null;
                const code = selectedFund && selectedFund.code;
                if (!code) return null;
                return () => refreshFundByCode(code);
            });
        }

        // ============================================================
        // 持仓编辑对话框
        // ============================================================
        let _posEditCode = null; // 当前正在编辑的基金代码

        function openPosModal(code) {
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            _posEditCode = code;
            document.getElementById('posModalTitle').textContent = `编辑持仓 — ${fund.name || code}`;
            document.getElementById('posCode').value = code;
            setPosAction('buy');
            document.getElementById('posAmount').value = '';
            document.getElementById('posBuyDate').value = '';
            renderPosBuyHistory(fund);
            renderPosSellHistory(fund);
            document.getElementById('posModalOverlay').classList.add('active');
            ensureHistoryForPositionIfNeeded(fund).then(() => {
                if (_posEditCode !== code) return;
                if (!document.getElementById('posModalOverlay')?.classList.contains('active')) return;
                renderPosBuyHistory(fund);
                renderPosSellHistory(fund);
            });
            // 短延迟后 focus 金额输入框
            setTimeout(() => document.getElementById('posAmount').focus(), 120);
        }

        function setPosAction(action) {
            const v = (action === 'sell') ? 'sell' : 'buy';
            const input = document.getElementById('posAction');
            if (input) input.value = v;
            const buyBtn = document.getElementById('posActionBuy');
            const sellBtn = document.getElementById('posActionSell');
            if (buyBtn) buyBtn.classList.toggle('active', v === 'buy');
            if (sellBtn) sellBtn.classList.toggle('active', v === 'sell');
            const amountLabel = document.getElementById('posAmountLabel');
            const dateLabel = document.getElementById('posDateLabel');
            if (amountLabel) amountLabel.textContent = (v === 'sell') ? '卖出金额' : '买入金额';
            if (dateLabel) dateLabel.textContent = (v === 'sell') ? '卖出时间' : '买入时间';

            const buyHist = document.getElementById('posBuyHistory');
            const sellHist = document.getElementById('posSellHistory');
            if (buyHist) buyHist.style.display = (v === 'buy') ? '' : 'none';
            if (sellHist) sellHist.style.display = (v === 'sell') ? '' : 'none';
        }

        function closePosModal() {
            document.getElementById('posModalOverlay').classList.remove('active');
            _posEditCode = null;
        }

        function posModalBgClick(e) {
            if (e.target === document.getElementById('posModalOverlay')) closePosModal();
        }

        function getPosSellAvailableAmount(fund) {
            if (!fund) return NaN;
            const m = calcPositionMetricsOfficialT2FromBuys(fund);
            if (m && m.ok && Number.isFinite(m.value) && m.value > 0) return Number(m.value);
            const pos = getPosition(fund);
            if (pos && pos.has && Number.isFinite(pos.invested) && pos.invested > 0) return Number(pos.invested);
            return NaN;
        }

        function savePosModal() {
            if (!_posEditCode) return;
            const fund = funds.find(f => f.code === _posEditCode);
            if (!fund) return;
            const amountVal = document.getElementById('posAmount').value.trim();
            const buyDateVal = (document.getElementById('posBuyDate').value || '').trim();
            let amount = amountVal !== '' ? parseFloat(amountVal) : NaN;
            const date = buyDateVal !== '' ? buyDateVal : '';
            if (!Number.isFinite(amount)) amount = NaN;
            const action = (document.getElementById('posAction')?.value || 'buy');

            // 未输入直接保存：不做任何修改
            if (amountVal === '' && date === '') {
                closePosModal();
                return;
            }

            // 金额>0但日期不合法：不允许保存（买入/卖出都一样）
            if (Number.isFinite(amount) && amount > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                showToast('请输入正确的日期', 'error');
                return;
            }

            if (action === 'sell') {
                // 清仓：金额 <= 0 或空 => 记录“卖出全部”
                if (!Array.isArray(fund.sells)) fund.sells = [];
                const available = getPosSellAvailableAmount(fund);
                const sellDate = (/^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : (() => {
                    const sh = getShanghaiTimeParts();
                    return `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
                })();

                if (!Number.isFinite(amount) || amount <= 0) {
                    if (!fund.sells.some(x => x && x.all === true && x.date === sellDate)) fund.sells.push({ date: sellDate, all: true });
                } else {
                    if (amount < 0.01) {
                        showToast('卖出金额需≥0.01', 'error');
                        return;
                    }
                    if (Number.isFinite(available) && available > 0 && amount > available) {
                        if (!fund.sells.some(x => x && x.all === true && x.date === sellDate)) fund.sells.push({ date: sellDate, all: true });
                    } else {
                        const idx = fund.sells.findIndex(x => x && x.date === sellDate && x.all !== true);
                        if (idx >= 0) {
                            const prevAmt = Number(fund.sells[idx].amount);
                            fund.sells[idx].amount = (Number.isFinite(prevAmt) ? prevAmt : 0) + amount;
                        } else {
                            fund.sells.push({ amount, date: sellDate, all: false });
                        }
                    }
                }
            } else {
                // 买入
                if (!Array.isArray(fund.buys)) fund.buys = [];
                if (!Number.isFinite(amount) || amount <= 0) {
                    showToast('请输入正确的买入金额', 'error');
                    return;
                }
                const idx = fund.buys.findIndex(x => x && x.date === date);
                if (idx >= 0) {
                    const prevAmt = Number(fund.buys[idx].amount);
                    fund.buys[idx].amount = (Number.isFinite(prevAmt) ? prevAmt : 0) + amount;
                } else {
                    fund.buys.push({ amount, date });
                }
                // 旧字段保留但不再维护
                fund.buyAmount = null;
                fund.buyDate = null;
            }
            saveFunds();
            closePosModal();
            renderFundList();
            syncOverviewAfterPositionChange(fund);
            if (historyTableState?.code === fund.code) resetHistoryTable(fund.code);
            if (selectedFund?.code === _posEditCode || selectedFund?.code === fund.code) updateMainDisplay(fund);
            showToast('持仓信息已更新');
        }

        function renderPosBuyHistory(fund) {
            const wrap = document.getElementById('posBuyHistory');
            const list = document.getElementById('posBuyHistoryList');
            const totalEl = document.getElementById('posBuyHistoryTotal');
            if (!wrap || !list || !totalEl) return;
            const buys = getFundBuys(fund);
            const total = buys.reduce((s, b) => s + (Number(b.amount) || 0), 0);
            totalEl.textContent = `合计 ¥${total.toFixed(2)}`;
            if (!buys.length) {
                list.innerHTML = `<div style="text-align:center;color:var(--gray-500);font-size:0.8125rem;padding:10px 0;font-weight:700;">暂无买入记录</div>`;
                return;
            }
            list.innerHTML = buys.map(b => {
                const eff = getFirstHistoryPointOnOrAfter(fund.code, b.date)?.date;
                const effT1 = eff ? getNextHistoryDate(fund.code, eff) : '';
                const sub = eff ? (effT1 ? `预计 ${effT1} 生效` : `预计 ${eff} 生效`) : '待净值披露后生效';
                const key = `${b.date}|${Number(b.amount).toFixed(2)}`;
                return `
                    <div class="pos-buy-item">
                        <div class="pos-buy-item-left">
                            <div class="pos-buy-item-date">${b.date}</div>
                            <div class="pos-buy-item-sub">${sub}</div>
                        </div>
                        <div class="pos-buy-item-right">
                            <div class="pos-buy-item-amt">¥${Number(b.amount).toFixed(2)}</div>
                            <button class="pos-buy-item-del" onclick="removePosBuyEntry('${fund.code}','${key}')" title="删除">×</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderPosSellHistory(fund) {
            const wrap = document.getElementById('posSellHistory');
            const list = document.getElementById('posSellHistoryList');
            const totalEl = document.getElementById('posSellHistoryTotal');
            if (!wrap || !list || !totalEl) return;
            const sells = getFundSells(fund);
            const total = sells.reduce((s, x) => s + (x && !x.all ? (Number(x.amount) || 0) : 0), 0);
            totalEl.textContent = `合计 ¥${total.toFixed(2)}`;
            if (!sells.length) {
                list.innerHTML = `<div style="text-align:center;color:var(--gray-500);font-size:0.8125rem;padding:10px 0;font-weight:700;">暂无卖出记录</div>`;
                return;
            }
            list.innerHTML = sells.map(s => {
                const eff = getFirstHistoryPointOnOrAfter(fund.code, s.date)?.date;
                const effT1 = eff ? getNextHistoryDate(fund.code, eff) : '';
                const sub = eff ? (effT1 ? `预计 ${effT1} 生效` : `预计 ${eff} 生效`) : '待净值披露后生效';
                const key = s.all ? `${s.date}|ALL` : `${s.date}|${Number(s.amount).toFixed(2)}`;
                const amtText = s.all ? '清仓' : `¥${Number(s.amount).toFixed(2)}`;
                return `
                    <div class="pos-buy-item">
                        <div class="pos-buy-item-left">
                            <div class="pos-buy-item-date">${s.date}</div>
                            <div class="pos-buy-item-sub">${sub}</div>
                        </div>
                        <div class="pos-buy-item-right">
                            <div class="pos-buy-item-amt">${amtText}</div>
                            <button class="pos-buy-item-del" onclick="removePosSellEntry('${fund.code}','${key}')" title="删除">×</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function removePosBuyEntry(code, key) {
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            const [date, amtStr] = (key || '').split('|');
            const amt = Number(amtStr);
            let changed = false;
            if (Array.isArray(fund.buys)) {
                const before = fund.buys.length;
                fund.buys = fund.buys.filter(b => !(b && b.date === date && Number(Number(b.amount).toFixed(2)) === Number(amt.toFixed(2))));
                if (fund.buys.length !== before) changed = true;
            }
            const legacyAmt = Number(fund.buyAmount);
            const legacyDate = (fund.buyDate || '').toString();
            if (!changed && legacyDate === date && Number.isFinite(legacyAmt) && Number(legacyAmt.toFixed(2)) === Number(amt.toFixed(2))) {
                fund.buyAmount = null;
                fund.buyDate = null;
                changed = true;
            }
            if (!changed) return;
            saveFunds();
            renderPosBuyHistory(fund);
            renderFundList();
            syncOverviewAfterPositionChange(fund);
            if (historyTableState?.code === fund.code) resetHistoryTable(fund.code);
            if (selectedFund?.code === fund.code) updateMainDisplay(fund);
            showToast('已删除一笔买入记录');
        }

        function removePosSellEntry(code, key) {
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            const [date, val] = (key || '').split('|');
            let changed = false;
            if (Array.isArray(fund.sells)) {
                const before = fund.sells.length;
                if (val === 'ALL') {
                    fund.sells = fund.sells.filter(s => !(s && s.date === date && s.all === true));
                } else {
                    const amt = Number(val);
                    fund.sells = fund.sells.filter(s => !(s && s.date === date && !s.all && Number(Number(s.amount).toFixed(2)) === Number(amt.toFixed(2))));
                }
                if (fund.sells.length !== before) changed = true;
            }
            if (!changed) return;
            saveFunds();
            renderPosSellHistory(fund);
            renderFundList();
            syncOverviewAfterPositionChange(fund);
            if (historyTableState?.code === fund.code) resetHistoryTable(fund.code);
            if (selectedFund?.code === fund.code) updateMainDisplay(fund);
            showToast('已删除一笔卖出记录');
        }

        function clearPosBuys() {
            if (!_posEditCode) return;
            const fund = funds.find(f => f.code === _posEditCode);
            if (!fund) return;
            if (!confirm('确认清空所有买入记录？')) return;
            const buys = getFundBuys(fund);
            if (!buys.length) return;
            fund.buys = [];
            fund.buyAmount = null;
            fund.buyDate = null;
            saveFunds();
            renderPosBuyHistory(fund);
            renderFundList();
            syncOverviewAfterPositionChange(fund);
            if (historyTableState?.code === fund.code) resetHistoryTable(fund.code);
            if (selectedFund?.code === fund.code) updateMainDisplay(fund);
            showToast('已清空买入记录');
        }

        function clearPosSells() {
            if (!_posEditCode) return;
            const fund = funds.find(f => f.code === _posEditCode);
            if (!fund) return;
            if (!confirm('确认清空所有卖出记录？')) return;
            const sells = getFundSells(fund);
            if (!sells.length) return;
            fund.sells = [];
            // clears 仅作兼容读取，不清理也会继续显示；这里同步清掉避免重复展示
            fund.clears = [];
            saveFunds();
            renderPosSellHistory(fund);
            renderFundList();
            syncOverviewAfterPositionChange(fund);
            if (historyTableState?.code === fund.code) resetHistoryTable(fund.code);
            if (selectedFund?.code === fund.code) updateMainDisplay(fund);
            showToast('已清空卖出记录');
        }

        function posQuickAction(action) {
            const amountInput = document.getElementById('posAmount');
            const current = parseFloat(amountInput.value) || 0;
            const mode = (document.getElementById('posAction')?.value || 'buy');
            const fund = _posEditCode ? funds.find(f => f.code === _posEditCode) : null;
            const available = (mode === 'sell') ? getPosSellAvailableAmount(fund) : NaN;
            switch (action) {
                case 'clear':
                    // 清仓属于卖出
                    setPosAction('sell');
                    amountInput.value = '0';
                    break;
                case 'half':
                    amountInput.value = (mode === 'sell' && Number.isFinite(available) && available > 0)
                        ? (available / 2).toFixed(2)
                        : (current / 2).toFixed(2);
                    break;
                case 'third':
                    amountInput.value = (mode === 'sell' && Number.isFinite(available) && available > 0)
                        ? (available / 3).toFixed(2)
                        : (current / 3).toFixed(2);
                    break;
                case 'quarter':
                    amountInput.value = (mode === 'sell' && Number.isFinite(available) && available > 0)
                        ? (available / 4).toFixed(2)
                        : (current / 4).toFixed(2);
                    break;
                case 'double':
                    amountInput.value = (current * 2).toFixed(2);
                    break;
            }
            amountInput.dispatchEvent(new Event('input'));
        }

        // 主页标题栏 stats 折叠/展开
        function toggleHeaderStats() {
            const wrapper = document.getElementById('statsGridWrapper');
            const btn = document.getElementById('headerCollapseBtn');
            if (!wrapper) return;
            wrapper.classList.toggle('collapsed');
            if (btn) btn.textContent = wrapper.classList.contains('collapsed') ? '▲' : '▼';
        }

        // 折叠/展开市场指数
        function toggleIndices() {
            const content = document.getElementById('indicesContent');
            const arrow = document.getElementById('indicesArrow');
            content.classList.toggle('open');
            arrow.classList.toggle('open');
            if (content.classList.contains('open') && Object.keys(marketIndices).length === 0) {
                fetchMarketIndices(false);
            }
        }

        function setIndicesOpen(open) {
            const content = document.getElementById('indicesContent');
            if (!content) return;
            const isOpen = content.classList.contains('open');
            if (open === isOpen) return;
            toggleIndices();
        }

        // 市场指数配置
        const MARKET_INDICES = {
            sh000001: { name: '上证指数', flag: '🇨🇳', secid: '1.000001', type: 'cn' },
            sz399001: { name: '深证成指', flag: '🇨🇳', secid: '0.399001', type: 'cn' },
            sz399006: { name: '创业板指', flag: '🇨🇳', secid: '0.399006', type: 'cn' },
            us_dji: { name: '道琼斯', flag: '🇺🇸', secid: '100.DJIA', type: 'us' },
            us_ixic: { name: '纳斯达克', flag: '🇺🇸', secid: '100.NDX', type: 'us' },
            us_spx: { name: '标普500', flag: '🇺🇸', secid: '100.SPX', type: 'us' }
        };

        async function fetchMarketIndices(force = false) {
            const grid = document.getElementById('indicesGrid');
            if (!grid) return;

            const status = getMarketStatus();
            const allowCn = !!force || !!(status && status.isOpen);
            const allowUs = !!force || isUsMarketOpenNow();

            const nowTs = Date.now();
            const trendTasks = [];
            for (const [k, cfg] of Object.entries(MARKET_INDICES)) {
                const cached = indexTrendCache[k];
                if (!force) {
                    // 休市冻结：只有在“已有缓存”的情况下跳过拉取；若无缓存，允许首次进入拉取一次，避免卡片显示“加载失败”。
                    if (cfg.type === 'cn' && !allowCn && cached) continue;
                    if (cfg.type === 'us' && !allowUs && cached) continue;
                }
                const fresh = cached && (nowTs - (cached.updatedAt || 0) < 20000);
                if (!fresh) trendTasks.push(fetchIndexTrendSnapshot(k, cfg));
            }
            if (trendTasks.length > 0) {
                await Promise.allSettled(trendTasks);
            }

            const indexCards = [];
            
            for (const [key, config] of Object.entries(MARKET_INDICES)) {
                const cached = indexTrendCache[key];
                const fresh = cached && (nowTs - (cached.updatedAt || 0) < 2 * 60 * 1000);
                const lastPrice = fresh ? cached.prices?.[cached.prices.length - 1] : NaN;
                const preClose = fresh ? cached.preClose : NaN;
                const pct = (fresh && Number.isFinite(lastPrice) && Number.isFinite(preClose) && preClose !== 0) ? ((lastPrice - preClose) / preClose * 100) : NaN;

                const isCn = config.type === 'cn';
                let isClosed = false;
                if (isCn) {
                    const s = getMarketStatus();
                    isClosed = !s.isOpen;
                } else {
                    if (config.type === 'us') {
                        isClosed = !isUsMarketOpenNow();
                    } else {
                        const today = new Date();
                        const day = today.getDay();
                        if (day === 0 || day === 6) isClosed = true;
                    }
                }

                if (fresh && Number.isFinite(lastPrice)) {
                    const isPositive = Number.isFinite(pct) ? (pct >= 0) : true;
                    const finalPrice = lastPrice.toFixed(2);
                    const formattedChange = Number.isFinite(pct) ? ((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%') : '--';
                    const timeStr = (Array.isArray(cached.times) && cached.times.length > 0) ? (cached.times[cached.times.length - 1] || '--') : '--';

                    marketIndices[key] = { price: finalPrice, change: pct, changePct: formattedChange, time: timeStr, secid: config.secid, name: config.name };

                    indexCards.push(`
                        <div class="index-card ${isPositive ? 'positive' : 'negative'} ${selectedIndexKey === key ? 'selected' : ''} ${isClosed ? 'closed' : ''}" 
                             onclick="selectIndex('${key}')" id="indexCard_${key}">
                            <div class="index-header">
                                <div class="index-name"><span class="index-flag">${config.flag}</span>${config.name}</div>
                                <span class="index-status-badge">${isClosed ? '休市' : '交易中'}</span>
                            </div>
                            <div class="index-body">
                                <div class="index-value">${finalPrice}</div>
                                <div class="index-change">${formattedChange}</div>
                            </div>
                            <div class="index-chart-container" id="chartContainer_${key}" style="display: none;">
                                <div class="index-mini-chart" id="indexChart_${key}"></div>
                            </div>
                        </div>
                    `);
                } else {
                    indexCards.push(`
                        <div class="index-card">
                            <div class="index-header"><div class="index-name"><span class="index-flag">${config.flag}</span>${config.name}</div></div>
                            <div class="index-body"><div class="index-value">---</div><div class="index-change">加载失败</div></div>
                        </div>
                    `);
                }
            }
            grid.innerHTML = indexCards.join('');

            // 若当前有选中的指数卡片（展开中），刷新 DOM 后需要恢复展开状态并重绘图表
            if (selectedIndexKey) {
                const card = document.getElementById(`indexCard_${selectedIndexKey}`);
                const container = document.getElementById(`chartContainer_${selectedIndexKey}`);
                if (card) card.classList.add('selected');
                if (container) container.style.display = 'block';

                // DOM 被重建后，旧 echarts 实例已绑定旧 DOM，需要释放并在新 DOM 上重绘
                if (indexCharts[selectedIndexKey]) {
                    try { indexCharts[selectedIndexKey].dispose(); } catch {}
                    delete indexCharts[selectedIndexKey];
                }

                const cached = indexTrendCache[selectedIndexKey];
                const fresh = cached && (Date.now() - (cached.updatedAt || 0) < 5 * 60 * 1000);
                if (fresh) {
                    drawIndexMiniChart(selectedIndexKey, cached);
                } else {
                    // 缓存不存在或过期：重新拉取一次（只对当前展开的指数执行）
                    fetchAndDrawIndexKline(selectedIndexKey);
                }
            }
        }
        
        async function selectIndex(key) {
            if (selectedIndexKey) {
                const prevCard = document.getElementById(`indexCard_${selectedIndexKey}`);
                const prevContainer = document.getElementById(`chartContainer_${selectedIndexKey}`);
                if (prevCard) prevCard.classList.remove('selected');
                if (prevContainer) prevContainer.style.display = 'none';
            }
            if (selectedIndexKey === key) { selectedIndexKey = null; return; }
            
            selectedIndexKey = key;
            const card = document.getElementById(`indexCard_${key}`);
            const container = document.getElementById(`chartContainer_${key}`);
            
            if (card) card.classList.add('selected');
            if (container) {
                container.style.display = 'block';
                if (indexCharts[key]) indexCharts[key].dispose();
                await fetchAndDrawIndexKline(key);
            }
        }
        
        function parseTrendTime(str) {
            if (!str) return '';
            let match = str.match(/(\d{2}):(\d{2})/);
            if (match) return `${match[1]}:${match[2]}`;
            if (str.length >= 12 && !isNaN(str)) return str.substring(8, 10) + ':' + str.substring(10, 12);
            return str;
        }

        function isAshareTradingTimeLabel(hhmm) {
            const m = (hhmm || '').match(/^(\d{2}):(\d{2})$/);
            if (!m) return true;
            const min = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            return (min >= 570 && min <= 690) || (min >= 780 && min <= 900);
        }

        async function fetchIndexTrendSnapshot(key, config) {
            try {
                const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${config.secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53&_=${Date.now()}`;
                const result = await runWithSourceStat('index_trends2_jsonp', async () => await fetchJsonp(url, 'cb', 12000));
                const d = result?.data;
                const trends = d?.trends;
                const preClose = Number(d?.preClose);
                if (!Array.isArray(trends) || trends.length === 0 || !Number.isFinite(preClose)) return;
                const times = [];
                const prices = [];
                for (const item of trends) {
                    const parts = String(item).split(',');
                    const t = parseTrendTime(parts[0]);
                    if (config.type === 'cn' && !isAshareTradingTimeLabel(t)) continue;
                    const p = parseFloat(parts[1]);
                    if (!Number.isFinite(p)) continue;
                    times.push(t);
                    prices.push(p);
                }
                if (times.length === 0 || prices.length === 0) return;
                indexTrendCache[key] = { times, prices, preClose, updatedAt: Date.now() };
            } catch {
            }
        }

        function drawIndexMiniChart(key, cached) {
            const chartDom = document.getElementById(`indexChart_${key}`);
            if (!chartDom) return;
            const times = cached?.times || [];
            const prices = cached?.prices || [];
            const preClose = cached?.preClose;
            if (!Array.isArray(times) || !Array.isArray(prices) || times.length === 0 || prices.length === 0 || !Number.isFinite(preClose)) {
                chartDom.innerHTML = '<div style="text-align:center;color:var(--gray-500);padding:60px 0;font-size:0.75rem;">暂无数据</div>';
                return;
            }

            // 用走势数据回填卡片显示（使卡片涨跌幅与图中最新点对齐）
            {
                const lastPrice = prices[prices.length - 1];
                const pct = (Number.isFinite(lastPrice) && Number.isFinite(preClose) && preClose !== 0) ? ((lastPrice - preClose) / preClose * 100) : NaN;
                const card = document.getElementById(`indexCard_${key}`);
                if (card && Number.isFinite(lastPrice)) {
                    const valueEl = card.querySelector('.index-value');
                    if (valueEl) valueEl.textContent = lastPrice.toFixed(2);
                    const changeEl = card.querySelector('.index-change');
                    if (changeEl && Number.isFinite(pct)) changeEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                }
                if (marketIndices[key]) {
                    if (Number.isFinite(lastPrice)) marketIndices[key].price = lastPrice.toFixed(2);
                    if (Number.isFinite(pct)) {
                        marketIndices[key].change = pct;
                        marketIndices[key].changePct = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                    }
                    if (times.length > 0) marketIndices[key].time = times[times.length - 1] || marketIndices[key].time;
                }
            }

            const indexChart = echarts.init(chartDom);
            indexCharts[key] = indexChart;
            indexChart.setOption({
                grid: { left: 30, right: 22, top: 10, bottom: 28, containLabel: true },
                xAxis: {
                    type: 'category', data: times, boundaryGap: true,
                    axisLabel: {
                        fontSize: 9,
                        color: '#999',
                        margin: 8,
                        interval: (index) => {
                            const total = times.length;
                            if (total <= 6) return true;
                            const step = Math.max(1, Math.floor(total / 4));
                            if (index === 0 || index === total - 1) return true;
                            return index % step === 0;
                        },
                        showMinLabel: true,
                        showMaxLabel: true
                    },
                    axisLine: { lineStyle: { color: '#e5e5e5' } }, axisTick: { show: false }
                },
                yAxis: { type: 'value', scale: true, splitLine: { show: false }, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
                series: [{
                    type: 'line', data: prices, smooth: true, symbol: 'none',
                    lineStyle: { width: 1.5, color: prices[prices.length - 1] >= preClose ? '#dc2626' : '#059669' },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: prices[prices.length - 1] >= preClose ? 'rgba(220, 38, 38, 0.1)' : 'rgba(5, 150, 105, 0.1)' }, { offset: 1, color: 'rgba(255, 255, 255, 0)' }]) }
                }],
                tooltip: {
                    trigger: 'axis', confine: true,
                    backgroundColor: 'rgba(255, 255, 255, 0.95)', borderColor: '#e5e5e5', textStyle: { fontSize: 10 },
                    formatter: (params) => {
                        const param = params[0];
                        const change = ((param.data - preClose) / preClose * 100).toFixed(2);
                        return `${param.name}<br/>${param.data.toFixed(2)} (${change >= 0 ? '+' : ''}${change}%)`;
                    }
                }
            });

            // 新建后主动 resize，避免容器刚显示出来时尺寸为 0 导致空白
            try { indexChart.resize(); } catch {}
        }

        function initMobileHeaderPullToggle() {
            const header = document.querySelector('.main-header');
            if (!header) return;

            let startX = 0;
            let startY = 0;
            let triggered = false;
            let isVertical = false;

            const isMobile = () => window.innerWidth <= 768;

            header.addEventListener('touchstart', (e) => {
                if (!isMobile()) return;
                const t = e.touches && e.touches[0];
                if (!t) return;
                startX = t.clientX;
                startY = t.clientY;
                triggered = false;
                isVertical = false;
            }, { passive: true });

            header.addEventListener('touchmove', (e) => {
                if (!isMobile() || triggered) return;
                const t = e.touches && e.touches[0];
                if (!t) return;

                const dx = t.clientX - startX;
                const dy = t.clientY - startY;

                if (!isVertical) {
                    if (Math.abs(dy) < 18) return;
                    if (Math.abs(dy) <= Math.abs(dx) * 1.2) return;
                    isVertical = true;
                }

                const threshold = 70;
                if (Math.abs(dy) < threshold) return;

                const wrapper = document.getElementById('statsGridWrapper');
                if (!wrapper) return;

                const isCollapsed = wrapper.classList.contains('collapsed');
                const shouldCollapse = dy < 0;
                const shouldExpand = dy > 0;

                if ((shouldCollapse && isCollapsed) || (shouldExpand && !isCollapsed)) return;

                triggered = true;
                const btn = document.getElementById('headerCollapseBtn');
                if (btn) btn.click();
                else toggleHeaderStats();
            }, { passive: true });
        }

        async function fetchAndDrawIndexKline(key) {
            const config = MARKET_INDICES[key];
            if (!config) return;
            const chartDom = document.getElementById(`indexChart_${key}`);
            if (!chartDom) return;
            
            const klineSources = [
                {
                    name: 'eastmoney_trend',
                    fetch: async () => {
                        const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${config.secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f53&_=${Date.now()}`;
                        return await runWithSourceStat('index_trends2_jsonp', async () => await fetchJsonp(url, 'cb', 12000));
                    }
                }
            ];
            
            let trendData = null;
            for (const source of klineSources) {
                try {
                    const result = await source.fetch();
                    if (result?.data?.trends) { trendData = result.data; break; }
                } catch (error) {
                    console.warn(`[K线-${config.name}-${source.name}] 失败:`, error.message);
                    continue;
                }
            }
            
            if (!trendData || !trendData.trends) {
                chartDom.innerHTML = '<div style="text-align:center;color:var(--gray-500);padding:60px 0;font-size:0.75rem;">暂无数据</div>';
                return;
            }
            
            const times = [];
            const prices = [];
            const preClose = trendData.preClose;
            
            trendData.trends.forEach(item => {
                const parts = item.split(',');
                const t = parseTrendTime(parts[0]);
                if (config.type === 'cn' && !isAshareTradingTimeLabel(t)) return;
                const p = parseFloat(parts[1]);
                if (!Number.isFinite(p)) return;
                times.push(t);
                prices.push(p);
            });

            indexTrendCache[key] = { times, prices, preClose, updatedAt: Date.now() };
            drawIndexMiniChart(key, indexTrendCache[key]);
        }

        // 移动端菜单控制
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        const sidebar = document.getElementById('sidebar');
        const sidebarOverlay = document.getElementById('sidebarOverlay');

        function closeMobileSidebar() {
            if (mobileMenuBtn) mobileMenuBtn.classList.remove('active');
            if (sidebar) sidebar.classList.remove('open');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        }

        function initMobileSidebarSwipeClose() {
            if (!sidebar) return;

            let startX = 0;
            let startY = 0;
            let tracking = false;
            let triggered = false;

            const isMobile = () => window.innerWidth <= 768;

            sidebar.addEventListener('touchstart', (e) => {
                if (!isMobile()) return;
                if (!sidebar.classList.contains('open')) return;
                const t = e.touches && e.touches[0];
                if (!t) return;
                startX = t.clientX;
                startY = t.clientY;
                tracking = true;
                triggered = false;
            }, { passive: true });

            sidebar.addEventListener('touchmove', (e) => {
                if (!tracking || triggered) return;
                if (!sidebar.classList.contains('open')) { tracking = false; return; }
                const t = e.touches && e.touches[0];
                if (!t) return;

                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                const ratio = 1.2;
                const threshold = 85;

                if (dx > -threshold) return;
                if (Math.abs(dx) <= Math.abs(dy) * ratio) return;

                triggered = true;
                tracking = false;
                closeMobileSidebar();
            }, { passive: true });

            const stop = () => { tracking = false; };
            sidebar.addEventListener('touchend', stop, { passive: true });
            sidebar.addEventListener('touchcancel', stop, { passive: true });
        }
        
        mobileMenuBtn?.addEventListener('click', () => { mobileMenuBtn.classList.toggle('active'); sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
        
        // 移动端概览按钮
        const mobileOverviewBtn = document.getElementById('mobileOverviewBtn');
        mobileOverviewBtn?.addEventListener('click', () => {
            showOverviewMode();
            // 同时关闭侧边栏
            closeMobileSidebar();
        });
        
        sidebarOverlay?.addEventListener('click', () => { closeMobileSidebar(); });

        // 侧边栏拖拽调整宽度
        const sidebarResizer = document.getElementById('sidebarResizer');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        let resizeThrottleTimer = null;
        
        sidebarResizer?.addEventListener('mousedown', (e) => {
            if (sidebar.classList.contains('collapsed')) return;
            isResizing = true;
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            sidebarResizer.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const delta = e.clientX - startX;
            const newWidth = Math.max(280, Math.min(600, startWidth + delta));
            sidebar.style.width = newWidth + 'px';
            
            // 节流：每100ms最多resize一次
            if (!resizeThrottleTimer) {
                resizeThrottleTimer = setTimeout(() => {
                    requestAnimationFrame(() => {
                        Object.values(miniCharts).forEach(chart => {
                            if (chart && typeof chart.resize === 'function') {
                                try { chart.resize(); } catch (e) {}
                            }
                        });
                    });
                    resizeThrottleTimer = null;
                }, 100);
            }
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            sidebarResizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            
            // 清除节流计时器
            if (resizeThrottleTimer) {
                clearTimeout(resizeThrottleTimer);
                resizeThrottleTimer = null;
            }
            
            // 拖拽结束后最终resize一次
            setTimeout(() => {
                Object.values(miniCharts).forEach(chart => {
                    if (chart && typeof chart.resize === 'function') {
                        try { chart.resize(); } catch (e) {}
                    }
                });
            }, 50);
        });

        // 双击拖拽条恢复默认宽度 (420px)
        sidebarResizer?.addEventListener('dblclick', (e) => {
            e.preventDefault();
            if (sidebar.classList.contains('collapsed')) return;
            
            const defaultWidth = 420;
            sidebar.style.width = defaultWidth + 'px';
            
            // 恢复后resize图表
            setTimeout(() => {
                Object.values(miniCharts).forEach(chart => {
                    if (chart && typeof chart.resize === 'function') {
                        try { chart.resize(); } catch (e) {}
                    }
                });
                // 同时resize主图表
                if (chart && typeof chart.resize === 'function') {
                    try { chart.resize(); } catch (e) {}
                }
            }, 350); // 等待CSS transition完成
        });

        // 全局快捷键监听
        document.addEventListener('keydown', (e) => {
            // Tab - 折叠/展开侧边栏
            if (e.key === 'Tab' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                // 检查是否在输入框中
                const activeElement = document.activeElement;
                const isInputField = activeElement && (
                    activeElement.tagName === 'INPUT' || 
                    activeElement.tagName === 'TEXTAREA' || 
                    activeElement.tagName === 'SELECT' ||
                    activeElement.isContentEditable
                );
                
                if (!isInputField) {
                    e.preventDefault();
                    toggleSidebar();
                }
            }
            
            // Ctrl+A - 显示基金概览
            if (e.key === 'a' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
                // 检查是否在输入框中
                const activeElement = document.activeElement;
                const isInputField = activeElement && (
                    activeElement.tagName === 'INPUT' || 
                    activeElement.tagName === 'TEXTAREA' || 
                    activeElement.tagName === 'SELECT' ||
                    activeElement.isContentEditable
                );
                
                if (!isInputField) {
                    e.preventDefault();
                    showOverviewMode();
                }
            }
        });

        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;
            
            sidebar.classList.toggle('collapsed');
            
            // 调整图表尺寸
            setTimeout(() => {
                if (chart && typeof chart.resize === 'function') {
                    chart.resize();
                }
                Object.values(miniCharts).forEach(c => {
                    if (c && typeof c.resize === 'function') {
                        c.resize();
                    }
                });
            }, 350);
        }

        // 多数据源配置
        function ensureSourceStat(name) {
            if (!name) return;
            if (!sourceStats[name]) sourceStats[name] = { success: 0, fail: 0, totalTime: 0 };
        }

        async function runWithSourceStat(name, fn) {
            ensureSourceStat(name);
            const startTime = Date.now();
            try {
                const data = await fn();
                const duration = Date.now() - startTime;
                sourceStats[name].success++;
                sourceStats[name].totalTime += duration;
                updateSourceIndicator(name);
                if (document.getElementById('sourceStatsModal')?.classList.contains('active')) {
                    renderSourceStatsTable();
                }
                return data;
            } catch (error) {
                const duration = Date.now() - startTime;
                sourceStats[name].fail++;
                if (document.getElementById('sourceStatsModal')?.classList.contains('active')) {
                    renderSourceStatsTable();
                }
                throw error;
            }
        }

        function fetchJsonp(url, callbackParam, timeoutMs = 10000) {
            return new Promise((resolve, reject) => {
                const cbName = `__ff_jsonp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
                const script = document.createElement('script');
                const sep = url.includes('?') ? '&' : '?';
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error('timeout'));
                }, timeoutMs);
                const cleanup = () => {
                    clearTimeout(timer);
                    // 避免竞态：超时/失败后脚本可能“晚到”，仍会执行 cbName(...)。
                    // 若这里直接 delete，会导致控制台报 `cbName is not defined`。
                    // 先替换为 no-op，再延迟删除。
                    try { window[cbName] = () => {}; } catch {}
                    setTimeout(() => {
                        try { delete window[cbName]; } catch { window[cbName] = undefined; }
                    }, 30000);
                    script.remove();
                };
                window[cbName] = (data) => {
                    cleanup();
                    resolve(data);
                };
                script.onerror = () => {
                    cleanup();
                    reject(new Error('script load failed'));
                };
                script.src = `${url}${sep}${callbackParam}=${cbName}`;
                document.head.appendChild(script);
            });
        }

        function loadScript(url, timeoutMs = 12000) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error('timeout'));
                }, timeoutMs);
                const cleanup = () => {
                    clearTimeout(timer);
                    script.remove();
                };
                script.onload = () => {
                    cleanup();
                    resolve();
                };
                script.onerror = () => {
                    cleanup();
                    reject(new Error('script load failed'));
                };
                script.src = url;
                document.head.appendChild(script);
            });
        }

        async function fetchApidataViaScript(url, sourceName) {
            return await runWithSourceStat(sourceName, async () => {
                try { delete window.apidata; } catch { window.apidata = undefined; }
                await loadScript(url, 12000);
                const d = window.apidata;
                if (!d) throw new Error('no apidata');
                try { delete window.apidata; } catch { window.apidata = undefined; }
                return d;
            });
        }

        const DATA_SOURCES = {
            fundgz_jsonp: {
                name: 'fundgz_jsonp', priority: 1,
                fetch: async (code) => {
                    return await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        const prev = window.jsonpgz;
                        const timeout = setTimeout(() => { window.jsonpgz = prev; script.remove(); reject(new Error('timeout')); }, 8000);
                        window.jsonpgz = (data) => { clearTimeout(timeout); window.jsonpgz = prev; script.remove(); resolve(data); };
                        script.onerror = () => { clearTimeout(timeout); window.jsonpgz = prev; script.remove(); reject(new Error('script load failed')); };
                        script.src = `https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
                        document.head.appendChild(script);
                    });
                }
            },
            ttjj_api_jsonp: {
                name: 'ttjj_api_jsonp', priority: 2,
                fetch: async (code) => {
                    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=1&_=${Date.now()}`;
                    const json = await fetchJsonp(url, 'callback', 12000);
                    const latest = json?.Data?.LSJZList?.[0];
                    if (!latest) throw new Error('No data');
                    return { name: json.Data.SHORTNAME || code, dwjz: latest.DWJZ, jzrq: latest.FSRQ, gsz: latest.DWJZ, gszzl: latest.JZZZL || '0.00', gztime: latest.FSRQ + ' 15:00' };
                }
            },
            pingzhongdata_script: {
                name: 'pingzhongdata_script', priority: 3,
                fetch: async (code) => {
                    await loadScript(`https://fund.eastmoney.com/pingzhongdata/${code}.js?rt=${Date.now()}`, 12000);
                    const name = (window.fS_name || window.fSName || '').toString();
                    const navData = window.Data_netWorthTrend;
                    if (!name || !Array.isArray(navData) || navData.length === 0) throw new Error('Parse failed');
                    const latest = navData[navData.length - 1];
                    const prev = navData.length >= 2 ? navData[navData.length - 2] : null;
                    const dwjz = latest?.y;
                    const jzrq = new Date(latest?.x).toISOString().split('T')[0];
                    let gszzl = '0.00';
                    if (prev && prev.y) gszzl = (((latest.y - prev.y) / prev.y) * 100).toFixed(2);
                    return { name, dwjz: String(dwjz), jzrq, gsz: String(dwjz), gszzl, gztime: jzrq + ' 15:00' };
                }
            }
        };

        const sourceStats = {};
        Object.values(DATA_SOURCES).forEach(s => ensureSourceStat(s.name));
        ensureSourceStat('holdings_top10_est');

        async function fetchWithFallback(code) {
            const sources = Object.values(DATA_SOURCES).sort((a, b) => {
                ensureSourceStat(a.name);
                ensureSourceStat(b.name);
                const aSuccessRate = sourceStats[a.name].success / (sourceStats[a.name].success + sourceStats[a.name].fail || 1);
                const bSuccessRate = sourceStats[b.name].success / (sourceStats[b.name].success + sourceStats[b.name].fail || 1);
                if (Math.abs(aSuccessRate - bSuccessRate) > 0.1) return bSuccessRate - aSuccessRate;
                return a.priority - b.priority;
            });
            
            let lastError;
            const attemptedSources = [];
            const failedSources = [];
            for (const source of sources) {
                attemptedSources.push(source.name);
                const startTime = Date.now();
                try {
                    const data = await source.fetch(code);
                    const duration = Date.now() - startTime;
                    if (!data || !data.dwjz || !data.name) throw new Error('数据不完整');
                    // 标记本次成功返回的数据源，供展示层决定估算优先级
                    data._sourceName = source.name;
                    data._attemptedSources = attemptedSources.slice();
                    data._failedSources = failedSources.slice();
                    ensureSourceStat(source.name);
                    sourceStats[source.name].success++;
                    sourceStats[source.name].totalTime += duration;
                    updateSourceIndicator(source.name);
                    return data;
                } catch (error) {
                    const duration = Date.now() - startTime;
                    failedSources.push(source.name);
                    ensureSourceStat(source.name);
                    sourceStats[source.name].fail++;
                    if (document.getElementById('sourceStatsModal')?.classList.contains('active')) {
                        renderSourceStatsTable();
                    }
                    console.warn(`❌ [${source.name}] 失败: ${error.message} (${duration}ms)`);
                    lastError = error;
                    if (source !== sources[sources.length - 1]) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
                }
            }
            throw lastError || new Error('所有数据源均失败');
        }

        function showSourceStats() { console.table(Object.entries(sourceStats).map(([name, stats]) => ({ 数据源: name, 成功: stats.success, 失败: stats.fail, 成功率: stats.success + stats.fail > 0 ? ((stats.success / (stats.success + stats.fail)) * 100).toFixed(1) + '%' : 'N/A', 平均耗时: stats.success > 0 ? (stats.totalTime / stats.success).toFixed(0) + 'ms' : 'N/A' }))); }
        window.showSourceStats = showSourceStats;
        
        let lastSuccessfulSource = 'fundgz_jsonp';
        document.getElementById('sourceIndicator')?.addEventListener('click', () => { openSourceStatsModal(); });

        function renderSourceStatsTable() {
            const tbody = document.getElementById('sourceStatsTableBody');
            if (!tbody) return;
            const statsData = Object.entries(sourceStats)
                .map(([name, stats]) => ({
                    name,
                    success: stats.success,
                    fail: stats.fail,
                    successRate: stats.success + stats.fail > 0 ? ((stats.success / (stats.success + stats.fail)) * 100).toFixed(1) : 'N/A',
                    avgTime: stats.success > 0 ? (stats.totalTime / stats.success).toFixed(0) : 'N/A'
                }))
                .sort((a, b) => (parseFloat(b.successRate) || 0) - (parseFloat(a.successRate) || 0));

            tbody.innerHTML = statsData.map(stat => {
                const rate = parseFloat(stat.successRate) || 0;
                const rateClass = rate >= 80 ? 'high' : rate >= 50 ? 'medium' : 'low';
                return `<tr><td style="font-family: 'JetBrains Mono', monospace; font-size: 0.8125rem;">${stat.name}</td><td style="color: #10b981; font-weight: 600;">${stat.success}</td><td style="color: #ef4444; font-weight: 600;">${stat.fail}</td><td class="success-rate ${rateClass}">${stat.successRate}${stat.successRate !== 'N/A' ? '%' : ''}</td><td style="font-family: 'JetBrains Mono', monospace;">${stat.avgTime}${stat.avgTime !== 'N/A' ? 'ms' : ''}</td></tr>`;
            }).join('') || '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--gray-500);">暂无数据</td></tr>';
        }
        
        function openSourceStatsModal() {
            const modal = document.getElementById('sourceStatsModal');
            renderSourceStatsTable();
            modal.classList.add('active');
        }
        function closeSourceStats() { document.getElementById('sourceStatsModal').classList.remove('active'); }
        document.getElementById('sourceStatsModal')?.addEventListener('click', (e) => { if (e.target.id === 'sourceStatsModal') closeSourceStats(); });
        function updateSourceIndicator(sourceName) { lastSuccessfulSource = sourceName; const indicator = document.getElementById('currentSourceName'); if (indicator) indicator.textContent = sourceName; }

        window.addEventListener('DOMContentLoaded', () => { 
            console.log(
                '%cHigher%c | %c9880699@gmail.com',
                'background:#2563eb;color:#ffffff;font-weight:700;padding:2px 6px;border-radius:6px;',
                'color:#6b7280;font-weight:600;',
                'background:#ec4899;color:#ffffff;font-weight:700;padding:2px 6px;border-radius:6px;'
            );
            initChart(); 
            renderFundList(); 
            initMobileSidebarSwipeClose();
            initMobileSwipeNavigation(); 
            initMobileCollapseExpandSwipe();
            initMobileAddFundSwipeCollapse();
            initMobilePullToRefresh();
            initProfitToggle(); 
            initDayGrowthToggle(); 
            
            // 初始化时显示概览视图
            if (funds.length > 0) {
                showOverviewMode();
            } else {
                // 无基金时也显示概览（空状态）
                showOverviewMode();
            }
            
            startAutoUpdate(); 

            setTimeout(() => {
                refreshLock = refreshLock.then(async () => {
                    if (!Array.isArray(funds) || funds.length === 0) return;
                    await refreshAllFunds({ fromInit: true, skipHistory: true });
                    lastFundRefreshAt = Date.now();
                    fundRefreshCursor = 0;
                }).catch(err => console.warn('init refresh error:', err));
            }, 0);
            
            initMobileHeaderPullToggle();
            
            // 快捷键提示：首次访问时显示10秒后淡出
            const keyboardHint = document.getElementById('keyboardHint');
            if (keyboardHint && localStorage.getItem('keyboardHintShown') !== '1') {
                localStorage.setItem('keyboardHintShown', '1');

                // 延迟300ms后淡入显示
                setTimeout(() => {
                    keyboardHint.classList.add('show');
                }, 300);
                
                // 10秒后淡出
                setTimeout(() => {
                    keyboardHint.classList.remove('show');
                    keyboardHint.classList.add('hide');
                }, 10300);
            }
            
            // 全局resize监听器：处理所有迷你图表的resize
            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    Object.values(miniCharts).forEach(chart => {
                        if (chart && typeof chart.resize === 'function') {
                            chart.resize();
                        }
                    });
                }, 100);
            });
            
            // 滚动监听器：懒加载可见区域的图表
            const fundListEl = document.getElementById('fundList');
            if (fundListEl) {
                let scrollTimer;
                fundListEl.addEventListener('scroll', () => {
                    clearTimeout(scrollTimer);
                    scrollTimer = setTimeout(() => {
                        if ('requestIdleCallback' in window) {
                            requestIdleCallback(() => initVisibleMiniCharts());
                        } else {
                            setTimeout(() => initVisibleMiniCharts(), 50);
                        }
                    }, 150);
                });
            }
        });

        function renderFundList() {
            const listEl = document.getElementById('fundList');
            if (funds.length === 0) { 
                listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">还没有添加基金</div><div class="empty-subtext">输入基金代码开始监控</div></div>`; 
                return; 
            }
            
            // 检查是否需要完全重建（基金数量或顺序变化）
            const existingItems = Array.from(listEl.querySelectorAll('.fund-item'));
            const needsRebuild = existingItems.length !== funds.length || 
                                 existingItems.some((item, idx) => item.dataset.code !== funds[idx].code);
            
            if (needsRebuild) {
                // 使用 DocumentFragment 批量操作，减少重排
                const fragment = document.createDocumentFragment();
                const tempDiv = document.createElement('div');
                
                tempDiv.innerHTML = funds.map(fund => {
                    const isCollapsed = fund._cardCollapsed !== false;
                    const displayNav = getDisplayNav(fund);
                    const badgeVal = getDisplayDayGrowth(fund);
                    const badgeOk = Number.isFinite(badgeVal);
                    return `
                    <div class="fund-item ${selectedFund?.code === fund.code ? 'active' : ''} ${isCollapsed ? 'card-collapsed' : 'card-expanded'}" data-code="${fund.code}">
                        <div class="fund-header" onclick="toggleFundCard('${fund.code}', event)">
                            <div class="fund-info">
                                <div class="fund-name">${fund.name || '加载中...'}<span class="fund-collapse-arrow ${isCollapsed ? 'collapsed' : ''}" id="arrow_${fund.code}">▼</span></div>
                                <div class="fund-code">${fund.code}<span class="fund-code-chg ${badgeOk ? (badgeVal >= 0 ? 'positive' : 'negative') : 'neutral'}">${badgeOk ? (badgeVal >= 0 ? '+' : '') + badgeVal.toFixed(2) + '%' : '--'}</span></div>
                            </div>
                            <div class="fund-actions">
                                <button class="btn-icon btn-edit" onclick="event.stopPropagation(); openPosModal('${fund.code}')" title="编辑持仓">✏️</button>
                                <button class="btn-icon btn-refresh" onclick="event.stopPropagation(); refreshFundByCode('${fund.code}')">🔄</button>
                                <button class="btn-icon btn-delete" onclick="event.stopPropagation(); deleteFund('${fund.code}')">🗑️</button>
                            </div>
                        </div>
                        <div class="fund-body ${isCollapsed ? 'collapsed' : ''}" id="body_${fund.code}">
                            <div class="fund-metrics">
                                <div class="metric-card"><div class="metric-label">估算净值</div><div class="metric-value">${displayNav}</div></div>
                                <div class="metric-card"><div class="metric-label">日涨跌幅</div><div class="metric-value ${badgeOk && badgeVal >= 0 ? 'positive' : 'negative'}">${badgeOk ? (badgeVal >= 0 ? '+' : '') + badgeVal.toFixed(2) + '%' : '--'}</div></div>
                            </div>
                            <div class="fund-chart" id="miniChart_${fund.code}"></div>
                        </div>
                    </div>`;
                }).join('');
                
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
                
                // 一次性替换DOM
                listEl.innerHTML = '';
                listEl.appendChild(fragment);
                
                // 使用事件委托而不是为每个卡片绑定事件
                listEl.removeEventListener('click', handleFundListClick);
                listEl.addEventListener('click', handleFundListClick);
                
                // 使用 requestIdleCallback 延迟初始化图表（避免阻塞主线程）
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(() => initVisibleMiniCharts(), { timeout: 2000 });
                } else {
                    setTimeout(() => initVisibleMiniCharts(), 100);
                }
            } else {
                // 只更新数据，不重建DOM（使用批量更新）
                requestAnimationFrame(() => {
                    existingItems.forEach((item, idx) => {
                        const fund = funds[idx];
                        const isCollapsed = fund._cardCollapsed !== false;
                        const displayNav = getDisplayNav(fund);
                        const badgeVal = getDisplayDayGrowth(fund);
                        const badgeOk = Number.isFinite(badgeVal);
                        
                        // 更新激活状态
                        item.classList.toggle('active', selectedFund?.code === fund.code);
                        item.classList.toggle('card-collapsed', isCollapsed);
                        item.classList.toggle('card-expanded', !isCollapsed);
                        
                        // 批量读取DOM避免强制重排
                        const badge = item.querySelector('.fund-code-chg');
                        const nameEl = item.querySelector('.fund-name');
                        const metricValues = item.querySelectorAll('.metric-value');
                        
                        // 批量写入DOM
                        if (badge) {
                            badge.className = `fund-code-chg ${badgeOk ? (badgeVal >= 0 ? 'positive' : 'negative') : 'neutral'}`;
                            badge.textContent = badgeOk ? (badgeVal >= 0 ? '+' : '') + badgeVal.toFixed(2) + '%' : '--';
                        }

                        if (nameEl) {
                            const arrow = nameEl.querySelector('.fund-collapse-arrow');
                            nameEl.textContent = fund.name || '加载中...';
                            if (arrow) nameEl.appendChild(arrow);
                        }
                        
                        if (metricValues[0]) metricValues[0].textContent = displayNav;
                        if (metricValues[1]) {
                            metricValues[1].className = `metric-value ${badgeOk && badgeVal >= 0 ? 'positive' : 'negative'}`;
                            metricValues[1].textContent = badgeOk ? (badgeVal >= 0 ? '+' : '') + badgeVal.toFixed(2) + '%' : '--';
                        }
                        
                        // 异步更新图表（不阻塞主线程）
                        if ('requestIdleCallback' in window) {
                            requestIdleCallback(() => updateMiniChart(fund));
                        } else {
                            setTimeout(() => updateMiniChart(fund), 0);
                        }
                    });
                });
            }
            
            updateAllPositionSummary();
        }

        // 事件委托处理函数
        function handleFundListClick(e) {
            const item = e.target.closest('.fund-item');
            if (!item) return;
            if (e.target.closest('.fund-actions') || e.target.closest('.fund-header')) return;
            const fund = funds.find(f => f.code === item.dataset.code);
            if (fund) selectFund(fund);
        }

        function updateFundListActiveOnly(code) {
            const listEl = document.getElementById('fundList');
            if (!listEl) return;
            const prev = listEl.querySelector('.fund-item.active');
            if (prev && prev.dataset.code !== code) prev.classList.remove('active');
            const cur = listEl.querySelector(`.fund-item[data-code="${code}"]`);
            if (cur) {
                // 分帧触发 transition，避免 class 同步切换时过渡效果不明显
                requestAnimationFrame(() => cur.classList.add('active'));
            }
        }

        async function refreshOneFundFull(fund, options = {}) {
            if (!fund || !fund.code) return;

            const suppressRender = !!options.suppressRender;
            const includeHoldings = !!options.includeHoldings;
            const skipPositionHistory = !!options.skipPositionHistory;
            const refreshHistoryForDayGrowth = (options.refreshHistoryForDayGrowth !== false);
            const newestOptions = (options.newestOptions && typeof options.newestOptions === 'object') ? options.newestOptions : undefined;

            await fetchFundData(fund, { suppressRender: true });
            try { await fetchBaiduNewestForFund(fund, newestOptions || {}); } catch (e) { }
            if (!skipPositionHistory) {
                await ensureHistoryForPositionIfNeeded(fund);
            }

            if (refreshHistoryForDayGrowth) {
                try {
                    delete historyCache[fund.code];
                    await fetchHistoryData(fund.code, false);
                } catch (e) {
                }
            }

            if (includeHoldings) {
                try { await loadHoldingsAndSectors(fund, { silent: true }); } catch (e) { }
            }

            if (!suppressRender) {
                renderFundList();
                const mainContent0 = document.querySelector('.main-content');
                if (mainContent0 && mainContent0.classList.contains('overview-mode')) {
                    renderFundOverview();
                }
                if (selectedFund?.code === fund.code) {
                    updateMainDisplay(selectedFund);
                    if (currentTimeRange === 'realtime') updateRealtimeChart();
                }
            }
        }

        // 只初始化可见区域的图表（懒加载）
        function initVisibleMiniCharts() {
            const listEl = document.getElementById('fundList');
            if (!listEl) return;
            
            funds.forEach(fund => {
                const chartDom = document.getElementById(`miniChart_${fund.code}`);
                if (!chartDom || miniCharts[fund.code]) return;
                
                // 检查元素是否在可视区域内
                const rect = chartDom.getBoundingClientRect();
                const isVisible = rect.top < window.innerHeight && rect.bottom > 0;
                
                if (isVisible) {
                    initMiniChart(fund);
                }
            });
        }

        function refreshFundByCode(code) {
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            return (async () => {
                const includeHoldings = (selectedFund?.code === fund.code);
                await refreshOneFundFull(fund, { includeHoldings });
                showToast(`${fund.name || fund.code} 数据已刷新`);
            })();
        }

        function initMobileSwipeNavigation() {
            const container = document.querySelector('.main-content');
            if (!container) return;
            const hintEl = document.getElementById('swipeHint');
            const root = document;

            let startX = 0;
            let startY = 0;
            let moved = false;
            let tracking = false;

            const minDx = 60;
            const maxDy = 45;
            const ratio = 1.2;

            function isMobile() {
                try {
                    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
                } catch (err) { /* ignore */ }
                return window.innerWidth <= 768;
            }

            function canHandle(e) {
                if (!isMobile()) return false;
                if (sidebar?.classList.contains('open') || sidebarOverlay?.classList.contains('active')) return false;
                const t = e?.target;
                if (t && (t.closest('input') || t.closest('textarea') || t.closest('select') || t.closest('button') || t.closest('a'))) return false;
                return true;
            }

            function showHintOnce() {
                if (!hintEl) return;
                if (!isMobile()) return;
                if (localStorage.getItem('swipeHintShown') === '1') return;
                localStorage.setItem('swipeHintShown', '1');

                setTimeout(() => {
                    hintEl.classList.add('show');
                }, 300);

                setTimeout(() => {
                    hintEl.classList.remove('show');
                }, 10300);
            }

            function dismissHint() {
                if (!hintEl) return;
                hintEl.classList.remove('show');
            }

            function gotoDelta(delta) {
                if (!Array.isArray(funds) || funds.length <= 1) return;
                const idx = selectedFund ? funds.findIndex(f => f.code === selectedFund.code) : -1;
                const cur = idx >= 0 ? idx : 0;
                let next = cur + delta;
                if (next < 0) next = funds.length - 1;
                if (next >= funds.length) next = 0;
                const f2 = funds[next];
                if (f2) selectFund(f2);
            }

            function isInteractiveTarget(e) {
                const t = e?.target;
                if (!t) return false;
                return !!(t.closest('input') || t.closest('textarea') || t.closest('select') || t.closest('button') || t.closest('a'));
            }

            function handleSwipeEnd(dx, dy) {
                if (Math.abs(dx) >= minDx && Math.abs(dy) <= maxDy && Math.abs(dx) > Math.abs(dy) * ratio) {
                    dismissHint();
                    if (dx < 0) gotoDelta(+1);
                    else gotoDelta(-1);
                }
            }

            const hasPointer = typeof window !== 'undefined' && 'PointerEvent' in window;

            showHintOnce();

            if (hasPointer && !isMobile()) {
                let pointerId = null;
                let pointerCaptured = false;
                root.addEventListener('pointerdown', (e) => {
                    if (!canHandle(e)) return;
                    if (isInteractiveTarget(e)) return;
                    if (!container.contains(e.target)) return;
                    if (e.isPrimary === false) return;
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    startX = e.clientX;
                    startY = e.clientY;
                    moved = false;
                    tracking = true;
                    pointerId = e.pointerId;
                    pointerCaptured = false;
                }, { capture: true });

                root.addEventListener('pointermove', (e) => {
                    if (!tracking) return;
                    if (pointerId !== null && e.pointerId !== pointerId) return;
                    const dx = e.clientX - startX;
                    const dy = e.clientY - startY;
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;

                    if (!pointerCaptured && Math.abs(dx) > Math.abs(dy) * ratio && Math.abs(dx) > 10) {
                        try { container.setPointerCapture(e.pointerId); pointerCaptured = true; } catch (err) { /* ignore */ }
                    }

                    if (Math.abs(dy) > Math.abs(dx) * ratio) {
                        tracking = false;
                        pointerId = null;
                        if (pointerCaptured) {
                            try { container.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                            pointerCaptured = false;
                        }
                        return;
                    }

                    if (Math.abs(dx) > Math.abs(dy) * ratio) {
                        e.preventDefault();
                    }
                }, { capture: true });

                const pointerUpOrCancel = (e) => {
                    if (!tracking) return;
                    if (pointerId !== null && e.pointerId !== pointerId) return;
                    const dx = e.clientX - startX;
                    const dy = e.clientY - startY;
                    const shouldHandle = tracking && moved && canHandle(e) && !isInteractiveTarget(e);

                    tracking = false;
                    pointerId = null;
                    if (pointerCaptured) {
                        try { container.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
                        pointerCaptured = false;
                    }

                    if (shouldHandle) handleSwipeEnd(dx, dy);
                };

                root.addEventListener('pointerup', pointerUpOrCancel, { capture: true });
                root.addEventListener('pointercancel', pointerUpOrCancel, { capture: true });
                return;
            }

            root.addEventListener('touchstart', (e) => {
                if (!canHandle(e)) return;
                if (!container.contains(e.target)) return;
                const t = e.touches && e.touches[0];
                if (!t) return;
                startX = t.clientX;
                startY = t.clientY;
                moved = false;
                tracking = true;
            }, { passive: true, capture: true });

            root.addEventListener('touchmove', (e) => {
                if (!tracking) return;
                const t = e.touches && e.touches[0];
                if (!t) return;
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
                if (Math.abs(dy) > Math.abs(dx) * ratio) {
                    tracking = false;
                }
            }, { passive: true, capture: true });

            root.addEventListener('touchend', (e) => {
                if (!tracking || !moved) { tracking = false; return; }
                if (!canHandle(e)) { tracking = false; return; }
                const t = e.changedTouches && e.changedTouches[0];
                if (!t) { tracking = false; return; }
                const dx = t.clientX - startX;
                const dy = t.clientY - startY;
                tracking = false;

                handleSwipeEnd(dx, dy);
            }, { passive: true, capture: true });
        }

        function toggleFundCard(code, event) {
            event.stopPropagation();
            if (event.target.closest('.fund-actions')) return;
            const fund = funds.find(f => f.code === code);
            if (!fund) return;
            const body = document.getElementById('body_' + code);
            if (!body) return;
            const wasCollapsed = body.classList.contains('collapsed');
            setFundCardCollapsed(code, !wasCollapsed);
            // 同时选中该基金
            selectFund(fund);
        }


        function initMiniChart(fund) {
            const chartDom = document.getElementById(`miniChart_${fund.code}`);
            if (!chartDom) return;
            // renderFundList 会重建 DOM：若缓存实例绑定的是旧节点，会导致“点一下就消失/不一致”
            const cached = miniCharts[fund.code];
            if (cached) {
                const dom0 = (typeof cached.getDom === 'function') ? cached.getDom() : null;
                if (dom0 && dom0 !== chartDom) {
                    cached.dispose();
                    delete miniCharts[fund.code];
                } else {
                    return;
                }
            }
            const miniChart = echarts.init(chartDom);
            miniCharts[fund.code] = miniChart;
            const { xData, yData } = getRealtimeChartData(fund);
            const isUp = getDisplayDayGrowth(fund) >= 0;
            miniChart.setOption({
                grid: { left: 0, right: 0, top: 5, bottom: 5 },
                xAxis: { type: 'category', data: xData, show: false, boundaryGap: false },
                yAxis: { type: 'value', show: false, scale: true },
                series: [{ type: 'line', data: yData, smooth: true, symbol: 'none', connectNulls: true, lineStyle: { width: 2, color: isUp ? '#ef4444' : '#10b981' }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: isUp ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)' }, { offset: 1, color: 'rgba(255,255,255,0)' }]) } }]
            });
        }

        // 图表更新节流器
        const chartUpdateThrottles = new Map();
        
        function updateMiniChart(fund) {
            if (!fund || !fund.code) return;
            
            // 节流：同一基金的图表更新最多200ms执行一次
            const lastUpdate = chartUpdateThrottles.get(fund.code);
            const now = Date.now();
            if (lastUpdate && now - lastUpdate < 200) return;
            chartUpdateThrottles.set(fund.code, now);
            
            const chartDom = document.getElementById(`miniChart_${fund.code}`);
            if (!chartDom) return;
            
            const status = getMarketStatus();
            if (!status.canRealtimeUpdate && status.reason !== '午间休市') {
                // 休市/不开盘：保持最后一帧，避免反复 setOption 导致闪跳
                return;
            }
            
            const c = miniCharts[fund.code];
            if (!c) { initMiniChart(fund); return; }
            
            const dom0 = (typeof c.getDom === 'function') ? c.getDom() : null;
            if (dom0 && dom0 !== chartDom) {
                c.dispose();
                delete miniCharts[fund.code];
                initMiniChart(fund);
                return;
            }
            
            const { xData, yData } = getRealtimeChartData(fund);
            const isUp = getDisplayDayGrowth(fund) >= 0;
            
            // 使用 notMerge: false 和 lazyUpdate 提升性能
            c.setOption({
                xAxis: { data: xData },
                series: [{
                    data: yData,
                    connectNulls: true,
                    lineStyle: { width: 2, color: isUp ? '#ef4444' : '#10b981' },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: isUp ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)' }, { offset: 1, color: 'rgba(255,255,255,0)' }]) }
                }]
            }, { notMerge: false, lazyUpdate: true, silent: true });
        }


        function findLastFiniteIndex(arr) {
            if (!Array.isArray(arr)) return -1;
            for (let i = arr.length - 1; i >= 0; i--) {
                if (Number.isFinite(arr[i])) return i;
            }
            return -1;
        }

        function getEffectiveRealtimeEndIndex(series) {
            const lastKnown = findLastFiniteIndex(series);
            return lastKnown;
        }

        function getRealtimeSeriesForChart(fund) {
            const baseValue = parseFloat(fund.estimatedNav || fund.currentNav || 1.5);
            const stable = (Number.isFinite(baseValue) && baseValue > 0) ? baseValue : 1.5;
            const raw = Array.isArray(fund.realtimeHistory) ? fund.realtimeHistory : [];
            const out = new Array(242);
            // 不要把“未来时间段”用 last 值硬填满，否则午休/盘前会看起来像画到了 15:00。
            // 未来部分用 null，让折线在最后一个已知点处自然停止。
            let firstKnown = -1;
            let lastKnown = -1;
            for (let i = 0; i < raw.length; i++) {
                if (Number.isFinite(raw[i])) { firstKnown = i; break; }
            }
            for (let i = raw.length - 1; i >= 0; i--) {
                if (Number.isFinite(raw[i])) { lastKnown = i; break; }
            }
            for (let i = 0; i < 242; i++) {
                const v = raw[i];
                // 关键：首个已知点之前不要回填，避免把 10:30 的首条数据映射成 09:30-10:30
                if (firstKnown >= 0 && i < firstKnown) {
                    out[i] = null;
                } else {
                    // 首个已知点之后：仅在接口实际返回该分钟时绘制，否则用 null 断线（不要用上一分钟值补齐）
                    out[i] = (lastKnown >= 0 && i <= lastKnown && Number.isFinite(v)) ? v : null;
                }
            }
            return out;
        }

        function getOfficialDayGrowthFromHistoryWithDate(fund) {
            const raw = historyCache[fund.code];
            if (!Array.isArray(raw) || raw.length < 2) return { chg: NaN, date: '' };
            const prev = raw[raw.length - 2];
            const last = raw[raw.length - 1];
            const a = Number(prev?.y);
            const b = Number(last?.y);
            if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return { chg: NaN, date: '' };
            return { chg: ((b - a) / a) * 100, date: tsToDateStr(last?.x) };
        }

        function getDisplayDayGrowth(fund) {
            const status = getMarketStatus();
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            const navDateStr = getDateStr(fund.navDate);
            const estDateStr = getDateStr(fund.estimatedTime);
            const est = parseFloat((fund._fundgzDayGrowth !== undefined && fund._fundgzDayGrowth !== null) ? fund._fundgzDayGrowth : fund.dayGrowth);
            const hasTodayEst = (estDateStr === todayStr) && Number.isFinite(est);

            // 若已明确拿到“官方当日涨跌幅”，全局优先展示官方（避免卡片/详情与日涨跌幅卡片不一致）
            const newestDate = (fund && fund._baiduNewestDayGrowthDate) ? String(fund._baiduNewestDayGrowthDate) : '';
            const newestChg = Number(fund && fund._baiduNewestDayGrowth);
            if (newestDate === todayStr && Number.isFinite(newestChg)) {
                fund._dayGrowthSource = 'official';
                fund._estDayGrowthSource = '';
                fund.dayGrowth = newestChg;
                return newestChg;
            }

            // 最新时间优先：只要已产生“今日估算”（即使尚未开盘），就优先展示估算而不是上一交易日官方
            // （官方净值未出前，估算口径更贴近“当前”）
            const src0 = (fund && fund._dayGrowthSource) ? String(fund._dayGrowthSource) : '';
            const v0 = parseFloat(fund && fund.dayGrowth);
            // 仅当“今日官方净值已出”时，才允许沿用已缓存的 official 值；否则可能会把上一交易日官方错误压过今日估算
            if (src0 === 'official' && navDateStr === todayStr && Number.isFinite(v0)) return v0;

            // fundgz_jsonp 更准：若本轮数据源为 fundgz_jsonp 且已产出今日估算，优先使用它，避免被 holdings_top10_est 覆盖
            const lastSrc0 = (fund && fund._lastFetchSource) ? String(fund._lastFetchSource) : '';
            if (hasTodayEst && lastSrc0 === 'fundgz_jsonp') {
                fund._dayGrowthSource = 'est';
                fund._estDayGrowthSource = 'fundgz';
                fund.dayGrowth = est;
                return est;
            }

            // 交易中/午间休市：若已拿到持仓加权估算（更贴近“当前”），全局优先用它作为日涨跌幅
            const cache0 = holdingsCache && holdingsCache[fund.code];
            const cacheAge0 = cache0 ? (Date.now() - cache0.timestamp) : Infinity;
            const useHoldingsEst0 = (status.canRealtimeUpdate || status.reason === '午间休市')
                && cache0 && cacheAge0 < 300000 && Number.isFinite(cache0.estDayChg);
            // 仅当本轮 fundgz_jsonp 确实“尝试过且失败”时，才启用 holdings_top10_est（严格满足：fundgz 不可用才切换）
            const fundgzTried0 = !!(fund && fund._fundgzTriedThisFetch);
            const fundgzFailed0 = !!(fund && fund._fundgzFailedThisFetch);
            if (useHoldingsEst0 && lastSrc0 !== 'fundgz_jsonp' && fundgzTried0 && fundgzFailed0) {
                ensureSourceStat('holdings_top10_est');
                sourceStats['holdings_top10_est'].success++;
                fund._dayGrowthSource = 'est';
                fund._estDayGrowthSource = 'holdings';
                fund.dayGrowth = cache0.estDayChg;
                return cache0.estDayChg;
            }

            if (hasTodayEst) {
                fund._dayGrowthSource = 'est';
                fund._estDayGrowthSource = 'fundgz';
                fund.dayGrowth = est;
                return est;
            }

            // 盘前/休市：优先使用已持久化的“最近一交易日官方涨跌幅”（避免重启后回退到估算）
            if (!status.canRealtimeUpdate) {
                const offDate = (fund && fund._officialDayGrowthDate) ? String(fund._officialDayGrowthDate) : '';
                const offChg = Number(fund && fund._officialDayGrowth);
                if (offDate && Number.isFinite(offChg)) {
                    fund._dayGrowthSource = 'official';
                    fund._estDayGrowthSource = '';
                    fund.dayGrowth = offChg;
                    return offChg;
                }
            }

            // 夜间官方净值已更新：优先官方口径（避免继续显示“今日估算”造成误解）
            if (navDateStr === todayStr) {
                const off0 = getOfficialDayGrowthFromHistoryWithDate(fund).chg;
                if (Number.isFinite(off0)) {
                    fund._dayGrowthSource = 'official';
                    fund._estDayGrowthSource = '';
                    fund.dayGrowth = off0;
                    return off0;
                }
            }

            // 今日官方净值未出：优先展示“今日估算涨跌幅”（盘后点击卡片也不回退到昨天）
            if (navDateStr !== todayStr && hasTodayEst) {
                return est;
            }

            // 交易中/午休/盘后补全：展示估算日涨跌幅
            if (status.canRealtimeUpdate || status.reason === '午间休市' || status.reason === '盘后补全') {
                const v = parseFloat(fund.dayGrowth);
                return Number.isFinite(v) ? v : 0;
            }
            // 其他：显示官方日涨跌幅（历史净值计算）
            const off = getOfficialDayGrowthFromHistoryWithDate(fund).chg;
            if (Number.isFinite(off)) {
                fund._dayGrowthSource = 'official';
                fund._estDayGrowthSource = '';
                fund.dayGrowth = off;
                return off;
            }
            const fallback = parseFloat(fund.dayGrowth);
            return Number.isFinite(fallback) ? fallback : 0;
        }

        function getDisplayNav(fund) {
            const status = getMarketStatus();
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            const navDateStr = getDateStr(fund.navDate);
            const estDateStr = getDateStr(fund.estimatedTime);
            const estNavNum = parseFloat(fund.estimatedNav);
            const hasTodayEst = (estDateStr === todayStr) && Number.isFinite(estNavNum) && estNavNum > 0;

            // 今日官方净值未出：优先展示“今日最后一次估算值”（盘后也要保留）
            if (navDateStr !== todayStr && hasTodayEst) {
                return fund.estimatedNav;
            }

            // 交易中/午休/盘后补全：展示估算净值（若有），否则回退官方净值
            if (status.canRealtimeUpdate || status.reason === '午间休市' || status.reason === '盘后补全') {
                return fund.estimatedNav || fund.currentNav || '--';
            }
            return fund.currentNav || '--';
        }

        function getShanghaiTimeParts() {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
            const map = {}; parts.forEach(p => map[p.type] = p.value);
            const dow = new Date(Date.UTC(map.year, map.month - 1, map.day)).getUTCDay();
            return { year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day), hour: parseInt(map.hour), minute: parseInt(map.minute), second: parseInt(map.second), dow };
        }

        function getNewYorkTimeParts() {
            const now = new Date();
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
            const map = {}; parts.forEach(p => map[p.type] = p.value);
            const dow = new Date(Date.UTC(map.year, map.month - 1, map.day)).getUTCDay();
            return { year: parseInt(map.year), month: parseInt(map.month), day: parseInt(map.day), hour: parseInt(map.hour), minute: parseInt(map.minute), second: parseInt(map.second), dow };
        }

        function isUsMarketOpenNow() {
            const ny = getNewYorkTimeParts();
            // 周一~周五
            if (ny.dow === 0 || ny.dow === 6) return false;
            const min = ny.hour * 60 + ny.minute;
            // 美股常规交易时段：09:30-16:00（纽约时间，自动处理夏令时）
            return min >= 9 * 60 + 30 && min <= 16 * 60;
        }

        function getDateStr(dateTimeStr) {
            if(!dateTimeStr) return '';
            const m = dateTimeStr.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
            if(!m) return '';
            return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
        }

        function getGzDelayMinutes(gztime) {
            if (!gztime || typeof gztime !== 'string') return null;
            const m = gztime.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (!m) return null;
            const gzDate = `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            if (gzDate !== todayStr) return null;
            const gzMin = parseInt(m[4]) * 60 + parseInt(m[5]);
            const nowMinRaw = sh.hour * 60 + sh.minute;

            // 延迟显示口径：休市时不应把“非交易时间”算进延迟
            // - 盘前：按 09:30 封顶
            // - 午间休市：按 11:30 封顶
            // - 盘后：按 15:00 封顶（盘后补全期除外）
            const status = getMarketStatus();
            let capMin = 900;
            if (status.reason === '盘前') capMin = 570;
            else if (status.reason === '午间休市') capMin = 690;
            else if (status.reason === '盘后') capMin = 900;
            else if (status.reason === '盘后补全') capMin = nowMinRaw;
            const nowMin = Math.min(nowMinRaw, capMin);
            const gzMinCapped = Math.min(gzMin, 900);

            // 规则：只要已经拿到收盘(15:00)数据，就不再展示“延迟xx分钟”
            if (gzMinCapped >= 900) return 0;
            const d = nowMin - gzMinCapped;
            if (!Number.isFinite(d) || d < 0) return null;
            return d;
        }

        async function fetchFundData(fund, options = {}) {
            try {
                const data = await (fundgzQueue = fundgzQueue.then(() => fetchWithFallback(fund.code)));
                fund._lastFetchSource = (data && data._sourceName) ? String(data._sourceName) : '';
                const attempted0 = Array.isArray(data && data._attemptedSources) ? data._attemptedSources : [];
                const failed0 = Array.isArray(data && data._failedSources) ? data._failedSources : [];
                fund._fundgzTriedThisFetch = attempted0.includes('fundgz_jsonp');
                fund._fundgzFailedThisFetch = failed0.includes('fundgz_jsonp');
                fund.name = data.name;
                // 防回退：如果接口返回的官方净值日期更早（常见于夜间/跨日缓存），不要覆盖本地已拿到的更新日期净值
                const incomingNavDateStr0 = getDateStr(data.jzrq);
                const existingNavDateStr0 = getDateStr(fund.navDate);
                const shouldUpdateOfficialNav0 = !existingNavDateStr0
                    || !incomingNavDateStr0
                    || (incomingNavDateStr0 >= existingNavDateStr0);
                if (shouldUpdateOfficialNav0) {
                    fund.currentNav = data.dwjz;
                    fund.navDate = data.jzrq;
                }
                // 统一口径：fund.dayGrowth 代表“估算日涨跌幅”（交易中），来源可能是 fundgz 或持仓估算
                // 防回退：如果接口返回了更早的 gztime（旧数据），不要覆盖最新显示与曲线
                const sh0 = getShanghaiTimeParts();
                const todayStr0 = `${sh0.year}-${String(sh0.month).padStart(2,'0')}-${String(sh0.day).padStart(2,'0')}`;
                const gzDateStr = getDateStr(data.gztime);
                // 新交易日/跨天：重置 last idx，避免昨天的 idx=241 导致今天早盘 acceptGz 永远为 false
                if (gzDateStr && gzDateStr !== (fund._lastGzDate || '')) {
                    fund._lastGzDate = gzDateStr;
                    if (gzDateStr === todayStr0) {
                        fund._lastGzIdx = -1;
                        fund.realtimeHistory = [];
                    }
                }
                const gzIdx = getRealtimeMinuteIndexFromGzTime(data.gztime);
                const lastIdx = Number.isFinite(fund._lastGzIdx) ? fund._lastGzIdx : -1;
                const acceptGz = (gzIdx < 0) ? true : (gzIdx >= lastIdx);
                if (acceptGz && gzIdx >= 0) fund._lastGzIdx = gzIdx;

                // 关键修复：今日官方净值已出时，不再用估算数据覆盖
                const navDateStr = incomingNavDateStr0;
                const shouldAcceptEstimate = !(navDateStr === todayStr0 && acceptGz);

                // 今日官方快照：若接口返回的 gsz 与 dwjz 相同，视作官方净值口径，直接写入官方日涨跌幅
                // 这样基金概览/卡片都能立刻显示官方涨跌幅，而不是沿用上一轮的估算值。
                const isOfficialSnapshot = (navDateStr === todayStr0)
                    && (gzDateStr === todayStr0)
                    && (String(data.gsz) === String(data.dwjz));
                if (isOfficialSnapshot) {
                    const offChg = parseFloat(data.gszzl);
                    if (Number.isFinite(offChg)) {
                        fund.dayGrowth = offChg;
                        fund._dayGrowthSource = 'official';
                        fund._fundgzDayGrowth = null;
                        fund._officialDayGrowth = offChg;
                        fund._officialDayGrowthDate = navDateStr;
                    }
                }
                
                if (acceptGz && shouldAcceptEstimate) {
                    fund._fundgzDayGrowth = data.gszzl;
                    fund.dayGrowth = data.gszzl;
                    fund.estimatedNav = data.gsz;
                    fund.estimatedTime = data.gztime;
                }
                const status = getMarketStatus();
                const gszNum0 = parseFloat(data.gsz);
                const dwjzNum0 = parseFloat(shouldUpdateOfficialNav0 ? data.dwjz : fund.currentNav);
                const seed = status.canRealtimeUpdate
                    ? ((Number.isFinite(gszNum0) && gszNum0 > 0) ? gszNum0 : dwjzNum0)
                    : dwjzNum0;
                if (!Array.isArray(fund.realtimeHistory)) fund.realtimeHistory = [];
                const allowRealtimeWrite = (status.canRealtimeUpdate || status.reason === '午间休市' || status.reason === '盘后补全');
                if (allowRealtimeWrite && acceptGz && shouldAcceptEstimate) {
                    const v0 = parseFloat(data.gsz);
                    const v = (Number.isFinite(v0) && v0 > 0) ? v0 : seed;
                    if (Number.isFinite(v) && v > 0) {
                        // 对齐到“分钟槽位”，避免 push 导致时间轴漂移到 14:53 之类
                        // 使用 gztime 计算槽位，避免“更新于13:51但图画到13:55”这种超前
                        const idx = gzIdx >= 0 ? gzIdx : getRealtimeMinuteIndex();
                        if (idx >= 0) {
                            if (fund.realtimeHistory.length < 242) fund.realtimeHistory.length = 242;
                            fund.realtimeHistory[idx] = v;
                            for (let j = idx + 1; j < fund.realtimeHistory.length; j++) fund.realtimeHistory[j] = undefined;
                        }
                    }
                }
                // “更新于”展示口径：以本次请求完成时间为准（接口在休市/夜间常返回 15:00，作为更新时间会误导）
                const shNow = getShanghaiTimeParts();
                const todayStrNow = `${shNow.year}-${String(shNow.month).padStart(2,'0')}-${String(shNow.day).padStart(2,'0')}`;
                const hhNow = String(shNow.hour).padStart(2, '0');
                const mmNow = String(shNow.minute).padStart(2, '0');
                fund.lastUpdateTime = `${todayStrNow} ${hhNow}:${mmNow}`;
                saveFunds();
                if (!options.suppressRender) {
                    // 防抖渲染，避免频繁DOM操作
                    clearTimeout(renderFundListTimer);
                    renderFundListTimer = setTimeout(() => renderFundList(), 50);
                }
                // 同步迷你图与主图（同一份 realtimeHistory）
                // 休市/不开盘时不刷新迷你图，避免闪跳；但允许首次初始化
                if (allowRealtimeWrite && acceptGz) {
                    updateMiniChart(fund);
                } else {
                    if (!miniCharts[fund.code]) initMiniChart(fund);
                }
                if (selectedFund?.code === fund.code) { updateMainDisplay(fund); if (currentTimeRange === 'realtime') updateRealtimeChart(); }
            } catch (e) { console.error('获取基金数据失败:', e); showToast('数据获取失败，请稍后重试', 'error'); }
        }


        // 持仓收益显示模式：false=总收益，true=当日盈亏
        let showDailyProfit = false;

        // 添加持仓收益点击切换事件
        function initProfitToggle() {
            const profitCard = document.querySelector('.stat-card:nth-child(4)');
            if (profitCard) {
                profitCard.addEventListener('click', function() {
                    showDailyProfit = !showDailyProfit;
                    if (selectedFund) {
                        updateMainDisplay(selectedFund);
                    }
                });
                // 添加点击提示样式
                profitCard.style.cursor = 'pointer';
                profitCard.title = '点击切换总收益/当日盈亏';
            }
        }

        // 日涨跌幅卡片切换状态
        let showStreakView = false;

        // 初始化日涨跌幅卡片切换功能
        function initDayGrowthToggle() {
            const dayGrowthCard = document.getElementById('dayGrowthCard');
            if (dayGrowthCard) {
                dayGrowthCard.addEventListener('click', function() {
                    showStreakView = !showStreakView;
                    if (selectedFund) {
                        updateDayGrowthDisplay(selectedFund);
                    }
                });
                dayGrowthCard.title = '点击切换日涨跌幅/连续涨跌';
            }
        }

        // 计算历史最长连续涨跌和当前连续涨跌
        function calculateStreakData(fund) {
            const history = historyCache[fund.code];
            if (!Array.isArray(history) || history.length < 2) {
                return {
                    maxUpStreak: 0,
                    maxDownStreak: 0,
                    currentStreak: 0,
                    currentIsUp: null
                };
            }

            let maxUpStreak = 0;
            let maxDownStreak = 0;
            let currentUpStreak = 0;
            let currentDownStreak = 0;
            
            // 从旧到新遍历历史净值数据（history[0]是最旧的，history[length-1]是最新的）
            for (let i = 1; i < history.length; i++) {
                const current = Number(history[i].y);
                const previous = Number(history[i - 1].y);
                
                if (!Number.isFinite(current) || !Number.isFinite(previous)) {
                    // 数据无效时，重置当前连续计数
                    currentUpStreak = 0;
                    currentDownStreak = 0;
                    continue;
                }
                
                const change = ((current - previous) / previous) * 100;
                
                if (change > 0) {
                    // 上涨
                    currentUpStreak++;
                    currentDownStreak = 0;
                    maxUpStreak = Math.max(maxUpStreak, currentUpStreak);
                } else if (change < 0) {
                    // 下跌
                    currentDownStreak++;
                    currentUpStreak = 0;
                    maxDownStreak = Math.max(maxDownStreak, currentDownStreak);
                } else {
                    // 涨跌为0时，重置连续计数
                    currentUpStreak = 0;
                    currentDownStreak = 0;
                }
            }

            // 当前连续状态就是最后的连续计数
            let currentStreak = 0;
            let currentIsUp = null;
            
            if (currentUpStreak > 0) {
                currentStreak = currentUpStreak;
                currentIsUp = true;
            } else if (currentDownStreak > 0) {
                currentStreak = currentDownStreak;
                currentIsUp = false;
            }

            return {
                maxUpStreak,
                maxDownStreak,
                currentStreak,
                currentIsUp
            };
        }

        function updateMainDisplay(fund) {
            document.getElementById('selectedFundName').textContent = fund.name || '未知基金';
            document.getElementById('selectedFundCode').textContent = fund.code;
            document.getElementById('currentNav').textContent = fund.currentNav || '--';
            document.getElementById('navDateLabel').textContent = fund.navDate ? fund.navDate.substring(5) : '--';

            const sh0 = getShanghaiTimeParts();
            const todayStr0 = `${sh0.year}-${String(sh0.month).padStart(2,'0')}-${String(sh0.day).padStart(2,'0')}`;
            const navDateStr0 = getDateStr(fund.navDate);
            const navChangeEl = document.getElementById('navChange');
            if (navChangeEl) {
                if (navDateStr0 === todayStr0) {
                    const raw = historyCache[fund.code];
                    const prev = Array.isArray(raw) && raw.length >= 2 ? raw[raw.length - 2] : null;
                    const prevNav = prev ? Number(prev.y) : NaN;
                    const prevDate = prev ? tsToDateStr(prev.x) : '';
                    if (Number.isFinite(prevNav)) {
                        navChangeEl.textContent = `前日净值 ${prevNav.toFixed(4)}${prevDate ? `（${prevDate.slice(5)}）` : ''}`;
                        navChangeEl.className = 'stat-change';
                    } else {
                        navChangeEl.textContent = '前日净值 --';
                        navChangeEl.className = 'stat-change';
                    }
                } else if (navDateStr0) {
                    navChangeEl.textContent = `披露时间 ${navDateStr0.slice(5)} 15:00`;
                    navChangeEl.className = 'stat-change';
                } else {
                    navChangeEl.textContent = '等待净值更新';
                    navChangeEl.className = 'stat-change';
                }
            }

            // 日涨跌幅 — 由 updateDayGrowthDisplay 负责渲染
            updateDayGrowthDisplay(fund);
            
            const status = getMarketStatus();
            const shProfit = getShanghaiTimeParts();
            const todayProfitStr = `${shProfit.year}-${String(shProfit.month).padStart(2,'0')}-${String(shProfit.day).padStart(2,'0')}`;
            const navDateProfitStr = getDateStr(fund.navDate);
            const officialNav0 = parseFloat(fund.currentNav);
            const profitNav0 = parseFloat(getDisplayNav(fund));
            const profitNav = (navDateProfitStr === todayProfitStr && Number.isFinite(officialNav0))
                ? officialNav0
                : (Number.isFinite(profitNav0)
                    ? profitNav0
                    : ((status.canRealtimeUpdate || status.reason === '午间休市' || status.reason === '盘后补全')
                        ? parseFloat(fund.estimatedNav || fund.currentNav)
                        : parseFloat(fund.currentNav)));
            const pos = getPosition(fund);

            // 统一“持仓金额”口径：详情页无论展示“持仓收益/当日盈亏”，持仓金额都使用同一个值（基于官方净值）。
            const navForHoldingValue0 = Number.isFinite(officialNav0) ? officialNav0 : profitNav;
            const mv0 = (pos.has && Number.isFinite(navForHoldingValue0)) ? calcPositionMetrics(pos, navForHoldingValue0) : { ok: false };
            const holdingValueUnified0 = mv0 && mv0.ok ? (Number(mv0.value) || 0) : NaN;

            // 当日盈亏：与概览页共用同一计算口径（calcDailyProfitForFund），避免卖出后按“剩余金额”导致不一致。
            if (showDailyProfit) {
                const dp = calcDailyProfitForFund(fund);
                if (dp && dp.ok) {
                    const dailyProfit0 = Number(dp.dailyProfit) || 0;
                    document.getElementById('totalProfit').textContent = '¥' + dailyProfit0.toFixed(2);
                    document.getElementById('totalProfit').className = `stat-value ${dailyProfit0>=0?'positive':'negative'}`;
                    const ppEl0 = document.getElementById('profitPercent');
                    ppEl0.textContent = '持仓金额 ¥' + (Number.isFinite(holdingValueUnified0) ? holdingValueUnified0.toFixed(2) : '--');
                    ppEl0.className = 'stat-change';
                    ppEl0.style.color = '';
                    const profitCard0 = document.querySelector('.stat-card:nth-child(4) .stat-label');
                    if (profitCard0) profitCard0.textContent = '当日盈亏';
                } else {
                    document.getElementById('totalProfit').textContent = '--';
                    document.getElementById('totalProfit').className = 'stat-value';
                    const ppEl0 = document.getElementById('profitPercent');
                    ppEl0.textContent = (pos && pos.has) ? '持仓金额 --' : '未设置持仓';
                    ppEl0.className = 'stat-change';
                    ppEl0.style.color = '#000';
                    const profitCard0 = document.querySelector('.stat-card:nth-child(4) .stat-label');
                    if (profitCard0) profitCard0.textContent = '当日盈亏';
                }
                return;
            }
            if (pos.has && Number.isFinite(navForHoldingValue0)) {
                const m = mv0;
                if (m.ok) {
                    // 持仓收益
                    {
                        document.getElementById('totalProfit').textContent = '¥' + m.profit.toFixed(2);
                        document.getElementById('totalProfit').className = `stat-value ${m.profit>=0?'positive':'negative'}`;
                        const ppEl = document.getElementById('profitPercent');
                        ppEl.textContent = '持仓金额 ¥' + (Number.isFinite(holdingValueUnified0) ? holdingValueUnified0.toFixed(2) : '--');
                        ppEl.className = 'stat-change';
                        ppEl.style.color = '';

                        const profitCard = document.querySelector('.stat-card:nth-child(4) .stat-label');
                        if (profitCard) profitCard.textContent = '持仓收益';
                    }
                } else {
                    document.getElementById('totalProfit').textContent = '--';
                    document.getElementById('totalProfit').className = 'stat-value';
                    const ppEl = document.getElementById('profitPercent');
                    ppEl.textContent = '持仓金额 --';
                    ppEl.className = 'stat-change';
                    ppEl.style.color = '#000';
                }
            } else {
                document.getElementById('totalProfit').textContent = '--';
                document.getElementById('totalProfit').className = 'stat-value';
                const ppEl = document.getElementById('profitPercent');
                const buys = getFundBuys(fund);
                let pendingAmount = 0;
                const hasHistory = Array.isArray(historyCache[fund.code]) && historyCache[fund.code].length > 0;
                let pendingBuys0 = null;
                if (hasHistory) {
                    const pb = getPositionFromBuy(fund);
                    if (pb && Array.isArray(pb.pendingBuys) && pb.pendingBuys.length > 0) {
                        pendingBuys0 = pb.pendingBuys;
                        for (const x of pb.pendingBuys) {
                            const a = Number(x?.amount);
                            if (Number.isFinite(a) && a > 0) pendingAmount += a;
                        }
                    }
                }
                if (pendingAmount > 0) {
                    const sh0 = getShanghaiTimeParts();
                    const todayStr0 = `${sh0.year}-${String(sh0.month).padStart(2,'0')}-${String(sh0.day).padStart(2,'0')}`;
                    const navDateStr0 = getDateStr(fund.navDate);
                    const shouldShowPrebuyTag0 = Array.isArray(pendingBuys0) && pendingBuys0.length > 0
                        ? pendingBuys0.some(x => {
                            const eff = (x && x.effectiveDate) ? String(x.effectiveDate) : '';
                            if (!eff || !/^\d{4}-\d{2}-\d{2}$/.test(eff)) return true;
                            if (!navDateStr0 || !/^\d{4}-\d{2}-\d{2}$/.test(navDateStr0)) return true;
                            return navDateStr0 < eff;
                        })
                        : (navDateStr0 !== todayStr0);
                    const tag = shouldShowPrebuyTag0 ? ' <span class="day-growth-source prebuy">预买入</span>' : '';
                    ppEl.innerHTML = '持仓金额 ¥' + pendingAmount.toFixed(2) + tag;
                    ppEl.style.color = '';
                    const profitCard = document.querySelector('.stat-card:nth-child(4) .stat-label');
                    if (profitCard) profitCard.textContent = showDailyProfit ? '当日盈亏' : '持仓收益';
                    if (!showDailyProfit) {
                        document.getElementById('totalProfit').textContent = '¥0.00';
                        document.getElementById('totalProfit').className = 'stat-value positive';
                    }
                } else if (buys.length > 0) {
                    ppEl.textContent = hasHistory ? '等待净值更新' : '加载中...';
                    ppEl.style.color = '#000';
                    const profitCard = document.querySelector('.stat-card:nth-child(4) .stat-label');
                    if (profitCard) profitCard.textContent = showDailyProfit ? '当日盈亏' : '持仓收益';
                } else {
                    ppEl.textContent = '未设置持仓';
                    ppEl.style.color = '#000';
                    const profitCard = document.querySelector('.stat-card:nth-child(4) .stat-label');
                    if (profitCard) profitCard.textContent = showDailyProfit ? '当日盈亏' : '持仓收益';
                }
                ppEl.className = 'stat-change';
            }

            // 用上海时区判断周末
            const sh = getShanghaiTimeParts();
            const isWeekend = (sh.dow === 0 || sh.dow === 6);
            if (isWeekend) {
                document.getElementById('estimatedNav').textContent = '--';
                document.getElementById('estimatedChange').textContent = '周末休市';
                document.getElementById('estimatedChange').className = 'stat-change';
                document.getElementById('estLabel').textContent = '估算净值';
            } else {
                const navDateStr = getDateStr(fund.navDate);
                // 今日日期（上海）
                const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;

                // 今日已出官方净值：不再展示估算（避免误解），但保留“估算净值”标签
                if (navDateStr === todayStr) {
                    document.getElementById('estimatedNav').textContent = fund.currentNav || '--';
                    document.getElementById('estimatedChange').textContent = '已更新今日净值';
                    document.getElementById('estimatedChange').className = 'stat-change';
                    document.getElementById('estLabel').textContent = '估算净值';
                } else {
                    // 今日尚未出官方净值：盘后也展示“今日最后一次估算值”
                    const estDateStr = getDateStr(fund.estimatedTime);
                    const estNavNum = parseFloat(fund.estimatedNav);
                    const hasTodayEst = (estDateStr === todayStr) && Number.isFinite(estNavNum) && estNavNum > 0;

                    if (hasTodayEst) {
                        const chgNum = getDisplayDayGrowth(fund);
                        document.getElementById('estimatedNav').textContent = estNavNum.toFixed(4);
                        document.getElementById('estimatedChange').textContent = Number.isFinite(chgNum)
                            ? ((chgNum >= 0 ? '+' : '') + chgNum.toFixed(2) + '%')
                            : '--';
                        document.getElementById('estimatedChange').className = `stat-change ${Number.isFinite(chgNum) && chgNum >= 0 ? 'positive' : 'negative'}`;
                        document.getElementById('estLabel').textContent = '估算净值';
                    } else {
                        document.getElementById('estimatedNav').textContent = '--';
                        document.getElementById('estimatedChange').textContent = '等待今日估值更新';
                        document.getElementById('estimatedChange').className = 'stat-change';
                        document.getElementById('estLabel').textContent = '估算净值';
                    }
                }
            }
            const sh2 = getShanghaiTimeParts();
            const todayStr2 = `${sh2.year}-${String(sh2.month).padStart(2,'0')}-${String(sh2.day).padStart(2,'0')}`;
            const navDateStr2 = getDateStr(fund.navDate);
            let showUpdateTime = fund.lastUpdateTime || '--';
            let useDelay = true;
            // 收盘数据已到：只要展示为 15:00，就不再显示“延迟xx分钟”（避免盘后补全/口径差异造成误导）
            if (typeof showUpdateTime === 'string') {
                const m = showUpdateTime.match(/\b(\d{1,2}):(\d{2})$/);
                if (m) {
                    const hh = parseInt(m[1]);
                    const mm = parseInt(m[2]);
                    const mins = hh * 60 + mm;
                    if (Number.isFinite(mins) && mins >= 900) useDelay = false;
                }
            }
            // 延迟分钟口径：仅基于估值源时间（gztime/estimatedTime），不要用“更新于”(请求完成时间)去算
            const estTimeForDelay = (fund && typeof fund.estimatedTime === 'string') ? fund.estimatedTime : '';
            if (navDateStr2 === todayStr2) {
                // 今日官方净值已出：不再展示“延迟xx分钟”
                useDelay = false;
            } else {
                // 今日官方净值未出：若估值时间不是今天，也不展示延迟（避免跨日误导）
                const estDateStr = getDateStr(estTimeForDelay);
                if (estDateStr && estDateStr !== todayStr2) useDelay = false;
            }
            const delayMin = useDelay ? getGzDelayMinutes(estTimeForDelay) : null;
            const delayBadge = (useDelay && Number.isFinite(delayMin) && delayMin >= 2)
                ? ` <span class="gz-delay-badge" title="估值延迟${delayMin}分钟"><span class="icon">⏱</span>${delayMin}min</span>`
                : '';
            document.getElementById('updateTime').innerHTML = '更新于 ' + showUpdateTime + delayBadge;
            updateReminderBadge();
            updateLastFiredReminderHint();
            rescheduleReminder();
            updateMarketStatusUI();
            updateAllPositionSummary();
        }

        const REMINDER_STORAGE_KEY = 'fund_reminders_v1';
        const LAST_FIRED_REMINDER_KEY = 'fund_reminders_last_fired_v1';
        let reminderTimer = null;
        let reminderScheduleKey = null;
        let reminderNextAtMs = null;
        let lastFiredHintTimer = null;
        let lastFiredHintIndex = 0;

        function loadReminders() {
            try {
                const raw = localStorage.getItem(REMINDER_STORAGE_KEY);
                const obj = raw ? JSON.parse(raw) : null;
                return (obj && typeof obj === 'object') ? obj : {};
            } catch { return {}; }
        }

        function saveReminders(map) {
            try { localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(map || {})); } catch {}
        }

        function getSelectedReminder() {
            if (!selectedFund?.code) return null;
            const all = loadReminders();
            const r = all[selectedFund.code];
            if (!r || !r.time || typeof r.time !== 'string') return null;
            if (!/^\d{2}:\d{2}$/.test(r.time)) return null;
            return r;
        }

        function loadLastFiredReminder() {
            try {
                const raw = localStorage.getItem(LAST_FIRED_REMINDER_KEY);
                const obj = raw ? JSON.parse(raw) : null;
                return (obj && typeof obj === 'object') ? obj : null;
            } catch {
                return null;
            }
        }

        function saveLastFiredReminder(data) {
            try { localStorage.setItem(LAST_FIRED_REMINDER_KEY, JSON.stringify(data || null)); } catch {}
        }

        function updateLastFiredReminderHint() {
            const el = document.getElementById('remindFiredHint');
            if (!el) return;
            const last = loadLastFiredReminder();
            if (lastFiredHintTimer) { clearInterval(lastFiredHintTimer); lastFiredHintTimer = null; }
            lastFiredHintIndex = 0;
            if (!last || !last.date || (!Array.isArray(last.items) && (!last.code || !last.time))) {
                el.innerHTML = '';
                el.classList.remove('show');
                return;
            }
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            if (last.date !== todayStr) {
                el.innerHTML = '';
                el.classList.remove('show');
                return;
            }
            const items0 = Array.isArray(last.items) ? last.items : [{ code: last.code, name: last.name, time: last.time }];
            const items = items0
                .filter(x => x && x.code && x.time)
                .map(x => ({ code: x.code, name: x.name || x.code, time: x.time }));
            const visibleItems = selectedFund?.code ? items.filter(x => x.code !== selectedFund.code) : items;
            if (visibleItems.length === 0) {
                el.innerHTML = '';
                el.classList.remove('show');
                return;
            }
            const listHtml = visibleItems
                .concat(visibleItems.length > 1 ? [visibleItems[0]] : [])
                .map(x => `<div class="rfh-item" data-code="${x.code}">最近提醒：${x.name}（${x.code}）${x.time}</div>`)
                .join('');
            el.innerHTML = `<span class="rfh-viewport"><span class="rfh-inner">${listHtml}</span></span>`;
            el.classList.add('show');

            if (visibleItems.length > 1) {
                const inner = el.querySelector('.rfh-inner');
                const itemH = 18;
                const count = visibleItems.length;
                lastFiredHintTimer = setInterval(() => {
                    lastFiredHintIndex++;
                    if (!inner) return;
                    inner.style.transition = 'transform 0.35s ease';
                    inner.style.transform = `translateY(${-lastFiredHintIndex * itemH}px)`;
                    if (lastFiredHintIndex === count) {
                        setTimeout(() => {
                            if (!inner) return;
                            inner.style.transition = 'none';
                            inner.style.transform = 'translateY(0px)';
                            lastFiredHintIndex = 0;
                        }, 380);
                    }
                }, 2200);
            }
        }

        function jumpToLastFiredReminder(e) {
            e?.stopPropagation?.();
            const code = e?.target?.closest?.('[data-code]')?.getAttribute?.('data-code');
            const targetCode = code || loadLastFiredReminder()?.code;
            if (!targetCode) return;
            const target = funds.find(f => f.code === targetCode);
            if (target) selectFund(target);
        }

        function updateReminderBadge() {
            const el = document.getElementById('remindChip');
            if (!el) return;
            // 触发提醒后的 1 分钟报警态由 fireReminder 控制，避免被刷新逻辑覆盖
            if (el.classList.contains('alert')) return;
            const r = getSelectedReminder();
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            if (r) {
                el.classList.remove('alert');
                if (hasFiredTodayForThisTime(r, todayStr)) {
                    el.classList.remove('active');
                    el.classList.add('fired');
                    el.textContent = `⏰ 已提醒 ${r.time}`;
                } else {
                    el.classList.remove('fired');
                    el.classList.add('active');
                    el.textContent = `⏰ ${r.time}`;
                }
            } else {
                el.classList.remove('active');
                el.classList.remove('fired');
                el.classList.remove('alert');
                el.classList.remove('ring');
                el.textContent = '提醒';
            }
        }

        function hasFiredTodayForThisTime(r, todayStr) {
            if (!r) return false;
            if (r.lastFiredDate !== todayStr) return false;
            // 兼容旧数据：若没有 lastFiredTime，则视为当日已提醒（但修改时间时会清空 lastFiredDate）
            if (!r.lastFiredTime) return true;
            return r.lastFiredTime === r.time;
        }

        function getReminderTargetMin(r) {
            if (!r?.time || typeof r.time !== 'string') return null;
            const m = r.time.match(/^(\d{2}):(\d{2})$/);
            if (!m) return null;
            const hh = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
            return hh * 60 + mm;
        }

        function getShanghaiDateStrOffset(days) {
            const sh = getShanghaiTimeParts();
            const d = new Date(Date.UTC(sh.year, sh.month - 1, sh.day + (days || 0)));
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        }

        function checkReminderDue() {
            const r = getSelectedReminder();
            if (!r || !selectedFund?.code) return false;
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            if (hasFiredTodayForThisTime(r, todayStr)) return false;
            const targetMin = getReminderTargetMin(r);
            if (!Number.isFinite(targetMin)) return false;
            const nowMin = sh.hour * 60 + sh.minute;
            // 只在到点这一分钟触发；若设置时间早于当前时间，则视为下一天（不立刻补触发）
            if (nowMin === targetMin) return true;
            return false;
        }

        function openReminderPrompt(e) {
            e?.stopPropagation?.();
            if (!selectedFund?.code) return;
            const r = getSelectedReminder();
            const current = r?.time || '';
            const input = prompt('设置提醒时间(HH:MM)，留空取消', current || '14:55');
            if (input === null) return;
            const all = loadReminders();
            const v = (input || '').trim();
            if (!v) {
                delete all[selectedFund.code];
                saveReminders(all);
                updateReminderBadge();
                rescheduleReminder();
                showToast(`${selectedFund.name || selectedFund.code} 已取消提醒`);
                return;
            }
            if (!/^\d{1,2}:\d{2}$/.test(v)) {
                alert('格式不正确，请输入 HH:MM，例如 14:55');
                return;
            }
            const [hhRaw, mmRaw] = v.split(':');
            const hh = String(Math.min(23, Math.max(0, parseInt(hhRaw, 10)))).padStart(2,'0');
            const mm = String(Math.min(59, Math.max(0, parseInt(mmRaw, 10)))).padStart(2,'0');
            const nextTime = `${hh}:${mm}`;
            const prev = all[selectedFund.code];
            const prevTime = prev?.time || null;
            const keepFired = prevTime && prevTime === nextTime;
            all[selectedFund.code] = {
                time: nextTime,
                lastFiredDate: keepFired ? (prev?.lastFiredDate || null) : null,
                lastFiredTime: keepFired ? (prev?.lastFiredTime || prevTime || null) : null
            };
            saveReminders(all);
            updateReminderBadge();
            rescheduleReminder();
            showToast(`${selectedFund.name || selectedFund.code} 已设置提醒 ${hh}:${mm}`);
        }

        function rescheduleReminder() {
            // 说明：该函数会在刷新循环中被频繁调用。
            // 若每次都 clearTimeout + 重设，会在临界 1 分钟内不断改写定时器，极端情况下会错过触发。
            const r = getSelectedReminder();
            if (!r) return;

            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            if (hasFiredTodayForThisTime(r, todayStr)) return;

            // 若已到点/过点，立刻补触发一次（修复“设置了但没提醒/已过点仍显示已设置”）
            if (checkReminderDue()) {
                // 注意：页面可能在轮询刷新时频繁调用 rescheduleReminder，若使用短 setTimeout 会被不断 clearTimeout 导致永不触发
                // 这里直接触发，由 lastFiredDate/lastFiredTime 负责防重
                fireReminder();
                return;
            }

            const [hh, mm] = r.time.split(':').map(x => parseInt(x, 10));
            const sh2 = getShanghaiTimeParts();
            const nowMin = sh2.hour * 60 + sh2.minute;
            const targetMin = hh * 60 + mm;
            let minutesLeft = targetMin - nowMin;
            const targetOffsetDays = minutesLeft < 0 ? 1 : 0;
            if (minutesLeft < 0) minutesLeft += 1440;
            const targetDateStr = getShanghaiDateStrOffset(targetOffsetDays);
            const scheduleKey = `${selectedFund.code}|${r.time}|${targetDateStr}`;

            // 如果当前已有同一个 scheduleKey 的计时器，就不要重复 clear/re-schedule
            if (reminderTimer && reminderScheduleKey === scheduleKey && Number.isFinite(reminderNextAtMs)) {
                return;
            }
            if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }

            // 若已经进入目标分钟（可能 seconds 不同），直接触发
            if (minutesLeft === 0) {
                reminderScheduleKey = scheduleKey;
                reminderNextAtMs = Date.now();
                fireReminder();
                return;
            }

            const delay = Math.max(200, minutesLeft * 60000 - ((sh2.second || 0) * 1000));
            reminderScheduleKey = scheduleKey;
            reminderNextAtMs = Date.now() + delay;
            reminderTimer = setTimeout(() => fireReminder(), delay);
        }

        async function fireReminder() {
            const r = getSelectedReminder();
            if (!r || !selectedFund?.code) return;
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            // 防抖：未到目标时间不触发（修复 15:39 设置 15:40 却提前触发）
            const targetMin = getReminderTargetMin(r);
            const nowMin = sh.hour * 60 + sh.minute;
            if (Number.isFinite(targetMin) && nowMin < targetMin) {
                rescheduleReminder();
                return;
            }
            const all = loadReminders();
            const curr = all[selectedFund.code];
            if (curr) {
                curr.lastFiredDate = todayStr;
                curr.lastFiredTime = r.time;
                all[selectedFund.code] = curr;
                saveReminders(all);
            }

            const prevLast = loadLastFiredReminder();
            const prevItems0 = (prevLast && Array.isArray(prevLast.items))
                ? prevLast.items
                : (prevLast && prevLast.code && prevLast.time ? [{ code: prevLast.code, name: prevLast.name, time: prevLast.time }] : []);
            const sameBucket = prevLast && prevLast.date === todayStr && prevLast.time === r.time;
            const nextItems = (sameBucket ? prevItems0.slice() : []);
            const idx = nextItems.findIndex(x => x && x.code === selectedFund.code);
            const nextItem = { code: selectedFund.code, name: selectedFund.name || selectedFund.code, time: r.time };
            if (idx >= 0) nextItems[idx] = nextItem; else nextItems.push(nextItem);
            saveLastFiredReminder({ date: todayStr, time: r.time, items: nextItems });
            updateLastFiredReminderHint();

            const title = 'FundFlow 提醒';
            const body = `${selectedFund.name || selectedFund.code}（${r.time}）请关注盘中变化`;
            try {
                if ('Notification' in window) {
                    if (Notification.permission === 'granted') {
                        new Notification(title, { body });
                    } else if (Notification.permission !== 'denied') {
                        const p = await Notification.requestPermission();
                        if (p === 'granted') new Notification(title, { body });
                    } else {
                        // denied: do nothing
                    }
                }
            } catch {
                // ignore
            }
            const chip = document.getElementById('remindChip');
            if (chip) {
                chip.classList.add('alert');
                chip.classList.add('ring');
                chip.classList.remove('active');
                chip.classList.remove('fired');
                chip.textContent = `⏰ ${r.time}`;
                setTimeout(() => {
                    chip.classList.remove('alert');
                    chip.classList.remove('ring');
                    updateReminderBadge();
                }, 60000);
            }
            showToast(body, 'error', 60000, true);
            // 报警态下不更新 badge，避免立刻变成“已提醒”而看不到红色提示
            rescheduleReminder();
        }

        // ============================================================
        // 日涨跌幅渲染 — 开盘中用持仓加权估算，未开盘用官方数据
        // ============================================================
        function updateDayGrowthDisplay(fund) {
            const el = document.getElementById('dayGrowth');
            const chgEl = document.getElementById('dayGrowthChange');
            const labelEl = document.querySelector('#dayGrowthCard .stat-label');
            
            // 如果显示连续涨跌视图
            if (showStreakView) {
                const streakData = calculateStreakData(fund);
                
                if (labelEl) {
                    labelEl.textContent = '连续涨跌';
                }
                
                // 显示连续涨跌数据
                if (streakData.maxUpStreak > 0 || streakData.maxDownStreak > 0) {
                    // 主数值：显示当前连涨/跌状态
                    if (streakData.currentStreak > 0 && streakData.currentIsUp !== null) {
                        const currentIcon = streakData.currentIsUp ? '↗' : '↘';
                        el.innerHTML = `${currentIcon}${streakData.currentStreak}天`;
                        el.className = `stat-value ${streakData.currentIsUp ? 'positive' : 'negative'}`;
                        el.style.opacity = '';
                    } else {
                        // 没有当前连续状态，显示--
                        el.innerHTML = '--';
                        el.className = 'stat-value';
                        el.style.opacity = '';
                    }
                    
                    if (chgEl) {
                        // 底部：显示历史最长连涨和连跌记录（完全使用默认颜色）
                        const upText = streakData.maxUpStreak > 0 
                            ? `最长连涨 ${streakData.maxUpStreak} 天` 
                            : '无连涨记录';
                        const downText = streakData.maxDownStreak > 0 
                            ? `最长连跌 ${streakData.maxDownStreak} 天` 
                            : '无连跌记录';
                        
                        chgEl.innerHTML = `${upText} | ${downText}`;
                        chgEl.className = 'stat-change';
                    }
                } else {
                    el.innerHTML = '--';
                    el.className = 'stat-value';
                    if (chgEl) {
                        chgEl.innerHTML = '<span style="color: var(--gray-400);">数据不足</span>';
                        chgEl.className = 'stat-change';
                    }
                }
                return;
            }
            
            // 默认显示日涨跌幅
            if (labelEl) {
                labelEl.textContent = '日涨跌幅';
            }

            const chgNum = getDisplayDayGrowth(fund);
            if (Number.isFinite(chgNum)) {
                el.innerHTML = (chgNum >= 0 ? '+' : '') + chgNum.toFixed(2) + '%';
                el.className = `stat-value ${chgNum >= 0 ? 'positive' : 'negative'}`;
            } else {
                el.innerHTML = '--';
                el.className = 'stat-value';
            }

            if (chgEl) {
                const src = (fund && fund._dayGrowthSource) ? String(fund._dayGrowthSource) : '';
                if (src === 'est') {
                    const estSrc = (fund && fund._estDayGrowthSource) ? String(fund._estDayGrowthSource) : '';
                    if (estSrc === 'holdings') {
                        const cache = holdingsCache && holdingsCache[fund.code];
                        const w = Number(cache && cache.top10Weight);
                        const wText = Number.isFinite(w) ? w.toFixed(2) : '--';
                        chgEl.innerHTML = `TOP10权重 ${wText}% <span class="day-growth-source est">估算</span>`;
                    } else {
                        const t = (fund.estimatedTime && typeof fund.estimatedTime === 'string') ? (fund.estimatedTime.match(/\b\d{1,2}:\d{2}\b/)?.[0] || '') : '';
                        chgEl.innerHTML = `今日估算${t ? ' ' + t : ''} <span class="day-growth-source est">估算</span>`;
                    }
                    chgEl.style.fontSize = '';
                } else if (src === 'official') {
                    const off = getOfficialDayGrowthFromHistoryWithDate(fund);
                    const offDate = off.date ? off.date.slice(5) : '';
                    chgEl.innerHTML = offDate
                        ? `当日涨幅 ${offDate} 15:00 <span class="day-growth-source official">官方</span>`
                        : `当日涨幅 <span class="day-growth-source official">官方</span>`;
                    chgEl.style.fontSize = '';
                } else {
                    chgEl.innerHTML = '--';
                    chgEl.style.fontSize = '';
                }
            }
        }

        function getRealtimeMinuteIndex() {
            const t = getShanghaiTimeParts();
            const min = t.hour * 60 + t.minute;
            if (min < 570) return -1;
            if (min <= 690) return min - 570;
            if (min < 780) return -1;
            if (min <= 900) return 121 + (min - 780);
            return -1;
        }

        function getRealtimeMinuteIndexFromGzTime(gztime) {
            if (!gztime || typeof gztime !== 'string') return -1;
            const m = gztime.match(/\b(\d{1,2}):(\d{2})\b/);
            if (!m) return -1;
            const hour = parseInt(m[1]);
            const minute = parseInt(m[2]);
            if (!Number.isFinite(hour) || !Number.isFinite(minute)) return -1;
            const min = hour * 60 + minute;
            if (min < 570) return -1;
            if (min <= 690) return min - 570;
            if (min < 780) return -1;
            if (min <= 900) return 121 + (min - 780);
            return -1;
        }


        function updateMarketStatusUI() {
            const s = getMarketStatus();
            const el = document.getElementById('marketStatus');
            el.className = `market-status ${s.isOpen?'open':'closed'}`;
            const displayReason = (s.reason === '盘后补全') ? '盘后' : s.reason;
            el.innerHTML = `<span>${s.isOpen?'▶':'⏸'}</span><span>${s.isOpen?'交易中':displayReason}</span>`;
        }

        function getMarketStatus() {
            const t = getShanghaiTimeParts();
            const min = t.hour * 60 + t.minute;
            if (t.dow === 0 || t.dow === 6) return { isOpen: false, reason: '周末休市', canRealtimeUpdate: false };
            if ((min >= 570 && min < 690) || (min >= 780 && min < 900)) return { isOpen: true, reason: '交易中', canRealtimeUpdate: true };
            // 盘后补全期：15:00 后数据源可能仍在补最后几分钟（例如 14:55 才到），允许短时间继续拉取估值
            if (min >= 900 && min < 915) return { isOpen: false, reason: '盘后补全', canRealtimeUpdate: true };
            return { isOpen: false, reason: min < 570 ? '盘前' : (min >= 900 ? '盘后' : '午间休市'), canRealtimeUpdate: false };
        }

        function saveFunds() { localStorage.setItem('funds', JSON.stringify(funds)); }

        function getFundBuys(fund) {
            const out = [];
            if (Array.isArray(fund?.buys)) {
                for (const b of fund.buys) {
                    const amount = Number(b?.amount);
                    const date = (b?.date || '').toString();
                    if (Number.isFinite(amount) && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
                        out.push({ amount, date });
                    }
                }
            }
            // 兼容旧结构
            const legacyAmt = Number(fund?.buyAmount);
            const legacyDate = (fund?.buyDate || '').toString();
            if (Number.isFinite(legacyAmt) && legacyAmt > 0 && /^\d{4}-\d{2}-\d{2}$/.test(legacyDate)) {
                out.push({ amount: legacyAmt, date: legacyDate });
            }
            out.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
            return out;
        }

        function getFundSells(fund) {
            const out = [];
            if (Array.isArray(fund?.sells)) {
                for (const s of fund.sells) {
                    const date = (s?.date || '').toString();
                    const all = !!s?.all;
                    const amount = Number(s?.amount);
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
                    if (all) {
                        out.push({ date, all: true, amount: null });
                    } else if (Number.isFinite(amount) && amount > 0) {
                        out.push({ date, all: false, amount });
                    }
                }
            }
            // 兼容旧 clears（迁移为 sells all）
            if (Array.isArray(fund?.clears)) {
                for (const c of fund.clears) {
                    const date = (c?.date || '').toString();
                    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.push({ date, all: true, amount: null });
                }
            }
            out.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
            return out;
        }


        function getFirstHistoryPointOnOrAfter(code, dateStr) {
            const all = historyCache[code];
            if (!Array.isArray(all) || all.length === 0 || !dateStr) return null;
            for (let i = 0; i < all.length; i++) {
                const d = tsToDateStr(all[i].x);
                if (d >= dateStr) return { i, x: all[i].x, y: Number(all[i].y), date: d };
            }
            return null;
        }

        function getNextHistoryDate(code, dateStr) {
            const all = historyCache[code];
            if (!Array.isArray(all) || all.length === 0 || !dateStr) return '';
            for (let i = 0; i < all.length; i++) {
                const d = tsToDateStr(all[i].x);
                if (d > dateStr) return d;
            }
            return '';
        }

        function getHistoryPointByDate(code, dateStr) {
            const all = historyCache[code];
            if (!Array.isArray(all) || all.length === 0 || !dateStr) return null;
            for (let i = all.length - 1; i >= 0; i--) {
                const d = tsToDateStr(all[i].x);
                if (d === dateStr) return { i, x: all[i].x, y: Number(all[i].y), date: d };
                if (d < dateStr) break;
            }
            return null;
        }

        function getPrevHistoryPoint(code, dateStr) {
            const p = getHistoryPointByDate(code, dateStr);
            if (!p) return null;
            const all = historyCache[code];
            const i = p.i - 1;
            if (!Array.isArray(all) || i < 0) return null;
            return { i, x: all[i].x, y: Number(all[i].y), date: tsToDateStr(all[i].x) };
        }

        function getLatestOfficialHistoryPoint(code) {
            const all = historyCache[code];
            if (!Array.isArray(all) || all.length === 0) return null;
            const last = all[all.length - 1];
            const y = Number(last?.y);
            const x = last?.x;
            const date = tsToDateStr(x);
            if (!Number.isFinite(y) || y <= 0) return null;
            return { i: all.length - 1, x, y, date };
        }

        function extractBaiduNewestDayGrowth(json) {
            // 目标：抓取 gushitong 返回中的 newest:
            //   [{ text: '日涨幅(02-27)', value: '+2.56%' }, { text: '净值', value: '1.1802' }, ...]
            // 注意：结构可能很深，因此做递归查找
            const sh = getShanghaiTimeParts();
            const year = sh.year;

            function parseNewest(arr) {
                if (!Array.isArray(arr)) return null;
                let dateStr = '';
                let chg = NaN;
                let nav = NaN;
                for (const it of arr) {
                    const text = (it?.text || '').toString();
                    const value = (it?.value ?? it?.val ?? '').toString();
                    if (!text || !value) continue;
                    if ((text.includes('日涨') || text.includes('日跌'))) {
                        const m = text.match(/\((\d{2})-(\d{2})\)/);
                        if (m) {
                            const mm = m[1];
                            const dd = m[2];
                            dateStr = `${year}-${mm}-${dd}`;
                            const v = Number(value.replace('%', '').trim());
                            if (Number.isFinite(v)) chg = v;
                        }
                    } else if (text === '净值') {
                        const v = Number(value.trim());
                        if (Number.isFinite(v) && v > 0) nav = v;
                    }
                }
                if (!dateStr && !Number.isFinite(chg) && !Number.isFinite(nav)) return null;
                return { dateStr, chg, nav };
            }

            const seen = new Set();
            function walk(node) {
                if (!node) return null;
                if (typeof node !== 'object') return null;
                if (seen.has(node)) return null;
                seen.add(node);

                if (Array.isArray(node)) {
                    for (const x of node) {
                        const r = walk(x);
                        if (r) return r;
                    }
                    return null;
                }

                if (Object.prototype.hasOwnProperty.call(node, 'newest')) {
                    const r0 = parseNewest(node.newest);
                    if (r0) return r0;
                }

                for (const k of Object.keys(node)) {
                    const r = walk(node[k]);
                    if (r) return r;
                }
                return null;
            }

            return walk(json);
        }

        function buildGushitongSources(targetUrl, options = {}) {
            const proxyOff = (localStorage.getItem('BAIDU_PROXY_OFF') || '') === '1';
            const corsProxy = ((localStorage.getItem('BAIDU_CORS_PROXY') || '').trim() || 'https://api.allorigins.win/get?url=');
            const allowDirect = (localStorage.getItem('BAIDU_DIRECT') || '') === '1';
            const timeoutJsonp = Number.isFinite(options.timeoutJsonpMs) ? Number(options.timeoutJsonpMs) : 2500;
            const timeoutProxy = Number.isFinite(options.timeoutProxyMs) ? Number(options.timeoutProxyMs) : 10000;
            const timeoutDirect = Number.isFinite(options.timeoutDirectMs) ? Number(options.timeoutDirectMs) : 9000;

            async function fetchViaProxy(url, proxyPrefix) {
                const proxyUrl = `${proxyPrefix}${encodeURIComponent(url)}`;
                const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeoutProxy) });
                if (!res.ok) throw new Error(`proxy http ${res.status}`);
                let payload;
                try {
                    payload = await res.json();
                } catch {
                    const text = await res.text();
                    payload = JSON.parse(text);
                }
                const raw = payload && typeof payload === 'object' && typeof payload.contents === 'string'
                    ? payload.contents
                    : payload;
                if (typeof raw === 'string') return JSON.parse(raw);
                return raw;
            }

            const sources = [];
            sources.push({
                name: 'gushitong_jsonp',
                fetch: async () => {
                    try {
                        return await fetchJsonp(targetUrl, 'cb', timeoutJsonp);
                    } catch {
                        return await fetchJsonp(targetUrl, 'callback', timeoutJsonp);
                    }
                }
            });
            if (!proxyOff && corsProxy) {
                sources.push({
                    name: 'gushitong_proxy',
                    fetch: async () => await fetchViaProxy(targetUrl, corsProxy)
                });
            }
            if (allowDirect) {
                sources.push({
                    name: 'gushitong_direct',
                    fetch: async () => {
                        const res = await fetch(targetUrl, { signal: AbortSignal.timeout(timeoutDirect) });
                        return await res.json();
                    }
                });
            }
            return sources;
        }

        async function fetchBaiduNewestForFund(fund, options = {}) {
            if (!fund || !fund.code) return false;
            const st0 = getMarketStatus();
            if (st0 && (st0.canRealtimeUpdate || st0.reason === '午间休市')) return false;
            const url = `https://gushitong.baidu.com/opendata?resource_id=5803&query=${fund.code}&new_need_di=1&source=qieman`;
            const sources = buildGushitongSources(url, options);

            for (const src of sources) {
                try {
                    const json = await runWithSourceStat(`newest_${src.name}`, async () => await src.fetch());
                    const newest = extractBaiduNewestDayGrowth(json);
                    if (newest && newest.dateStr) {
                        if (Number.isFinite(newest.chg)) fund._baiduNewestDayGrowth = newest.chg;
                        if (Number.isFinite(newest.nav)) fund._baiduNewestNav = newest.nav;
                        fund._baiduNewestDayGrowthDate = newest.dateStr;
                        return true;
                    }
                } catch {
                }
            }
            return false;
        }

        function calcPositionMetricsOfficialT2FromBuys(fund) {
            if (!fund || !fund.code) return { ok: false };
            const buys = getFundBuys(fund);
            const sells = getFundSells(fund);
            // 有卖出时，暂时回退到原算法，避免口径/剩余份额追踪出错
            if (Array.isArray(sells) && sells.length > 0) return { ok: false };
            if (!Array.isArray(buys) || buys.length === 0) return { ok: false };

            const latest = getLatestOfficialHistoryPoint(fund.code);
            if (!latest) return { ok: false };

            let invested = 0;
            let value = 0;
            const pending = [];

            for (const b of buys) {
                const amount = Number(b?.amount);
                const dateStr = (b?.date || '').toString();
                if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

                const bp = getFirstHistoryPointOnOrAfter(fund.code, dateStr);
                if (!bp || !bp.date || !Number.isFinite(bp.y) || bp.y <= 0) {
                    pending.push({ amount, date: dateStr, effectiveDate: bp?.date || null });
                    continue;
                }

                invested += amount;
                const buyIdx = Number(bp.i);
                // 规则：买入后的下一交易日开始按官方净值反映收益（T+1）。
                // 若最新披露日 <= 买入生效日，则视为尚未开始计收益，价值按本金计。
                if (Number.isFinite(buyIdx) && latest.i <= buyIdx) {
                    value += amount;
                    continue;
                }

                const shares = amount / Number(bp.y);
                if (!Number.isFinite(shares) || shares <= 0) {
                    value += amount;
                    continue;
                }
                value += shares * latest.y;
            }

            if (!Number.isFinite(invested) || invested <= 0) return { ok: false, pendingBuys: pending };
            const profit = value - invested;
            const profitPct = invested ? (profit / invested * 100) : NaN;
            return { ok: true, invested, value, profit, profitPct, pendingBuys: pending, nav: latest.y, navDate: latest.date };
        }

        function getPositionFromBuy(fund) {
            const buys = getFundBuys(fund);
            const sells = getFundSells(fund);
            if (!buys.length && !sells.length) return { has: false };

            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;

            let invested = 0;
            let shares = 0;
            let realizedProfit = 0;
            let totalBuyAmount = 0;
            const pending = [];

            const txs = [];
            for (const b of buys) {
                const bp = getFirstHistoryPointOnOrAfter(fund.code, b.date);
                if (!bp || !bp.date) { pending.push({ amount: b.amount, date: b.date, effectiveDate: null }); continue; }
                if (bp.date > todayStr) { pending.push({ amount: b.amount, date: b.date, effectiveDate: bp.date }); continue; }
                const nav0 = Number(bp.y);
                if (!Number.isFinite(nav0) || nav0 <= 0) { pending.push({ amount: b.amount, date: b.date, effectiveDate: bp.date }); continue; }
                txs.push({ type: 'buy', effDate: bp.date, amount: b.amount, nav: nav0, inputDate: b.date });
            }
            for (const s of sells) {
                const bp = getFirstHistoryPointOnOrAfter(fund.code, s.date);
                if (!bp || !bp.date) continue;
                if (bp.date > todayStr) continue;
                const nav0 = Number(bp.y);
                if (!Number.isFinite(nav0) || nav0 <= 0) continue;
                txs.push({ type: 'sell', effDate: bp.date, amount: s.amount, all: !!s.all, nav: nav0, inputDate: s.date });
            }
            txs.sort((a, b) => (a.effDate < b.effDate ? -1 : (a.effDate > b.effDate ? 1 : (a.type === b.type ? 0 : (a.type === 'buy' ? -1 : 1)))));

            for (const tx of txs) {
                if (tx.type === 'buy') {
                    const sh0 = tx.amount / tx.nav;
                    if (!Number.isFinite(sh0) || sh0 <= 0) continue;
                    shares += sh0;
                    invested += tx.amount;
                    totalBuyAmount += tx.amount;
                } else {
                    if (shares <= 0) continue;
                    const avgCost = invested > 0 ? (invested / shares) : 0;
                    let sellShares = 0;
                    if (tx.all) sellShares = shares;
                    else sellShares = tx.amount / tx.nav;
                    if (!Number.isFinite(sellShares) || sellShares <= 0) continue;
                    sellShares = Math.min(sellShares, shares);

                    const proceeds = sellShares * tx.nav;
                    realizedProfit += proceeds - (avgCost * sellShares);

                    shares -= sellShares;
                    invested -= avgCost * sellShares;
                    if (shares <= 0.00000001) { shares = 0; invested = 0; }
                    if (invested < 0) invested = 0;
                }
            }

            if (shares <= 0 || invested <= 0) return { has: false, pendingBuys: pending };
            return { has: true, invested, shares, realizedProfit, totalBuyAmount, pendingBuys: pending };
        }

        function getPositionFromLegacy(fund) {
            const cost = Number(fund?.holdingCost);
            const shares = Number(fund?.holdingShares);
            if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(shares) || shares <= 0) return { has: false };
            const amount = cost * shares;
            return { has: true, invested: amount, shares };
        }

        function getPosition(fund) {
            const p = getPositionFromBuy(fund);
            if (p.has) return p;
            return getPositionFromLegacy(fund);
        }

        function calcPositionMetrics(pos, nav) {
            if (!pos || !pos.has || !Number.isFinite(nav) || nav <= 0) return { ok: false };
            const invested = Number(pos.invested);
            const shares = Number(pos.shares);
            if (!Number.isFinite(invested) || invested <= 0 || !Number.isFinite(shares) || shares <= 0) return { ok: false };

            const value = shares * nav;
            const realizedProfit = Number(pos.realizedProfit) || 0;
            const profit = (value - invested) + realizedProfit;
            const base0 = Number(pos.totalBuyAmount);
            const base = (Number.isFinite(base0) && base0 > 0) ? base0 : invested;
            const profitPct = base ? (profit / base * 100) : NaN;
            return { ok: true, invested, value, profit, profitPct };
        }

        function calcDailyProfitForFund(fund) {
            const pos = getPosition(fund);
            if (!pos || !pos.has) return { ok: false };

            const status = getMarketStatus();
            const shProfit = getShanghaiTimeParts();
            const todayStr = `${shProfit.year}-${String(shProfit.month).padStart(2,'0')}-${String(shProfit.day).padStart(2,'0')}`;
            const navDateStr = getDateStr(fund.navDate);
            const estDateStr = getDateStr(fund.estimatedTime);
            const officialNav0 = parseFloat(fund.currentNav);
            const estNav0 = Number(fund.estimatedNav);
            const hasTodayOfficial0 = (navDateStr === todayStr) && Number.isFinite(officialNav0) && officialNav0 > 0;

            const mins0 = shProfit.hour * 60 + shProfit.minute;
            const isTrading0 = !!(status && status.isOpen);
            const isMiddayBreak0 = !!(status && status.reason === '午间休市');
            // 今日估值：
            // - 若带日期且为今日：直接视为今日估值
            // - 若不带日期/日期解析失败：在盘前/交易中/午休/盘后补全等“可能出现估值更新”的时段，只要 estimatedNav 有效就视为今日估值
            const canShowEst0 = !!(status && (status.reason === '盘前' || status.isOpen || status.reason === '午间休市' || status.reason === '盘后补全'));
            const hasTodayEst0 = (Number.isFinite(estNav0) && estNav0 > 0) && ((estDateStr === todayStr) || (!estDateStr && canShowEst0));

            // 盘前（09:15-09:30）：今日估值已到但今日官方未披露 -> 清空当日盈亏。
            const isPreOpen0 = !!(status && status.reason === '盘前') && mins0 >= (9 * 60 + 15) && mins0 < (9 * 60 + 30);
            if (isPreOpen0 && hasTodayEst0 && !hasTodayOfficial0) {
                return { ok: false };
            }

            // 准备历史净值（官方披露）
            const raw = historyCache[fund.code];
            const hasHistory = Array.isArray(raw) && raw.length >= 1;
            const last = hasHistory ? raw[raw.length - 1] : null;
            const prev = (Array.isArray(raw) && raw.length >= 2) ? raw[raw.length - 2] : null;
            const lastNav = last ? Number(last.y) : NaN;
            const lastDate = last ? tsToDateStr(last.x) : '';
            const prevNav = prev ? Number(prev.y) : NaN;
            const prevDate = prev ? tsToDateStr(prev.x) : '';

            // 今日官方已披露：用(今日官方-昨日官方)*昨日份额
            if (hasTodayOfficial0 && Number.isFinite(prevNav) && prevNav > 0 && prevDate) {
                const sharesPrev0 = calcSharesAsOfDate(fund.code, fund, prevDate);
                if (Number.isFinite(sharesPrev0) && sharesPrev0 > 0) {
                    const dailyProfit0 = (officialNav0 - prevNav) * sharesPrev0;
                    const prevValue0 = prevNav * sharesPrev0;
                    const todayValue0 = officialNav0 * sharesPrev0;
                    return { ok: true, dailyProfit: dailyProfit0, prevValue: prevValue0, todayValue: todayValue0 };
                }
            }

            // 交易中且今日官方未披露：若有“今日估值”，用(今日估值-最新披露官方)*最新披露日份额，随估值更新。
            if ((isTrading0 || isMiddayBreak0) && hasTodayEst0 && Number.isFinite(lastNav) && lastNav > 0 && lastDate) {
                const sharesLast0 = calcSharesAsOfDate(fund.code, fund, lastDate);
                if (Number.isFinite(sharesLast0) && sharesLast0 > 0) {
                    const prevValue0 = lastNav * sharesLast0;
                    const dayGrowth0 = parseFloat(fund.dayGrowth);
                    if (Number.isFinite(dayGrowth0)) {
                        const dailyProfit0 = prevValue0 * (dayGrowth0 / 100);
                        const todayValue0 = prevValue0 + dailyProfit0;
                        return { ok: true, dailyProfit: dailyProfit0, prevValue: prevValue0, todayValue: todayValue0 };
                    }
                    const dailyProfit0 = (estNav0 - lastNav) * sharesLast0;
                    const todayValue0 = estNav0 * sharesLast0;
                    return { ok: true, dailyProfit: dailyProfit0, prevValue: prevValue0, todayValue: todayValue0 };
                }
            }

            // 非交易时段：用最新两天官方历史净值差分（展示上一披露日的当日盈亏）
            if (Number.isFinite(lastNav) && lastNav > 0 && Number.isFinite(prevNav) && prevNav > 0 && prevDate) {
                const sharesPrev0 = calcSharesAsOfDate(fund.code, fund, prevDate);
                if (Number.isFinite(sharesPrev0) && sharesPrev0 > 0) {
                    const dailyProfit0 = (lastNav - prevNav) * sharesPrev0;
                    const prevValue0 = prevNav * sharesPrev0;
                    const todayValue0 = lastNav * sharesPrev0;
                    return { ok: true, dailyProfit: dailyProfit0, prevValue: prevValue0, todayValue: todayValue0 };
                }
            }

            return { ok: false };
        }

        async function ensureHistoryForPositionIfNeeded(fund) {
            if (!fund || !fund.code) return;
            if (historyCache[fund.code]) return;
            const buys = getFundBuys(fund);
            const sells = getFundSells(fund);
            if ((!Array.isArray(buys) || buys.length === 0) && (!Array.isArray(sells) || sells.length === 0)) return;
            try {
                await fetchHistoryData(fund.code, false);
            } catch (e) {
                // ignore
            }
        }

        function syncOverviewAfterPositionChange(fund) {
            const main0 = document.querySelector('.main-content');
            if (!main0 || !main0.classList.contains('overview-mode')) return;
            renderFundOverview();
            ensureHistoryForPositionIfNeeded(fund).then(() => {
                if (main0.classList.contains('overview-mode')) renderFundOverview();
            });
        }

        function updateAllPositionSummary() {
            const amountEl = document.getElementById('allPositionAmount');
            const profitEl = document.getElementById('allPositionProfit');
            if (!amountEl || !profitEl) return;

            amountEl.className = '';
            profitEl.className = '';
            amountEl.style.color = 'rgba(255,255,255,0.95)';
            profitEl.style.color = 'rgba(255,255,255,0.95)';

            let totalValue = 0;
            let totalProfit = 0;
            let hasAny = false;

            for (const f of funds) {
                const pos = getPosition(f);
                if (!pos.has) continue;
                hasAny = true;
                const m2 = calcPositionMetricsOfficialT2FromBuys(f);
                if (m2 && m2.ok) {
                    totalValue += m2.value;
                    totalProfit += m2.profit;
                    continue;
                }
                // 回退：若无法用官方历史净值口径（缺历史/有卖出等），用原口径
                const todayProfitStr = getShanghaiTodayStr();
                const navDateProfitStr = getDateStr(f.navDate);
                const officialNav0 = parseFloat(f.currentNav);
                const dispNav0 = parseFloat(getDisplayNav(f));
                const nav = (navDateProfitStr === todayProfitStr && Number.isFinite(officialNav0)) ? officialNav0 : dispNav0;
                if (!Number.isFinite(nav)) continue;
                const m = calcPositionMetrics(pos, nav);
                if (!m.ok) continue;
                totalValue += m.value;
                totalProfit += m.profit;
            }

            if (!hasAny) {
                amountEl.textContent = '--';
                profitEl.textContent = '--';
                return;
            }

            amountEl.textContent = '¥' + totalValue.toFixed(2);
            profitEl.textContent = '¥' + totalProfit.toFixed(2);
        }
        
        async function addFund() {
            const code = document.getElementById('fundCode').value.trim();
            if (!/^\d{6}$/.test(code)) return showToast('请输入6位数字基金代码', 'error');
            if (funds.some(f => f.code === code)) return showToast('该基金已存在', 'error');
            const buyAmount = parseFloat(document.getElementById('buyAmount').value);
            const buyDate = (document.getElementById('buyDate').value || '').trim();
            const hasBuy = Number.isFinite(buyAmount) && buyAmount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(buyDate);
            const fund = { code, buys: hasBuy ? [{ amount: buyAmount, date: buyDate }] : [], buyAmount: null, buyDate: null, name: '加载中...', currentNav: '--', dayGrowth: '--' };
            funds.push(fund); saveFunds(); renderFundList();
            document.getElementById('fundCode').value = ''; document.getElementById('buyAmount').value = ''; document.getElementById('buyDate').value = '';

            await fetchFundData(fund);
            renderFundList();
            const mainContent = document.querySelector('.main-content');
            if (mainContent && mainContent.classList.contains('overview-mode')) {
                renderFundOverview();
            }

            showToast(`已添加 ${fund.name || fund.code || code}`);
            // 新增后直接选中该基金，避免仍停留在旧基金详情导致看到旧的“更新于”
            try { selectFund(fund); } catch (e) { /* ignore */ }
            if (window.innerWidth <= 768) { closeMobileSidebar(); }
        }
        
        function deleteFund(code) {
            if (!confirm('确认删除该基金？')) return;
            const removed = funds.find(f => f.code === code) || null;
            funds = funds.filter(f => f.code !== code); saveFunds();
            if (miniCharts[code]) { miniCharts[code].dispose(); delete miniCharts[code]; }

            const mainContent = document.querySelector('.main-content');
            const inOverview = !!(mainContent && mainContent.classList.contains('overview-mode'));

            if (selectedFund?.code === code) selectedFund = funds[0] || null;
            renderFundList();
            if (inOverview) {
                renderFundOverview();
            } else {
                if (selectedFund) selectFund(selectedFund);
            }
            showToast(`已删除 ${removed?.name || removed?.code || code}`);
        }

        function selectFund(fund) {
            selectedFund = fund; 
            updateFundListActiveOnly(fund?.code);
            updateMainDisplay(fund); 
            refreshLock = refreshLock.then(async () => {
                try {
                    await fetchFundData(fund, { suppressRender: true });
                    try { await fetchBaiduNewestForFund(fund); } catch (e) { }

                    try { await loadHoldingsAndSectors(fund, { silent: true }); } catch (e) { }
                    try { await fetchHistoryData(fund.code, currentTimeRange !== 'realtime'); } catch (e) { }

                    saveFunds();
                    renderFundList();
                    updateMainDisplay(fund);
                    if (currentTimeRange === 'realtime') updateRealtimeChart();
                } catch (e) {
                }
            });
            if (currentTimeRange === 'realtime') { updateRealtimeChart(); startRealtimeUpdate(); }
            if (window.innerWidth <= 768) { closeMobileSidebar(); }
            
            // 切换到详情视图
            const mainContent = document.querySelector('.main-content');
            if (mainContent) mainContent.classList.remove('overview-mode');
            
            // 移动端：进入详情视图时显示概览按钮
            if (window.innerWidth <= 768) {
                const mobileOverviewBtn = document.getElementById('mobileOverviewBtn');
                if (mobileOverviewBtn) mobileOverviewBtn.style.display = 'flex';
            }
        }

        // 渲染基金概览视图
        function renderFundOverview() {
            const list = document.getElementById('overviewGrid');
            if (!list) return;
            
            // 修改容器class
            list.className = 'overview-list';
            
            if (funds.length === 0) {
                list.innerHTML = `
                    <div class="overview-empty">
                        <div class="overview-empty-icon">📊</div>
                        <div class="overview-empty-text">还没有添加基金</div>
                        <div class="overview-empty-subtext">从左侧添加基金开始监控</div>
                    </div>
                `;
                // 更新统计卡片为空状态
                updateOverviewStats({ totalCount: 0, holdingCount: 0, totalDailyProfit: 0, totalDailyReturnPct: NaN, moodDayGrowthPct: NaN, latestUpdateText: '--' });
                return;
            }
            
            // 计算统计数据
            let holdingCount = 0;
            let totalDailyProfit = 0;
            let totalPrevValue = 0;
            let allDayGrowthSum = 0;
            let allDayGrowthCount = 0;
            let latestUpdateMin = -1;
            let latestUpdateText = '--';
            
            // 使用 DocumentFragment 批量操作
            const fragment = document.createDocumentFragment();
            const tempDiv = document.createElement('div');

            const summaryHtml = `
                <div class="overview-card overview-summary-card">
                    <div class="overview-card-info">
                        <div class="overview-card-name">概览汇总</div>
                        <div class="overview-card-code">今日</div>
                    </div>
                    <div class="overview-card-metric">
                        <div class="overview-card-metric-label">持仓基金</div>
                        <div class="overview-card-metric-value" id="overviewHoldingCount">--</div>
                    </div>
                    <div class="overview-card-metric">
                        <div class="overview-card-metric-label">日收益率</div>
                        <div class="overview-card-metric-value" id="overviewDailyReturn">--</div>
                    </div>
                    <div class="overview-card-metric">
                        <div class="overview-card-metric-label">当日盈亏</div>
                        <div class="overview-card-metric-value" id="overviewDailyProfit">--</div>
                    </div>
                    <div class="overview-card-time">
                        <div class="overview-card-time-label">更新时间</div>
                        <div class="overview-card-time-value" id="overviewSummaryUpdateTime">--</div>
                    </div>
                    <div class="overview-card-actions">
                        <button class="btn-icon" type="button" onclick="event.stopPropagation();" title="收益率情绪"><span id="overviewMoodReturn">😐</span></button>
                        <button class="btn-icon" type="button" onclick="event.stopPropagation();" title="盈亏情绪"><span id="overviewMoodProfit">😶</span></button>
                    </div>
                    <div class="overview-card-break"></div>
                </div>
            `;
            
            tempDiv.innerHTML = summaryHtml + funds.map(fund => {
                const displayNav = getDisplayNav(fund);
                const dayGrowth = getDisplayDayGrowth(fund);
                const isPositive = dayGrowth >= 0;
                const isOfficial0 = (fund && String(fund._dayGrowthSource || '') === 'official');

                if (Number.isFinite(dayGrowth)) {
                    allDayGrowthSum += dayGrowth;
                    allDayGrowthCount++;
                }
                
                // 格式化更新时间
                const updateTime = fund.lastUpdateTime || '--';
                const timeMatch = updateTime.match(/(\d{2}:\d{2})/);
                const displayTime = timeMatch ? timeMatch[1] : '--';
                if (displayTime && displayTime !== '--' && /^\d{2}:\d{2}$/.test(displayTime)) {
                    const hm = displayTime.split(':');
                    const tmin = Number(hm[0]) * 60 + Number(hm[1]);
                    if (Number.isFinite(tmin) && tmin > latestUpdateMin) {
                        latestUpdateMin = tmin;
                        latestUpdateText = displayTime;
                    }
                }
                
                // 获取持仓信息
                const pos = getPosition(fund);
                let positionInfo = '';
                if (pos.has) {
                    holdingCount++;
                    const dp = calcDailyProfitForFund(fund);
                    if (dp.ok) {
                        const v = Number(dp.dailyProfit) || 0;
                        totalDailyProfit += v;
                        const pv = Number(dp.prevValue);
                        if (Number.isFinite(pv) && pv > 0) totalPrevValue += pv;
                        
                        const cls = v >= 0 ? 'positive' : 'negative';
                        positionInfo = `
                            <div class="overview-card-metric">
                                <div class="overview-card-metric-label">当日盈亏</div>
                                <div class="overview-card-metric-value ${cls}">¥${v.toFixed(2)}</div>
                            </div>
                        `;
                    }
                }
                
                if (!positionInfo) {
                    positionInfo = `
                        <div class="overview-card-metric">
                            <div class="overview-card-metric-label">当日盈亏</div>
                            <div class="overview-card-metric-value">--</div>
                        </div>
                    `;
                }
                
                return `
                    <div class="overview-card${isOfficial0 ? ' official' : ''}" data-code="${fund.code}">
                        <div class="overview-card-info">
                            <div class="overview-card-name">${fund.name || '加载中...'}</div>
                            <div class="overview-card-code">${fund.code}</div>
                        </div>
                        <div class="overview-card-metric">
                            <div class="overview-card-metric-label">估算净值</div>
                            <div class="overview-card-metric-value">${displayNav}</div>
                        </div>
                        <div class="overview-card-metric">
                            <div class="overview-card-metric-label">日涨跌幅</div>
                            <div class="overview-card-metric-value ${isPositive ? 'positive' : 'negative'}">
                                ${Number.isFinite(dayGrowth) ? (dayGrowth >= 0 ? '+' : '') + dayGrowth.toFixed(2) + '%' : '--'}
                            </div>
                        </div>
                        ${positionInfo}
                        <div class="overview-card-time">
                            <div class="overview-card-time-label">更新时间</div>
                            <div class="overview-card-time-value">${displayTime}</div>
                        </div>
                        <div class="overview-card-actions">
                            <button class="btn-icon" onclick="event.stopPropagation(); openPosModal('${fund.code}')" title="编辑持仓">✏️</button>
                            <button class="btn-icon" onclick="event.stopPropagation(); deleteFund('${fund.code}')" title="删除">🗑️</button>
                        </div>
                        <div class="overview-card-break"></div>
                    </div>
                `;
            }).join('');
            
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }
            
            // 一次性替换DOM
            list.innerHTML = '';
            list.appendChild(fragment);
            
            // 使用事件委托
            list.removeEventListener('click', handleOverviewClick);
            list.addEventListener('click', handleOverviewClick);
            
            // 更新统计卡片
            updateOverviewStats({
                totalCount: funds.length,
                holdingCount,
                totalDailyProfit,
                totalDailyReturnPct: (Number.isFinite(totalPrevValue) && totalPrevValue > 0) ? (totalDailyProfit / totalPrevValue * 100) : NaN,
                moodDayGrowthPct: (allDayGrowthCount > 0) ? (allDayGrowthSum / allDayGrowthCount) : NaN,
                latestUpdateText
            });
        }

        function updateOverviewStats(stats) {
            const holdingCountEl = document.getElementById('overviewHoldingCount');
            const dailyReturnEl = document.getElementById('overviewDailyReturn');
            const dailyProfitEl = document.getElementById('overviewDailyProfit');
            const updateTimeEl = document.getElementById('overviewSummaryUpdateTime');
            const moodProfitEl = document.getElementById('overviewMoodProfit');
            const moodReturnEl = document.getElementById('overviewMoodReturn');
            
            if (!holdingCountEl || !dailyReturnEl || !dailyProfitEl || !updateTimeEl) return;
            
            const { totalCount, holdingCount, totalDailyProfit, totalDailyReturnPct, moodDayGrowthPct, latestUpdateText } = stats;
            
            // 持仓基金数量
            holdingCountEl.textContent = Number.isFinite(totalCount) ? `${holdingCount}/${totalCount}` : '--';
            
            // 日收益率
            if (Number.isFinite(totalDailyReturnPct) && totalDailyReturnPct !== 0) {
                dailyReturnEl.textContent = (totalDailyReturnPct >= 0 ? '+' : '') + totalDailyReturnPct.toFixed(2) + '%';
                dailyReturnEl.className = `overview-card-metric-value ${totalDailyReturnPct >= 0 ? 'positive' : 'negative'}`;
            } else {
                dailyReturnEl.textContent = '--';
                dailyReturnEl.className = 'overview-card-metric-value';
            }
            
            // 当日盈亏
            if (Number.isFinite(totalDailyProfit) && totalDailyProfit !== 0) {
                dailyProfitEl.textContent = '¥' + totalDailyProfit.toFixed(2);
                dailyProfitEl.className = `overview-card-metric-value ${totalDailyProfit >= 0 ? 'positive' : 'negative'}`;
            } else {
                dailyProfitEl.textContent = '--';
                dailyProfitEl.className = 'overview-card-metric-value';
            }
            
            updateTimeEl.textContent = (latestUpdateText && latestUpdateText !== '--') ? latestUpdateText : '--';

            if (moodProfitEl) {
                const v = Number(totalDailyProfit);
                moodProfitEl.textContent = (Number.isFinite(v) && v > 0.01) ? '🤑' : ((Number.isFinite(v) && v < -0.01) ? '😭' : '😶');
            }
            if (moodReturnEl) {
                const r = Number(moodDayGrowthPct);
                moodReturnEl.textContent = (Number.isFinite(r) && r > 0.01) ? '😄' : ((Number.isFinite(r) && r < -0.01) ? '😞' : '😐');
            }
        }

        function handleOverviewClick(e) {
            const card = e.target.closest('.overview-card');
            if (!card) return;
            if (e.target.closest('.overview-card-actions')) return;
            const code = card.dataset.code;
            if (code) selectFundFromOverview(code);
        }

        function selectFundFromOverview(code) {
            const fund = funds.find(f => f.code === code);
            if (fund) selectFund(fund);
        }

        // 返回概览视图
        function showOverviewMode() {
            const mainContent = document.querySelector('.main-content');
            if (mainContent) mainContent.classList.add('overview-mode');
            
            // 移动端：进入概览模式时隐藏概览按钮
            const mobileOverviewBtn = document.getElementById('mobileOverviewBtn');
            if (mobileOverviewBtn) mobileOverviewBtn.style.display = 'none';
            
            renderFundOverview();

            // 预热：概览页的“当日盈亏”依赖 historyCache 计算买入份额；后台补齐后自动重绘
            Promise.all(funds.map(f => ensureHistoryForPositionIfNeeded(f))).then(() => {
                const main = document.querySelector('.main-content');
                if (main && main.classList.contains('overview-mode')) renderFundOverview();
            });
        }

        // 一键刷新所有基金数据
        async function refreshAllFunds(options = {}) {
            const fromInit = !!options.fromInit;
            const skipHistory = !!options.skipHistory;
            const btn = document.getElementById('overviewRefreshBtn');
            if (!fromInit) {
                if (!btn) return;
                if (typeof btn.blur === 'function') btn.blur();
                if (btn.disabled) return;
                btn.classList.add('refreshing');
                btn.disabled = true;
            }

            try {
                const status = skipHistory ? null : getMarketStatus();
                const shNow0 = skipHistory ? null : getShanghaiTimeParts();
                const todayStr0 = skipHistory ? '' : `${shNow0.year}-${String(shNow0.month).padStart(2,'0')}-${String(shNow0.day).padStart(2,'0')}`;

                const concurrency = Math.max(1, Number(options.concurrency) || 10);
                const list = Array.isArray(funds) ? funds.slice() : [];
                let cursor = 0;

                const worker = async () => {
                    while (cursor < list.length) {
                        const idx = cursor++;
                        const fund = list[idx];
                        if (!fund) continue;

                        await refreshOneFundFull(fund, {
                            suppressRender: true,
                            includeHoldings: false,
                            newestOptions: { timeoutDirectMs: 8000, timeoutProxyMs: 9000 },
                            refreshHistoryForDayGrowth: !skipHistory,
                            skipPositionHistory: skipHistory
                        });

                        if (skipHistory) continue;

                        const navDateStr0 = getDateStr(fund.navDate);
                        const needPromoteOfficialNav0 = navDateStr0 && navDateStr0 < todayStr0 && (status.reason === '盘后' || status.reason === '盘后补全' || !status.canRealtimeUpdate);
                        if (needPromoteOfficialNav0) {
                            try {
                                const off = getOfficialDayGrowthFromHistoryWithDate(fund);
                                if (Number.isFinite(off.chg) && off.date) {
                                    fund._officialDayGrowth = off.chg;
                                    fund._officialDayGrowthDate = off.date;
                                }
                            } catch (e) {
                                // ignore
                            }
                        }
                    }
                };

                await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()));

                saveFunds();
                renderFundList();
                renderFundOverview();
                if (!fromInit) showToast('所有基金数据已刷新');
            } catch (error) {
                console.error('刷新失败:', error);
                if (!fromInit) showToast('刷新失败，请稍后重试', 'error');
            } finally {
                if (!fromInit) {
                    btn.classList.remove('refreshing');
                    btn.disabled = false;
                    if (typeof btn.blur === 'function') btn.blur();
                }
            }
        }

        function getSecId(code) {
            if (!code) return "";
            // 过滤掉可能存在的字母前缀（如 sh601228 提取为 601228）
            let pureCode = String(code).match(/\d{6}/);
            if (pureCode) {
                return pureCode[0];
            }
            return String(code).trim().substring(0, 6);
        }

        function getEastmoneySecId(code) {
            const c = getSecId(code);
            if (!/^\d{6}$/.test(c)) return c;
            // 上交所: 6xxxxx / 深交所&北交所等: 0xxxxx/3xxxxx/8xxxxx...
            return (c.startsWith('6') ? `1.${c}` : `0.${c}`);
        }

        function openStockDetail(code) {
            if (!code) return;
            const stockCode = getSecId(code);
            if (!/^\d{6}$/.test(stockCode)) {
                console.warn("股票代码格式非法:", stockCode);
                return;
            }
            // 构建百度小程序链接
            const url = `https://pqa9p2.smartapps.baidu.com/pages/quote/quote?code=${stockCode}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        }

        function normalizeStockChg(chg, status) {
            const v = (typeof chg === 'number') ? chg : Number(chg);
            if (!Number.isFinite(v)) return 0;
            // 盘前/周末：涨跌幅没有意义
            // 盘后：仍应展示收盘涨跌幅（接口返回的是当日收盘口径），不要归零
            if (status && status.canRealtimeUpdate === false) {
                const reason = status.reason;
                if (reason === '盘前' || reason === '周末休市') return 0;
            }
            // 防御：东财部分场景会返回 -100 作为缺失值
            if (Math.abs(v) >= 99.99) return 0;
            return v;
        }

        // ============================================================
        // 持仓加载 - 含 gushitong.baidu.com 新数据源（优先级最高）
        // ============================================================
        function isLikelyNoStockHoldingsFund(fund) {
            const name = (fund?.name || '').toString();
            if (!name) return false;
            if (/\bETF\b/i.test(name)) return true;
            if (name.includes('债券') || name.includes('纯债') || name.includes('短债') || name.includes('货币') || name.includes('现金') || name.includes('理财')) return true;
            return false;
        }

        function setHoldingsSideVisible(visible) {
            const wrap = document.getElementById('holdingsSideWrap');
            if (wrap) wrap.style.display = visible ? '' : 'none';
            const card = document.getElementById('holdingsSideCard');
            if (card) card.style.display = visible ? '' : 'none';

            // 布局变化后需要手动触发 ECharts resize，否则画布可能保持旧宽度导致右侧留白
            try {
                if (chart && typeof chart.resize === 'function') {
                    requestAnimationFrame(() => requestAnimationFrame(() => chart.resize()));
                }
            } catch {}
        }

        async function loadHoldingsAndSectors(fund, options = {}) {
            const tbody = document.getElementById('holdingsTableBody');
            const tags = document.getElementById('sectorTags');
            const status0 = getMarketStatus();
            const blockBaidu0 = !!(status0 && (status0.canRealtimeUpdate || status0.reason === '午间休市'));

            // updateOnly: 只更新涨跌幅，不要重绘 DOM（避免闪跳）
            if (options.updateOnly) {
                await updateHoldingsChgOnly(fund);
                return;
            }

            // silent: 已经有内容时不要写“加载中...”覆盖造成闪跳
            if (!options.silent) {
                if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--gray-500); padding: 40px;">加载中...</td></tr>`;
                if (tags) tags.innerHTML = `<span style="font-size: 0.8125rem; color: var(--gray-500);">加载中...</span>`;
            }

            // --- 数据源1 (优先): gushitong.baidu.com ———————————————
            // 返回的JSON结构:
            //   Result[0].DisplayData.resultData.tplData.result.content.tabs[0 (持仓tab)]
            //     .content.heavyStock.body[]  → TOP 10 持仓股票
            //     .content.industryPositon.list[] → 行业板块占比
            let baiduSources = [];
            if (!blockBaidu0) {
                const baiduTargetUrl = `https://gushitong.baidu.com/opendata?resource_id=5803&query=${fund.code}&new_need_di=1&source=qieman`;
                baiduSources = buildGushitongSources(baiduTargetUrl, { timeoutProxyMs: 12000, timeoutDirectMs: 10000 });
            }

            let baiduData = null; // 解析后的结构化数据: { holdings: [...], sectors: [...] }
            const noStockHoldingsByType = isLikelyNoStockHoldingsFund(fund);

            if (!blockBaidu0) {
                for (const source of baiduSources) {
                    try {
                        const json = await runWithSourceStat(`holdings_${source.name}`, async () => await source.fetch());

                        // 百度 newest（当日官方日涨跌幅/净值）优先提取，供右侧“日涨跌幅”即时展示
                        try {
                            const newest = extractBaiduNewestDayGrowth(json);
                            if (newest && newest.dateStr) {
                                if (Number.isFinite(newest.chg)) fund._baiduNewestDayGrowth = newest.chg;
                                if (Number.isFinite(newest.nav)) fund._baiduNewestNav = newest.nav;
                                fund._baiduNewestDayGrowthDate = newest.dateStr;
                            }
                        } catch {
                            // ignore
                        }

                        // 深层解析路径
                        const result = json?.Result?.[0];
                        const tplData = result?.DisplayData?.resultData?.tplData?.result;
                        const tabs = tplData?.content?.tabs;

                        // tabs[0] 是 "持仓" tab (type: "position")
                        const positionTab = tabs?.find(t => t.type === 'position') || tabs?.[0];
                        const posContent = positionTab?.content;

                        // heavyStock.body → TOP 10 股票
                        const heavyStockBody = posContent?.heavyStock?.body;
                        // industryPositon.list → 行业板块
                        const industryList = posContent?.industryPositon?.list;
                        // heavyStock 更新日期
                        const holdingDate = posContent?.heavyStock?.titleHeader?.[1] || '';

                        if (!heavyStockBody || heavyStockBody.length === 0) {
                            if (noStockHoldingsByType) {
                                baiduData = { holdings: [], sectors: [], holdingDate: '' };
                                break;
                            }
                            throw new Error('heavyStock.body 为空');
                        }

                        // 映射持仓数据
                        const holdings = heavyStockBody.map(item => ({
                            name: item.name,                          // 股票名称
                            code: getSecId(item.code),                // 股票代码（统一为6位数字）
                            ratio: parseFloat(item.positionProportion?.replace('%', '')) || 0  // 占净值比例
                        }));

                        // 映射行业板块数据
                        const sectors = (industryList || []).map(item => ({
                            name: item.text,                          // 行业名称
                            weight: parseFloat(item.value?.replace('%', '')) || 0  // 占比
                        }));

                        baiduData = { holdings, sectors, holdingDate };
                        break;

                    } catch (error) {
                        console.warn(`❌ [持仓-${source.name}] 失败:`, error.message);
                        continue;
                    }
                }
            }

            // --- 数据源2 (备用): eastmoney HTML 爬取 ————————————————
            if (!baiduData) {
                try {
                    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&topline=10&code=${fund.code}&year=&month=&rt=${Date.now()}`;
                    const apidata = await fetchApidataViaScript(url, 'holdings_eastmoney_apidata');
                    const html = (apidata?.content || '').toString().replace(/\\r\\n/g, '').replace(/\\n/g, '').replace(/\\t/g, '').replace(/\\\//g, '/').replace(/\\\"/g, '"');
                    const doc = new DOMParser().parseFromString(html, 'text/html');
                    const tables = Array.from(doc.querySelectorAll('table'));
                    const table = tables.find(t => {
                        const thText = (t.querySelector('thead')?.textContent || t.textContent || '').replace(/\s+/g, '');
                        return thText.includes('股票代码') && thText.includes('股票名称') && thText.includes('占净值');
                    }) || tables[0];

                    let holdings = [];
                    if (table) {
                        const ths = Array.from(table.querySelectorAll('thead th'));
                        const norm = (s) => (s || '').replace(/\s+/g, '').replace(/\u00a0/g, '');
                        const idxCode = ths.findIndex(th => norm(th.textContent).includes('股票代码'));
                        const idxName = ths.findIndex(th => norm(th.textContent).includes('股票名称'));
                        const idxRatio = ths.findIndex(th => {
                            const t = norm(th.textContent);
                            return t.includes('占净值') || t.includes('占净值比例');
                        });

                        const rows = Array.from(table.querySelectorAll('tbody tr'));
                        holdings = rows.map(tr => {
                            const tds = Array.from(tr.querySelectorAll('td'));
                            if (tds.length === 0) return null;
                            const code = getSecId((tds[idxCode]?.textContent || '').trim());
                            const name = (tds[idxName]?.textContent || '').trim();
                            const ratioText = (tds[idxRatio]?.textContent || '').trim();
                            let ratio = 0;
                            const m = ratioText.match(/(\d+(\.\d+)?)/);
                            if (m) ratio = parseFloat(m[1]);
                            return { code, name, ratio };
                        }).filter(x => x && x.code && x.name).slice(0, 10);
                    }

                    if (holdings.length > 0) {
                        baiduData = { holdings, sectors: [], holdingDate: '' };
                    } else if (noStockHoldingsByType) {
                        baiduData = { holdings: [], sectors: [], holdingDate: '' };
                    }
                } catch (e) {
                    console.error('解析eastmoney持仓失败:', e);
                }
            }

            // --- 无数据退出 ——————————————————————————————————————————
            if (!baiduData) {
                console.error('💥 所有持仓数据源均失败或无数据');
                setHoldingsSideVisible(true);
                tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--gray-500);">数据加载失败，请稍后重试</td></tr>`;
                tags.innerHTML = `<span style="font-size: 0.8125rem; color: var(--gray-500);">加载失败</span>`;
                return;
            }

            // ETF/债券/货币等：不展示股票TOP10持仓
            if (!Array.isArray(baiduData.holdings) || baiduData.holdings.length === 0) {
                fund._noStockHoldings = true;
                try { delete holdingsCache[fund.code]; } catch {}
                setHoldingsSideVisible(false);
                return;
            }

            fund._noStockHoldings = false;
            setHoldingsSideVisible(true);

            // --- 渲染板块标签（行业占比）——————————————————————————————
            // 如果有Baidu行业数据直接用；否则后面从eastmoney股票行情里归并
            let sectorSource = 'baidu'; // 标记数据来源
            if (baiduData.sectors.length > 0) {
                tags.innerHTML = baiduData.sectors.slice(0, 6).map(s =>
                    `<span class="sector-tag">${s.name} ${s.weight.toFixed(1)}%</span>`
                ).join('');
            } else {
                sectorSource = 'eastmoney'; // 后续从行情归并
                tags.innerHTML = `<span style="font-size: 0.8125rem; color: var(--gray-500);">板块数据加载中...</span>`;
            }

            // --- 获取股票实时行情（涨跌幅）————————————————————————————
            const secids = baiduData.holdings.map(h => getEastmoneySecId(h.code)).filter(Boolean).join(',');
            const quoteUrl = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}&fields=f12,f3,f100&ut=fa5fd1943c7b386f172d6893dbfba10b&_=${Date.now()}`;

            let qjson;
            try {
                qjson = await runWithSourceStat('quote_ulist_np_get_jsonp', async () => await fetchJsonp(quoteUrl, 'cb', 8000));
            } catch {
                qjson = await runWithSourceStat('quote_ulist_np_get_jsonp_callback', async () => await fetchJsonp(quoteUrl, 'callback', 8000));
            }

            const diff = qjson?.data?.diff;
            const chgMap = {};
            const indMap = {};
            if (Array.isArray(diff)) {
                diff.forEach(item => {
                    const code = (item?.f12 || '').toString();
                    const chg = Number(item?.f3);
                    const ind = (item?.f100 || '').toString();
                    if (code) {
                        if (Number.isFinite(chg)) chgMap[code] = chg;
                        if (ind) indMap[code] = ind;
                    }
                });
            }

            const quotes = baiduData.holdings.map(h => {
                const chg0 = Number.isFinite(chgMap[h.code]) ? chgMap[h.code] : 0;
                const chg = normalizeStockChg(chg0, status0);
                return { ...h, chg, price: 0, industry: indMap[h.code] || '其他' };
            });

            // 统一变量：TOP10 权重/前十持仓占比合计用同一个 top10Weight，避免两处各算各的导致错乱
            const top10Weight = quotes.reduce((sum, h) => sum + (parseFloat(h.ratio) || 0), 0);
            const top10WeightTag = `<span class="sector-tag top10-weight">前十持仓占比合计：${top10Weight.toFixed(2)}%（股票持仓）</span>`;
            if (tags) {
                tags.innerHTML = top10WeightTag + tags.innerHTML;
            }

            // --- 渲染持仓表格 ————————————————————————————————————————
            let holdingDateLabel = '';
            if (baiduData.holdingDate) {
                holdingDateLabel = ` <span style="font-size:0.7rem;color:var(--gray-500);font-weight:500;">(${baiduData.holdingDate})</span>`;
            }
            document.querySelector('.table-header').innerHTML = `基金持仓（TOP 10）${holdingDateLabel}`;

            // 缓存当前 TOP10 列表，后续 updateHoldingsChgOnly 只更新涨跌幅
            fund._topHoldings = quotes.map(h => ({ code: h.code, name: h.name, ratio: h.ratio || 0 }));

            tbody.innerHTML = quotes.map(h => `
                <tr data-code="${h.code}" onclick="openStockDetail('${h.code}')">
                    <td>${h.name}</td>
                    <td style="font-family:'JetBrains Mono',monospace;font-size:0.8125rem;">${h.code}</td>
                    <td><strong>${h.ratio ? h.ratio.toFixed(2) + '%' : '--'}</strong></td>
                    <td class="holding-chg ${h.chg >= 0 ? 'positive' : 'negative'}"><strong>${(h.chg > 0 ? '+' : '') + h.chg.toFixed(2) + '%'}</strong></td>
                </tr>
            `).join('');

            // --- 如果板块数据来自eastmoney，从行情里归并行业信息 ————————
            if (sectorSource === 'eastmoney') {
                const sectors = {};
                quotes.forEach(h => {
                    const ind = h.industry || '其他';
                    if (!sectors[ind]) sectors[ind] = { name: ind, weight: 0, chg: [] };
                    sectors[ind].weight += (h.ratio || 0);
                    if (h.chg !== undefined) sectors[ind].chg.push(h.chg);
                });
                const sortedSectors = Object.values(sectors).map(s => ({ ...s, avgChg: s.chg.length > 0 ? s.chg.reduce((a, b) => a + b, 0) / s.chg.length : 0 })).sort((a, b) => b.weight - a.weight).slice(0, 6);
                const filteredSectors = sortedSectors.filter(s => s.name !== '其他');
                const sectorHtml = filteredSectors.map(s =>
                    `<span class="sector-tag">${s.name} ${s.weight.toFixed(1)}% ${s.avgChg !== 0 ? '(' + (s.avgChg >= 0 ? '+' : '') + s.avgChg.toFixed(2) + '%)' : ''}</span>`
                ).join('');
                tags.innerHTML = top10WeightTag + (sectorHtml || '');
            }

            // --- 计算日涨跌幅估算（核心算法）————————————————————————————
            // 公式: estimatedDayChg = Σ(w_i × chg_i) + (1 - W_top) × residual_rate
            //   w_i         = 第i个股票占净值比例 (%)，如 9.32 表示 9.32%
            //   chg_i       = 第i个股票今日实时涨跌幅 (%)
            //   W_top       = TOP10 总权重之和 (%)，如 62.86
            //   residual_rate = 剩余仓位的估算涨跌率
            //                   当 fundgz gszzl 可用时反推: residual = (gszzl - top10_contribution) / (100 - W_top)
            //                   当 gszzl 不可用或剩余权重为0时: residual = top10 加权平均涨跌率
            // 注意: w_i 是百分比值 (如9.32)，所以 Σ(w_i × chg_i) 的单位是 %×%，需要 /100 归一化
            {
                const status = getMarketStatus();
                if (status.canRealtimeUpdate || status.reason === '午间休市') {
                    // 计算 TOP10 加权贡献
                    let top10Contribution = 0; // TOP10 对涨跌的贡献 (%)
                    quotes.forEach(h => {
                        const w = h.ratio || 0;   // 占净值比例 (%)
                        const c = h.chg || 0;     // 今日涨跌幅 (%)
                        top10Contribution += (w / 100) * c; // w/100 把百分比转为比例，乘以chg(%)得到贡献(%)
                    });

                    let residualWeight = 100 - top10Weight; // 剩余仓位权重 (%)
                    let residualRate = 0;                    // 剩余仓位估算涨跌率 (%)

                    const fundgzGszzl = parseFloat(fund._fundgzDayGrowth); // fundgz 提供的整体估算涨跌幅 (%)
                    if (!isNaN(fundgzGszzl) && residualWeight > 0.01) {
                        // 用 fundgz 估算反推剩余仓位涨跌率
                        // gszzl ≈ top10_contribution + (residualWeight/100) × residualRate
                        // ⟹ residualRate = (gszzl - top10_contribution) / (residualWeight/100)
                        residualRate = (fundgzGszzl - top10Contribution) / (residualWeight / 100);
                        // 安全限制：剩余估算不能超过 TOP10 均值的 3倍，防止异常值
                        const top10AvgRate = top10Weight > 0 ? top10Contribution / (top10Weight / 100) : 0;
                        if (Math.abs(residualRate) > Math.abs(top10AvgRate) * 3 + 5) {
                            residualRate = top10AvgRate; // 回退到TOP10均值
                        }
                    } else if (top10Weight > 0) {
                        // gszzl 不可用时，用 TOP10 加权均值近似剩余部分
                        residualRate = top10Contribution / (top10Weight / 100);
                    }

                    // 最终估算涨跌幅：优先使用 fundgz 的整体估算（市场通用口径），避免因限幅/误差导致整体跑偏
                    const fallbackEst = top10Contribution + (residualWeight / 100) * residualRate;
                    const estDayChg = (!isNaN(fundgzGszzl)) ? fundgzGszzl : fallbackEst;

                    // 存入缓存供 updateMainDisplay 使用
                    holdingsCache[fund.code] = {
                        top10Weight: top10Weight,
                        top10Contribution: top10Contribution,
                        residualWeight: residualWeight,
                        residualRate: residualRate,
                        estDayChg: estDayChg,
                        timestamp: Date.now()
                    };
                }
            }
        }

        async function updateHoldingsChgOnly(fund) {
            const tbody = document.getElementById('holdingsTableBody');
            if (!tbody) return;
            const list = Array.isArray(fund?._topHoldings) ? fund._topHoldings : [];
            if (list.length === 0) return;

            const status0 = getMarketStatus();

            // 批量行情：一次请求拿到 TOP10 全部股票涨跌幅，避免 1 秒内多次请求
            const secids = list.map(h => getEastmoneySecId(h.code)).filter(Boolean).join(',');
            if (!secids) return;
            const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}&fields=f12,f3&ut=fa5fd1943c7b386f172d6893dbfba10b&_=${Date.now()}`;

            let qjson;
            try {
                qjson = await runWithSourceStat('quote_ulist_np_get_jsonp', async () => await fetchJsonp(url, 'cb', 8000));
            } catch {
                qjson = await runWithSourceStat('quote_ulist_np_get_jsonp_callback', async () => await fetchJsonp(url, 'callback', 8000));
            }

            const diff = qjson?.data?.diff;
            const chgMap = {};
            if (Array.isArray(diff)) {
                diff.forEach(item => {
                    const code = (item?.f12 || '').toString();
                    const chg = Number(item?.f3);
                    if (code && Number.isFinite(chg)) chgMap[code] = chg;
                });
            }

            const quotes = list.map(h => ({
                code: h.code,
                chg: normalizeStockChg(Number.isFinite(chgMap[h.code]) ? chgMap[h.code] : 0, status0)
            }));

            quotes.forEach(q => {
                const tr = tbody.querySelector(`tr[data-code="${q.code}"]`);
                if (!tr) return;
                const td = tr.querySelector('td.holding-chg');
                if (!td) return;
                td.className = `holding-chg ${q.chg >= 0 ? 'positive' : 'negative'}`;
                td.innerHTML = `<strong>${(q.chg > 0 ? '+' : '') + q.chg.toFixed(2) + '%'}</strong>`;
            });

            // 同步更新“日涨跌幅”的估算缓存（让持仓实时涨跌与日涨跌幅联动）

            const top10Weight = list.reduce((sum, h) => sum + (parseFloat(h.ratio) || 0), 0);
            let top10Contribution = 0;
            list.forEach(h => {
                const w = parseFloat(h.ratio) || 0;
                const c = normalizeStockChg(Number.isFinite(chgMap[h.code]) ? chgMap[h.code] : 0, status0);
                top10Contribution += (w / 100) * c;
            });

            const residualWeight = 100 - top10Weight;
            let residualRate = 0;
            const fundgzGszzl = parseFloat(fund._fundgzDayGrowth);
            if (!isNaN(fundgzGszzl) && residualWeight > 0.01) {
                residualRate = (fundgzGszzl - top10Contribution) / (residualWeight / 100);
                const top10AvgRate = top10Weight > 0 ? top10Contribution / (top10Weight / 100) : 0;
                if (Math.abs(residualRate) > Math.abs(top10AvgRate) * 3 + 5) {
                    residualRate = top10AvgRate;
                }
            } else if (top10Weight > 0) {
                residualRate = top10Contribution / (top10Weight / 100);
            }

            const fallbackEst = top10Contribution + (residualWeight / 100) * residualRate;
            const estDayChg = (!isNaN(fundgzGszzl)) ? fundgzGszzl : fallbackEst;

            holdingsCache[fund.code] = {
                top10Weight,
                top10Contribution,
                residualWeight,
                residualRate,
                estDayChg,
                timestamp: Date.now()
            };
            if (Number.isFinite(estDayChg)) fund.dayGrowth = estDayChg;
        }

        function initChart() {
            const dom = document.getElementById('klineChart');
            chart = echarts.init(dom);
            chart.setOption({
                tooltip: { trigger: 'axis', axisPointer: { type: 'cross' }, backgroundColor: 'rgba(255,255,255,0.95)', padding: 12 },
                grid: { left: '3%', right: '4%', bottom: '20', top: '20', containLabel: true },
                xAxis: { type: 'category', boundaryGap: false, axisLine: { lineStyle: { color: '#e5e5e5' } }, axisLabel: { color: '#737373' } },
                yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#f5f5f5' } }, axisLabel: { color: '#737373' } },
                series: [{ name: '净值', type: 'line', smooth: true, symbol: 'none', connectNulls: true, lineStyle: { width: 3, color: '#3b82f6' }, areaStyle: { color: new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(59,130,246,0.3)'},{offset:1,color:'rgba(59,130,246,0.05)'}]) }, emphasis: { focus: 'series' } }]
            });
            initTurningPointMagnet();
            window.addEventListener('resize', () => chart.resize());
        }

        let _turningPointIdxs = [];
        let _turningPointLabels = [];
        let _turningPointValues = [];
        let _magnetLock = false;

        function setTurningPointMagnetData(labels, values, maxPoints, extraIdxs) {
            const idxs = pickTurningPoints(values, maxPoints);
            const merged = [];
            if (Array.isArray(idxs)) merged.push(...idxs);
            if (Array.isArray(extraIdxs)) merged.push(...extraIdxs);
            const rawUniq = Array.from(new Set(merged.filter(v => Number.isFinite(v) && v >= 0)));
            const uniq = Array.isArray(values)
                ? rawUniq.filter(i => Number.isFinite(values[i]))
                : rawUniq;
            _turningPointIdxs = uniq.sort((a, b) => a - b);
            _turningPointLabels = Array.isArray(labels) ? labels : [];
            _turningPointValues = Array.isArray(values) ? values : [];
        }

        function findNearestIdx(sortedIdxs, target) {
            if (!Array.isArray(sortedIdxs) || sortedIdxs.length === 0) return -1;
            let lo = 0;
            let hi = sortedIdxs.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const v = sortedIdxs[mid];
                if (v === target) return v;
                if (v < target) lo = mid + 1;
                else hi = mid - 1;
            }
            const candA = hi >= 0 ? sortedIdxs[hi] : null;
            const candB = lo < sortedIdxs.length ? sortedIdxs[lo] : null;
            if (candA === null) return candB ?? -1;
            if (candB === null) return candA ?? -1;
            return (Math.abs(candA - target) <= Math.abs(candB - target)) ? candA : candB;
        }

        function axisValueToIndex(val) {
            if (typeof val === 'number' && Number.isFinite(val)) return val;
            if (!val) return -1;
            const s = String(val);
            const idx = _turningPointLabels.indexOf(s);
            return idx >= 0 ? idx : -1;
        }

        function initTurningPointMagnet() {
            if (!chart) return;
            chart.off('updateAxisPointer');
            chart.on('updateAxisPointer', (e) => {
                if (_magnetLock) return;
                const info = e?.axesInfo?.[0];
                if (!info) return;
                const curIdx = axisValueToIndex(info.value);
                if (curIdx < 0) return;
                const nearest = findNearestIdx(_turningPointIdxs, curIdx);
                if (nearest < 0) return;

                if (!Number.isFinite(_turningPointValues?.[nearest])) return;

                const mouseX = e?.event?.offsetX;
                const mouseY = e?.event?.offsetY;
                const vY = Number(_turningPointValues[nearest]);
                const pt = Number.isFinite(vY) ? chart.convertToPixel({ seriesIndex: 0 }, [nearest, vY]) : null;
                const px = Array.isArray(pt) ? pt[0] : NaN;
                const py = Array.isArray(pt) ? pt[1] : NaN;
                const hasMouse = Number.isFinite(mouseX) && Number.isFinite(mouseY) && Number.isFinite(px) && Number.isFinite(py);

                const shouldSnap = hasMouse
                    ? (Math.hypot(mouseX - px, mouseY - py) <= 2)
                    : (Math.abs(nearest - curIdx) <= 1);

                if (shouldSnap && nearest !== curIdx) {
                    _magnetLock = true;
                    try {
                        if (hasMouse) {
                            chart.dispatchAction({ type: 'updateAxisPointer', x: px, y: py });
                        }
                        chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: nearest });
                    } finally {
                        setTimeout(() => { _magnetLock = false; }, 0);
                    }
                }
            });
        }

        function pickTurningPoints(values, maxPoints = 12) {
            if (!Array.isArray(values) || values.length < 3) return [];
            const finiteIdxs = [];
            for (let i = 0; i < values.length; i++) {
                if (Number.isFinite(values[i])) finiteIdxs.push(i);
            }
            if (finiteIdxs.length < 3) return [];

            const cand = [];
            for (let k = 1; k < finiteIdxs.length - 1; k++) {
                const iPrev = finiteIdxs[k - 1];
                const i = finiteIdxs[k];
                const iNext = finiteIdxs[k + 1];
                const a = values[iPrev];
                const b = values[i];
                const c = values[iNext];
                if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;

                const isPeak = (b >= a && b > c) || (b > a && b >= c);
                const isValley = (b <= a && b < c) || (b < a && b <= c);
                if (!isPeak && !isValley) continue;

                const score = Math.abs(b - a) + Math.abs(b - c);
                if (score <= 0) continue;
                cand.push({ idx: i, score });
            }

            if (cand.length === 0) return [];
            cand.sort((a, b) => b.score - a.score);

            const minGap = Math.max(1, Math.round(values.length / (maxPoints * 2)));
            const picked = [];
            for (const p of cand) {
                if (picked.length >= maxPoints) break;
                if (picked.every(x => Math.abs(x - p.idx) >= minGap)) {
                    picked.push(p.idx);
                }
            }

            picked.sort((a, b) => a - b);
            return picked;
        }

        function changeTimeRange(range) {
            currentTimeRange = range;
            document.querySelectorAll('.time-tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            if (range === 'realtime') {
                updateRealtimeChart();
                startRealtimeUpdate();
                if (selectedFund) fetchHistoryData(selectedFund.code, false);
            }
            else {
                stopRealtimeUpdate();
                if (!selectedFund) return;
                if (historyCache[selectedFund.code]) { renderHistoryChart(selectedFund.code); }
                else { fetchHistoryData(selectedFund.code, true); }
            }
        }

        function getRealtimeChartData(fund) {
            const labels = [];
            for (let m=570; m<=690; m++) labels.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
            for (let m=780; m<=900; m++) labels.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
            const history = getRealtimeSeriesForChart(fund);
            let end = getEffectiveRealtimeEndIndex(history);
            if (end < 0) return { labels, history, end: -1, xData: [], yData: [] };
            const xData = labels.slice(0, end + 1);
            const yData = history.slice(0, end + 1);
            return { labels, history, end, xData, yData };
        }

        function updateRealtimeChart() {
            if (!selectedFund) return;
            document.getElementById('chartTypeLabel').innerHTML = `实时估值走势`;
            const { xData, yData } = getRealtimeChartData(selectedFund);

            setTurningPointMagnetData(xData, yData, 16);

            const baseNav = parseFloat(selectedFund.currentNav);
            chart.setOption({
                tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'cross' },
                    formatter: (params) => {
                        const pNav = params?.[0];
                        const t = pNav?.axisValueLabel || '';
                        const rawNav = pNav?.data;
                        const nav = (rawNav === null || rawNav === undefined) ? NaN : Number(rawNav);
                        const navText = Number.isFinite(nav) ? nav.toFixed(4) : '--';

                        let pct = NaN;
                        if (Number.isFinite(baseNav) && baseNav > 0 && Number.isFinite(nav)) {
                            pct = ((nav - baseNav) / baseNav) * 100;
                        }
                        const pctText = Number.isFinite(pct) ? ((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%') : '--';
                        const pctColor = Number.isFinite(pct) ? (pct >= 0 ? '#ef4444' : '#10b981') : '#737373';
                        return `${t}<br/>净值：${navText}<br/>涨跌幅：<span style="color:${pctColor};font-weight:700;">${pctText}</span>`;
                    }
                },
                xAxis: {
                    data: xData,
                    axisTick: { show: false },
                    minorTick: { show: false },
                    axisLabel: {
                        color: '#737373',
                        interval: 0,
                        formatter: (value) => {
                            if (value === '09:30') return '09:30';
                            if (value === '11:30') return '11:30/13:00';
                            if (value === '15:00') return '15:00';
                            return '';
                        }
                    }
                },
                series: [{ name: '净值', data: yData }]
            });
        }

        // 根据时间范围计算截断时间戳（毫秒）
        function getCutoffTimestamp(range) {
            const t = getShanghaiTimeParts();
            const today = new Date(Date.UTC(t.year, t.month - 1, t.day)); // 上海"今天"00:00 UTC
            let cutoff;
            switch (range) {
                case '5d':  cutoff = new Date(today); cutoff.setUTCDate(cutoff.getUTCDate() - 7); break;
                case '1m':  cutoff = new Date(today); cutoff.setUTCMonth(cutoff.getUTCMonth() - 1); break;
                case '3m':  cutoff = new Date(today); cutoff.setUTCMonth(cutoff.getUTCMonth() - 3); break;
                case '1y':  cutoff = new Date(today); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1); break;
                case 'all': return 0; // 成立来不截断
                default:    cutoff = new Date(today); cutoff.setUTCDate(cutoff.getUTCDate() - 7); break;
            }
            return cutoff.getTime();
        }

        // 将时间戳转为 YYYY-MM-DD（上海时区 +8）
        function tsToDateStr(ts) {
            const d = new Date(ts + 8 * 3600000); // 加8小时后按UTC读
            const y = d.getUTCFullYear();
            const m = String(d.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(d.getUTCDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        }

        function getBuyMarkersForHistoryChart(fund, labels, values) {
            const out = { data: [], byDate: {}, idxs: [] };
            if (!fund || !Array.isArray(labels) || !Array.isArray(values) || labels.length !== values.length) return out;
            const buys = getFundBuys(fund);
            if (!buys.length) return out;

            for (const b of buys) {
                const bp = getFirstHistoryPointOnOrAfter(fund.code, b.date);
                const effDate = bp?.date;
                if (!effDate) continue;
                const idx = labels.indexOf(effDate);
                if (idx < 0) continue;
                const nav = Number(values[idx]);
                if (!Number.isFinite(nav)) continue;
                if (!out.byDate[effDate]) out.byDate[effDate] = [];
                out.byDate[effDate].push({ buyDate: b.date, amount: Number(b.amount), effDate, nav });
                out.idxs.push(idx);
            }

            for (const [d, items] of Object.entries(out.byDate)) {
                // 一个生效日只画一个点，但 tooltip 里列出多笔
                const nav = items?.[0]?.nav;
                if (!Number.isFinite(nav)) continue;
                out.data.push({ value: [d, nav], _buyItems: items });
            }

            out.data.sort((a, b) => (String(a.value?.[0]) < String(b.value?.[0]) ? -1 : 1));
            out.idxs = Array.from(new Set(out.idxs.filter(v => Number.isFinite(v) && v >= 0))).sort((a, b) => a - b);
            return out;
        }

        function getSellMarkersForHistoryChart(fund, labels, values) {
            const out = { data: [], byDate: {}, idxs: [] };
            if (!fund || !Array.isArray(labels) || !Array.isArray(values) || labels.length !== values.length) return out;
            const sells = getFundSells(fund);
            if (!sells.length) return out;
            for (const s of sells) {
                const bp = getFirstHistoryPointOnOrAfter(fund.code, s.date);
                const effDate = bp?.date;
                if (!effDate) continue;
                const idx = labels.indexOf(effDate);
                if (idx < 0) continue;
                const nav = Number(values[idx]);
                if (!Number.isFinite(nav)) continue;
                if (!out.byDate[effDate]) out.byDate[effDate] = [];
                out.byDate[effDate].push({ sellDate: s.date, effDate, nav, all: !!s.all, amount: s.amount });
                out.idxs.push(idx);
            }
            for (const [d, items] of Object.entries(out.byDate)) {
                const nav = items?.[0]?.nav;
                if (!Number.isFinite(nav)) continue;
                out.data.push({ value: [d, nav], _sellItems: items });
            }
            out.data.sort((a, b) => (String(a.value?.[0]) < String(b.value?.[0]) ? -1 : 1));
            out.idxs = Array.from(new Set(out.idxs.filter(v => Number.isFinite(v) && v >= 0))).sort((a, b) => a - b);
            return out;
        }

        // 从缓存数据渲染图表 + 历史表格（不发网络请求）
        function renderHistoryChart(code) {
            const all = historyCache[code];
            if (!all || all.length === 0) return;

            const cutoff = getCutoffTimestamp(currentTimeRange);
            const data = all.filter(p => p.x >= cutoff); // 按时间戳截断

            const labels = data.map(p => tsToDateStr(p.x));
            const values = data.map(p => p.y);

            const fund = funds.find(f => f.code === code);
            const buyMarkers = getBuyMarkersForHistoryChart(fund, labels, values);
            const sellMarkers = getSellMarkersForHistoryChart(fund, labels, values);

            setTurningPointMagnetData(labels, values, 18, [...(buyMarkers.idxs || []), ...(sellMarkers.idxs || [])]);

            const rangeLabel = { '5d':'1周', '1m':'1月', '3m':'3月', '1y':'1年', 'all':'成立来' };
            document.getElementById('chartTypeLabel').innerHTML = `${rangeLabel[currentTimeRange] || ''}净值走势`;

            chart.setOption({
                tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'cross' },
                    formatter: (params) => {
                        const pLine = Array.isArray(params) ? params.find(p => p.seriesType === 'line') : null;
                        const date = (pLine?.axisValueLabel || pLine?.axisValue || '').toString();
                        const nav = (pLine?.data === null || pLine?.data === undefined) ? NaN : Number(pLine.data);
                        const navText = Number.isFinite(nav) ? nav.toFixed(4) : '--';

                        let html = `${date}<br/>净值：${navText}`;
                        const items = (buyMarkers.byDate && date) ? buyMarkers.byDate[date] : null;
                        if (Array.isArray(items) && items.length > 0) {
                            html += `<br/><span style="font-weight:800;">买入：</span>`;
                            for (const it of items) {
                                const amt = Number(it.amount);
                                const amtText = Number.isFinite(amt) ? amt.toFixed(2) : '--';
                                html += `<br/>${it.buyDate} ¥${amtText}`;
                            }
                        }
                        const sItems = (sellMarkers.byDate && date) ? sellMarkers.byDate[date] : null;
                        if (Array.isArray(sItems) && sItems.length > 0) {
                            html += `<br/><span style="font-weight:800;">卖出：</span>`;
                            for (const it of sItems) {
                                if (it.all) {
                                    html += `<br/>${it.sellDate} 清仓`;
                                } else {
                                    const amt = Number(it.amount);
                                    const amtText = Number.isFinite(amt) ? amt.toFixed(2) : '--';
                                    html += `<br/>${it.sellDate} ¥${amtText}`;
                                }
                            }
                        }
                        return html;
                    }
                },
                xAxis: {
                    data: labels,
                    axisTick: { show: true },
                    minorTick: { show: false },
                    axisLabel: {
                        color: '#737373',
                        interval: 'auto',
                        formatter: null
                    }
                },
                series: [
                    { name: '净值', data: values },
                    {
                        name: '买入',
                        type: 'scatter',
                        data: buyMarkers.data,
                        symbol: 'circle',
                        symbolSize: 9,
                        itemStyle: { color: '#ef4444', borderColor: '#ffffff', borderWidth: 2 },
                        emphasis: { scale: 1.25 },
                        z: 5
                    },
                    {
                        name: '卖出',
                        type: 'scatter',
                        data: sellMarkers.data,
                        symbol: 'diamond',
                        symbolSize: 10,
                        itemStyle: { color: '#10b981', borderColor: '#ffffff', borderWidth: 2 },
                        emphasis: { scale: 1.25 },
                        z: 5
                    }
                ]
            });
        }

        function resetHistoryTable(code) {
            historyTableState.code = code;
            historyTableState.rendered = 0;
            const tbody = document.getElementById('historyTableBody');
            if (tbody) tbody.innerHTML = '';
            appendHistoryTableRows();
        }

        function calcSharesAsOfDate(code, fund, dateStr) {
            if (!fund || !code || !dateStr) return 0;
            const buys = getFundBuys(fund);
            const sells = getFundSells(fund);
            const txs = [];
            for (const b of buys) {
                const bp = getFirstHistoryPointOnOrAfter(code, b.date);
                const eff = bp?.date;
                const nav0 = bp ? Number(bp.y) : NaN;
                if (!eff || eff > dateStr || !Number.isFinite(nav0) || nav0 <= 0) continue;
                const amt = Number(b.amount);
                if (!Number.isFinite(amt) || amt <= 0) continue;
                txs.push({ type: 'buy', effDate: eff, amount: amt, nav: nav0 });
            }
            for (const s of sells) {
                const bp = getFirstHistoryPointOnOrAfter(code, s.date);
                const eff = bp?.date;
                const nav0 = bp ? Number(bp.y) : NaN;
                if (!eff || eff > dateStr || !Number.isFinite(nav0) || nav0 <= 0) continue;
                const all = !!s.all;
                const amt = Number(s.amount);
                if (!all && (!Number.isFinite(amt) || amt <= 0)) continue;
                txs.push({ type: 'sell', effDate: eff, amount: all ? null : amt, all, nav: nav0 });
            }
            txs.sort((a, b) => (a.effDate < b.effDate ? -1 : (a.effDate > b.effDate ? 1 : (a.type === b.type ? 0 : (a.type === 'buy' ? -1 : 1)))));

            let invested0 = 0;
            let shares0 = 0;
            for (const tx of txs) {
                if (tx.type === 'buy') {
                    const sh0 = tx.amount / tx.nav;
                    if (!Number.isFinite(sh0) || sh0 <= 0) continue;
                    shares0 += sh0;
                    invested0 += tx.amount;
                } else {
                    if (shares0 <= 0) continue;
                    const avgCost = invested0 > 0 ? (invested0 / shares0) : 0;
                    let sellShares = 0;
                    if (tx.all) sellShares = shares0;
                    else sellShares = tx.amount / tx.nav;
                    if (!Number.isFinite(sellShares) || sellShares <= 0) continue;
                    sellShares = Math.min(sellShares, shares0);
                    shares0 -= sellShares;
                    invested0 -= avgCost * sellShares;
                    if (shares0 <= 0.00000001) { shares0 = 0; invested0 = 0; }
                    if (invested0 < 0) invested0 = 0;
                }
            }
            return (Number.isFinite(shares0) && shares0 > 0) ? shares0 : 0;
        }

        function appendHistoryTableRows() {
            const code = historyTableState.code;
            const all = code ? historyCache[code] : null;
            const tbody = document.getElementById('historyTableBody');
            if (!tbody) return;
            if (!all || all.length === 0) {
                if (historyTableState.rendered === 0) {
                    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--gray-500); padding: 40px;">暂无数据</td></tr>`;
                }
                return;
            }

            const start = historyTableState.rendered;
            const end = Math.min(start + historyTableState.pageSize, all.length);
            if (start >= end) return;

            const rows = [];
            const fundForCalc = funds.find(f => f.code === code) || ((selectedFund && selectedFund.code === code) ? selectedFund : null);
            let firstEffBuyDate = '';
            if (fundForCalc) {
                const buys0 = getFundBuys(fundForCalc);
                for (const b of buys0) {
                    const bp = getFirstHistoryPointOnOrAfter(code, b.date);
                    if (bp && bp.date) {
                        if (!firstEffBuyDate || bp.date < firstEffBuyDate) firstEffBuyDate = bp.date;
                    }
                }
            }
            // 若东财 pingzhongdata 历史净值尚未更新到今日，但百度 gushitong 的 newest 已给出“今日官方日涨跌幅”，
            // 则在表格顶部插入一行“官方快讯”，避免用户误以为历史净值缺失/逻辑错误。
            if (historyTableState.rendered === 0) {
                const fund = funds.find(f => f.code === code);
                const sh = getShanghaiTimeParts();
                const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
                const latestDate = all && all.length > 0 ? tsToDateStr(all[all.length - 1].x) : '';
                const bnDate = (fund && fund._baiduNewestDayGrowthDate) ? String(fund._baiduNewestDayGrowthDate) : '';
                const bnChg = Number(fund && fund._baiduNewestDayGrowth);
                const bnNav = Number(fund && fund._baiduNewestNav);
                if (bnDate === todayStr && Number.isFinite(bnChg) && latestDate && latestDate < todayStr) {
                    const pctText = (bnChg >= 0 ? '+' : '') + bnChg.toFixed(2) + '%';
                    const navText = Number.isFinite(bnNav) && bnNav > 0 ? bnNav.toFixed(4) : '--';
                    rows.push(`<tr><td>${todayStr}</td><td>${navText}</td><td class="${bnChg>=0?'positive':'negative'}">${pctText}</td><td>--</td></tr>`);
                }
            }
            for (let k = start; k < end; k++) {
                const i = all.length - 1 - k;
                if (i < 0) break;
                const date = tsToDateStr(all[i].x);
                const val = all[i].y;
                const pct = i > 0 ? (((all[i].y - all[i - 1].y) / all[i - 1].y) * 100) : 0;

                let dayProfitText = '--';
                let dayProfitClass = '';
                const fund = fundForCalc;
                if (i > 0) {
                    const prevDate = tsToDateStr(all[i - 1].x);
                    let sharesPrev = 0;
                    const canCalc = !!fund;
                    if (canCalc) {
                        const profitEligible = (!firstEffBuyDate || prevDate >= firstEffBuyDate);
                        if (profitEligible) {
                            sharesPrev = calcSharesAsOfDate(code, fund, prevDate);

                            // 兜底1：若无卖出记录，直接用买入份额求和（避免因边界导致 calcSharesAsOfDate 算出 NaN/0）
                            if (!(Number.isFinite(sharesPrev) && sharesPrev > 0)) {
                                const buys0 = getFundBuys(fund);
                                const sells0 = getFundSells(fund);
                                if (Array.isArray(buys0) && buys0.length > 0 && (!Array.isArray(sells0) || sells0.length === 0)) {
                                    let shSum = 0;
                                    for (const b of buys0) {
                                        const bp = getFirstHistoryPointOnOrAfter(code, b.date);
                                        const eff = bp?.date;
                                        const nav0 = bp ? Number(bp.y) : NaN;
                                        const amt = Number(b.amount);
                                        if (!eff || eff > prevDate || !Number.isFinite(nav0) || nav0 <= 0 || !Number.isFinite(amt) || amt <= 0) continue;
                                        shSum += amt / nav0;
                                    }
                                    if (Number.isFinite(shSum) && shSum > 0) sharesPrev = shSum;
                                }
                            }

                            // 兜底2：旧结构 shares
                            if (!(Number.isFinite(sharesPrev) && sharesPrev > 0)) {
                                const legacy = getPositionFromLegacy(fund);
                                if (legacy.has) sharesPrev = Number(legacy.shares) || 0;
                            }

                            // 兜底3：当前持仓 shares（仅用于展示兜底）
                            if (!(Number.isFinite(sharesPrev) && sharesPrev > 0)) {
                                const posNow = getPosition(fund);
                                if (posNow && posNow.has) sharesPrev = Number(posNow.shares) || 0;
                            }
                        }
                    }

                    if (!Number.isFinite(sharesPrev) || sharesPrev < 0) sharesPrev = 0;
                    if (sharesPrev > 0) {
                        const dayProfit = (all[i].y - all[i - 1].y) * sharesPrev;
                        dayProfitText = '¥' + dayProfit.toFixed(2);
                        dayProfitClass = dayProfit >= 0 ? 'positive' : 'negative';
                    }
                }

                const pctText = (i > 0)
                    ? ((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%')
                    : '--';
                rows.push(`<tr><td>${date}</td><td>${val.toFixed(4)}</td><td class="${i > 0 ? (pct>=0?'positive':'negative') : ''}">${pctText}</td><td class="${dayProfitClass}">${dayProfitText}</td></tr>`);
            }

            if (historyTableState.rendered === 0) tbody.innerHTML = '';
            tbody.insertAdjacentHTML('beforeend', rows.join(''));
            historyTableState.rendered = end;
        }

        // 拉取 pingzhongdata 全历史并缓存，然后渲染
        async function fetchHistoryData(code, renderChart = true) {
            if (historyCache[code]) {
                if (renderChart) renderHistoryChart(code);
                resetHistoryTable(code);
                if (selectedFund && selectedFund.code === code) {
                    updateMainDisplay(selectedFund);
                }
                return;
            }

            try {
                await loadScript(`https://fund.eastmoney.com/pingzhongdata/${code}.js?rt=${Date.now()}`, 12000);
                const raw = window.Data_netWorthTrend;
                if (!Array.isArray(raw) || raw.length === 0) throw new Error('Data_netWorthTrend 为空');

                // 缓存全部数据（每条 {x: 时间戳, y: 净值}）
                historyCache[code] = raw.map(item => ({ x: item.x, y: item.y }));

                // 用最新一条同步净值
                const fundRef = funds.find(f => f.code === code);
                if (fundRef) {
                    const latest = raw[raw.length - 1];
                    const jzrq   = tsToDateStr(latest.x);
                    if (jzrq > (fundRef.navDate || '')) {
                        fundRef.navDate  = jzrq;
                        fundRef.currentNav = latest.y;
                        saveFunds();
                    }
                    if (selectedFund && selectedFund.code === code) {
                        updateMainDisplay(selectedFund);
                    }
                }

                if (renderChart) renderHistoryChart(code);
                resetHistoryTable(code);
            } catch(e) {
                console.error('💥 历史数据加载失败:', e);
                document.getElementById('historyTableBody').innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-500);padding:40px;">数据加载失败</td></tr>`;
            }
        }

        document.getElementById('historyScroll')?.addEventListener('scroll', (e) => {
            const el = e.target;
            if (!el) return;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
                appendHistoryTableRows();
            }
        });

        function startRealtimeUpdate() { startUnifiedRefreshLoop(); }
        function stopRealtimeUpdate() { /* unified loop handles stop */ }
        function startAutoUpdate() { startUnifiedRefreshLoop(); }

        let officialRefreshCursor = 0;
        let lastOfficialRefreshAt = 0;
        let _autoResetDate = '';

        function getShanghaiTodayStr() {
            const sh = getShanghaiTimeParts();
            return `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
        }

        function isAfter915() {
            const sh = getShanghaiTimeParts();
            const mins = sh.hour * 60 + sh.minute;
            return mins >= (9 * 60 + 15);
        }

        function shouldEnableOfficialPolling(status) {
            // 仅在盘后阶段启用（交易中/午休/盘后补全不启用）
            return !!(status && status.canRealtimeUpdate === false && status.reason === '盘后');
        }

        function fundHasClose1500(fund) {
            const sh = getShanghaiTimeParts();
            const todayStr = `${sh.year}-${String(sh.month).padStart(2,'0')}-${String(sh.day).padStart(2,'0')}`;
            const t = (fund?.estimatedTime || '').toString();
            const m = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})/);
            if (m && m[1] === todayStr && `${m[2]}:${m[3]}` === '15:00') return true;
            const rh = fund?.realtimeHistory;
            if (Array.isArray(rh) && rh.length >= 242) {
                const v = rh[241];
                if (Number.isFinite(v) && v > 0) return true;
            }
            return false;
        }

        function fundHasLatestOfficialToday(fund) {
            const todayStr = getShanghaiTodayStr();
            const d1 = (fund?._baiduNewestDayGrowthDate || '').toString();
            if (d1 && d1 === todayStr && Number.isFinite(Number(fund?._baiduNewestDayGrowth))) return true;
            const d2 = (fund?._officialDayGrowthDate || '').toString();
            if (d2 && d2 === todayStr && Number.isFinite(Number(fund?._officialDayGrowth))) return true;
            const navDateStr = getDateStr(fund?.navDate);
            if (navDateStr && navDateStr === todayStr) return true;
            return false;
        }

        function isFundFrozenForToday(fund) {
            const todayStr = getShanghaiTodayStr();
            return (fund && String(fund._autoFrozenDate || '') === todayStr);
        }

        function freezeFundForTodayIfOfficialReady(fund) {
            if (!fund) return;
            if (fundHasLatestOfficialToday(fund)) {
                fund._autoFrozenDate = getShanghaiTodayStr();
            }
        }

        function resetAutoFreezeIfNeeded() {
            const todayStr = getShanghaiTodayStr();
            if (_autoResetDate === todayStr) return;
            if (!isAfter915()) return;
            _autoResetDate = todayStr;
            if (Array.isArray(funds)) {
                for (const f of funds) {
                    if (f) delete f._autoFrozenDate;
                }
            }
            officialRefreshCursor = 0;
            lastOfficialRefreshAt = 0;
        }

        function startUnifiedRefreshLoop() {
            if (refreshInterval) return;
            refreshInterval = setInterval(() => {
                refreshLock = refreshLock.then(async () => {
                    const status = getMarketStatus();
                    const now = Date.now();

                    resetAutoFreezeIfNeeded();

                    const enableOfficialPolling = shouldEnableOfficialPolling(status);
                    let needEstimateAfterClose = false;
                    if (status && status.canRealtimeUpdate === false && status.reason === '盘后' && Array.isArray(funds) && funds.length > 0) {
                        for (const f of funds) {
                            if (!f) continue;
                            if (isFundFrozenForToday(f)) continue;
                            if (!fundHasClose1500(f)) { needEstimateAfterClose = true; break; }
                        }
                    }
                    const allowAutoEstimate = !!(status && status.canRealtimeUpdate) || (status && status.reason === '盘前' && isAfter915()) || needEstimateAfterClose;

                    function hasAllCnIndicesClosedPoint15() {
                        for (const [k, cfg] of Object.entries(MARKET_INDICES)) {
                            if (!cfg || cfg.type !== 'cn') continue;
                            const cached = indexTrendCache[k];
                            const times = cached?.times;
                            if (!Array.isArray(times) || times.length === 0) return false;
                            const lastT = String(times[times.length - 1] || '');
                            if (lastT !== '15:00') return false;
                        }
                        return true;
                    }

                    function canRetryIndicesAfterClose(st) {
                        if (!st || st.canRealtimeUpdate) return false;
                        const sh = getShanghaiTimeParts();
                        const mins = sh.hour * 60 + sh.minute;
                        // 仅允许 15:05-16:30 期间补一次（或多次低频）拿到 15:00 收盘点
                        if (mins < (15 * 60 + 5)) return false;
                        if (mins > (16 * 60 + 30)) return false;
                        return !hasAllCnIndicesClosedPoint15();
                    }


                    const minFundInterval = 2900;
                    const minIndicesInterval = 2900;

                    // 全局限流：每秒最多一次“网络任务”，用轮询调度保证各模块都能更新
                    // tick%4:
                    //   0/1: 轮询刷新一只基金估值（避免多基金同秒多请求）
                    //   2:   交易中刷新选中基金持仓涨跌；盘后用作官方数据轮询
                    //   3:   刷新指数
                    refreshTick = (refreshTick + 1) % 4;

                    if ((refreshTick === 0 || refreshTick === 1) && funds.length > 0 && now - lastFundRefreshAt >= minFundInterval) {
                        if (!allowAutoEstimate) return;
                        lastFundRefreshAt = now;
                        fundRefreshCursor = fundRefreshCursor % funds.length;
                        const f = funds[fundRefreshCursor];
                        fundRefreshCursor++;

                        // 盘后：默认停止估值轮询；仅在未拿到15:00收盘数据时补齐
                        if (status && status.canRealtimeUpdate === false && status.reason === '盘后') {
                            if (!f || fundHasClose1500(f)) return;
                        }
                        if (f && isFundFrozenForToday(f)) return;
                        await fetchFundData(f, { suppressRender: true });
                        renderFundList();
                        const mainContent = document.querySelector('.main-content');
                        if (mainContent && mainContent.classList.contains('overview-mode')) {
                            renderFundOverview();
                        }
                        if (selectedFund?.code === f.code) {
                            selectedFund = f;
                            updateMainDisplay(f);
                            if (currentTimeRange === 'realtime') updateRealtimeChart();
                        }
                        return;
                    }

                    if (refreshTick === 2) {
                        if (enableOfficialPolling) {
                            const minOfficialInterval = 6000;
                            if (!Array.isArray(funds) || funds.length === 0) return;
                            if (now - lastOfficialRefreshAt < minOfficialInterval) return;
                            lastOfficialRefreshAt = now;
                            officialRefreshCursor = officialRefreshCursor % funds.length;
                            const f = funds[officialRefreshCursor];
                            officialRefreshCursor++;
                            if (!f) return;
                            if (isFundFrozenForToday(f)) return;

                            try {
                                await fetchBaiduNewestForFund(f, { timeoutDirectMs: 8000, timeoutProxyMs: 9000 });
                            } catch (e) {
                            }
                            freezeFundForTodayIfOfficialReady(f);
                            saveFunds();
                            clearTimeout(renderFundListTimer);
                            renderFundListTimer = setTimeout(() => {
                                renderFundList();
                                const main0 = document.querySelector('.main-content');
                                if (main0 && main0.classList.contains('overview-mode')) renderFundOverview();
                                if (selectedFund?.code === f.code) updateMainDisplay(selectedFund);
                            }, 50);
                            return;
                        }

                        // 非盘后官方轮询时：仅在交易中更新“持仓涨跌幅”
                        if (selectedFund && status && status.canRealtimeUpdate) {
                            if (isFundFrozenForToday(selectedFund)) return;
                            await loadHoldingsAndSectors(selectedFund, { updateOnly: true });
                            updateMainDisplay(selectedFund);
                            clearTimeout(renderFundListTimer);
                            renderFundListTimer = setTimeout(() => renderFundList(), 50);
                            const mainContent = document.querySelector('.main-content');
                            if (mainContent && mainContent.classList.contains('overview-mode')) {
                                setTimeout(() => {
                                    const main2 = document.querySelector('.main-content');
                                    if (main2 && main2.classList.contains('overview-mode')) renderFundOverview();
                                }, 60);
                            }
                            return;
                        }
                    }

                    if (refreshTick === 3) {
                        const indicesContent0 = document.getElementById('indicesContent');
                        const indicesOpen0 = !!(indicesContent0 && indicesContent0.classList.contains('open'));
                        if (!indicesOpen0) return;

                        const allowCnIndices = !!(status && status.canRealtimeUpdate);
                        const allowUsIndices = isUsMarketOpenNow();
                        const allowRetryAfterClose = canRetryIndicesAfterClose(status);
                        // A股：休市期间冻结（仅盘后补齐 15:00 点允许低频重试）
                        // 美股：休市期间冻结（仅在美股交易时段自动刷新）
                        if (!allowCnIndices && !allowUsIndices && !allowRetryAfterClose) return;

                        const interval = (allowCnIndices || allowUsIndices) ? minIndicesInterval : 30000;
                        if (now - lastIndicesRefreshAt >= interval) {
                            lastIndicesRefreshAt = now;
                            await fetchMarketIndices(false);
                            return;
                        }
                    }

                    // 结构性持仓/板块：维持低频（不占用每秒预算，只有轮到且超时才刷新）
                    if (selectedFund && status && status.canRealtimeUpdate && now - lastHoldingsRefreshAt >= 30000) {
                        if (isFundFrozenForToday(selectedFund)) return;
                        lastHoldingsRefreshAt = now;
                        await loadHoldingsAndSectors(selectedFund, { silent: true });
                        return;
                    }
                }).catch(err => console.warn('unified refresh loop error:', err));
            }, 3000);
        }

        function stopUnifiedRefreshLoop() {
            if (!refreshInterval) return;
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
        function showToast(msg, type='success', durationMs=3000, closable=false) {
            let container = document.getElementById('toastContainer');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toastContainer';
                container.className = 'toast-container';
                document.body.appendChild(container);
            }
            const t = document.createElement('div');
            t.className = `toast ${type}`;
            const row = document.createElement('div');
            row.className = 'toast-row';
            const m = document.createElement('div');
            m.className = 'toast-msg';
            m.textContent = msg;
            row.appendChild(m);
            let timer = null;
            const remove = () => {
                if (timer) clearTimeout(timer);
                t.remove();
                const c = document.getElementById('toastContainer');
                if (c && c.children.length === 0) c.remove();
            };
            if (closable) {
                const btn = document.createElement('button');
                btn.className = 'toast-close';
                btn.type = 'button';
                btn.textContent = '×';
                btn.onclick = remove;
                row.appendChild(btn);
            }
            t.appendChild(row);
            container.appendChild(t);
            const d = Number(durationMs);
            if (Number.isFinite(d) && d > 0) timer = setTimeout(remove, d);
        }

        let _suggestTimer = null;
        let _suggestItems = [];
        let _suggestActive = -1;

        async function fetchFundSuggest(keyword) {
            const key = (keyword || '').trim();
            if (!key) return [];
            const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}`;
            const json = await runWithSourceStat('fund_suggest_jsonp', async () => await fetchJsonp(url, 'callback', 8000));
            const arr = json?.Datas || json?.data || [];
            if (!Array.isArray(arr)) return [];
            return arr.map(x => {
                const code = (x.CODE || x.FCODE || x.code || '').toString();
                const name = (x.NAME || x.SHORTNAME || x.name || '').toString();
                const type = (x.JJType || x.type || '').toString();
                return { code, name, type };
            }).filter(x => /^\d{6}$/.test(x.code) && x.name);
        }

        function renderFundSuggest(items) {
            const box = document.getElementById('fundSuggest');
            if (!box) return;
            _suggestItems = Array.isArray(items) ? items.slice(0, 12) : [];
            _suggestActive = -1;
            if (_suggestItems.length === 0) {
                box.style.display = 'none';
                box.innerHTML = '';
                return;
            }
            box.style.display = 'block';
            box.innerHTML = _suggestItems.map((it, idx) => {
                const meta = it.type ? it.type : '基金';
                return `<div class="fund-suggest-item" data-idx="${idx}" onclick="selectSuggestItem(${idx})"><div class="fund-suggest-left"><div class="fund-suggest-name">${it.name}</div><div class="fund-suggest-meta">${meta}</div></div><div class="fund-suggest-code">${it.code}</div></div>`;
            }).join('');
        }

        function selectSuggestItem(idx) {
            const it = _suggestItems[idx];
            if (!it) return;
            const input = document.getElementById('fundCode');
            if (input) input.value = it.code;
            const box = document.getElementById('fundSuggest');
            if (box) { box.style.display = 'none'; box.innerHTML = ''; }
            _suggestItems = [];
            _suggestActive = -1;
            input?.focus();
        }

        function moveSuggestActive(delta) {
            const box = document.getElementById('fundSuggest');
            if (!box || box.style.display === 'none') return;
            const items = box.querySelectorAll('.fund-suggest-item');
            if (!items || items.length === 0) return;
            _suggestActive += delta;
            if (_suggestActive < 0) _suggestActive = items.length - 1;
            if (_suggestActive >= items.length) _suggestActive = 0;
            items.forEach((el, i) => el.classList.toggle('active', i === _suggestActive));
            const activeEl = items[_suggestActive];
            if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
        }

        document.getElementById('fundCode')?.addEventListener('input', (e) => {
            const v = (e.target.value || '').trim();
            clearTimeout(_suggestTimer);
            if (v.length < 2 || /^\d{6}$/.test(v)) { renderFundSuggest([]); return; }
            _suggestTimer = setTimeout(async () => {
                try {
                    const items = await fetchFundSuggest(v);
                    renderFundSuggest(items);
                } catch {
                    renderFundSuggest([]);
                }
            }, 220);
        });

        document.getElementById('fundCode')?.addEventListener('keydown', (e) => {
            const box = document.getElementById('fundSuggest');
            const visible = box && box.style.display !== 'none';
            if (!visible) {
                if (e.key === 'Enter') { addFund(); e.preventDefault(); }
                return;
            }
            if (e.key === 'ArrowDown') { moveSuggestActive(1); e.preventDefault(); return; }
            if (e.key === 'ArrowUp') { moveSuggestActive(-1); e.preventDefault(); return; }
            if (e.key === 'Enter') {
                if (_suggestActive >= 0) { selectSuggestItem(_suggestActive); }
                else if (_suggestItems.length > 0) { selectSuggestItem(0); }
                e.preventDefault();
                return;
            }
            if (e.key === 'Escape') { renderFundSuggest([]); return; }
        });

        document.addEventListener('click', (e) => {
            const box = document.getElementById('fundSuggest');
            const input = document.getElementById('fundCode');
            if (!box || !input) return;
            if (e.target === input || box.contains(e.target)) return;
            renderFundSuggest([]);
        });

        const EDGE_API = {
            batchSnapshot: '/api/funds/batch-snapshot',
            dayGrowth: '/api/funds/day-growth',
            history: '/api/funds/history',
            holdings: '/api/funds/holdings',
            indices: '/api/market/indices',
            suggest: '/api/funds/suggest'
        };

        ensureSourceStat('api_batch_snapshot');
        ensureSourceStat('api_day_growth');
        ensureSourceStat('api_holdings');
        ensureSourceStat('api_history');
        ensureSourceStat('api_indices');
        ensureSourceStat('api_suggest');
        updateSourceIndicator('api_batch_snapshot');

        async function edgeApiGetJson(path, params = {}) {
            const url = new URL(path, window.location.origin);
            Object.entries(params).forEach(([key, value]) => {
                if (value === undefined || value === null || value === '') return;
                url.searchParams.set(key, value);
            });
            const response = await fetch(url.toString(), {
                credentials: 'same-origin',
                headers: {
                    'accept': 'application/json'
                }
            });
            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    const payload = await response.json();
                    message = payload?.error?.message || message;
                } catch {}
                throw new Error(message);
            }
            return await response.json();
        }

        function toLegacyFundPayload(item) {
            if (!item) return null;
            return {
                ...item,
                _sourceName: item.source || 'api_batch_snapshot',
                _attemptedSources: ['api_batch_snapshot'],
                _failedSources: []
            };
        }

        async function fetchSnapshotViaApi(code) {
            const payload = await runWithSourceStat('api_batch_snapshot', async () =>
                await edgeApiGetJson(EDGE_API.batchSnapshot, { codes: code })
            );
            const item = Array.isArray(payload?.items) ? payload.items[0] : null;
            if (!item) throw new Error('snapshot missing');
            return toLegacyFundPayload(item);
        }

        async function fetchBatchSnapshotsViaApi(codes) {
            const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
            if (list.length === 0) return [];
            const payload = await runWithSourceStat('api_batch_snapshot', async () =>
                await edgeApiGetJson(EDGE_API.batchSnapshot, { codes: list.join(',') })
            );
            return Array.isArray(payload?.items) ? payload.items.map(toLegacyFundPayload).filter(Boolean) : [];
        }

        function applySnapshotToFund(fund, data, options = {}) {
            const suppressRender = !!options.suppressRender;
            fund._lastFetchSource = (data && data._sourceName) ? String(data._sourceName) : '';
            const attempted0 = Array.isArray(data && data._attemptedSources) ? data._attemptedSources : [];
            const failed0 = Array.isArray(data && data._failedSources) ? data._failedSources : [];
            fund._fundgzTriedThisFetch = attempted0.includes('api_batch_snapshot');
            fund._fundgzFailedThisFetch = failed0.includes('api_batch_snapshot');
            fund.name = data.name;

            const incomingNavDateStr0 = getDateStr(data.jzrq);
            const existingNavDateStr0 = getDateStr(fund.navDate);
            const shouldUpdateOfficialNav0 = !existingNavDateStr0
                || !incomingNavDateStr0
                || (incomingNavDateStr0 >= existingNavDateStr0);
            if (shouldUpdateOfficialNav0) {
                fund.currentNav = data.dwjz;
                fund.navDate = data.jzrq;
            }

            const sh0 = getShanghaiTimeParts();
            const todayStr0 = `${sh0.year}-${String(sh0.month).padStart(2,'0')}-${String(sh0.day).padStart(2,'0')}`;
            const gzDateStr = getDateStr(data.gztime);
            if (gzDateStr && gzDateStr !== (fund._lastGzDate || '')) {
                fund._lastGzDate = gzDateStr;
                if (gzDateStr === todayStr0) {
                    fund._lastGzIdx = -1;
                    fund.realtimeHistory = [];
                }
            }

            const gzIdx = getRealtimeMinuteIndexFromGzTime(data.gztime);
            const lastIdx = Number.isFinite(fund._lastGzIdx) ? fund._lastGzIdx : -1;
            const acceptGz = (gzIdx < 0) ? true : (gzIdx >= lastIdx);
            if (acceptGz && gzIdx >= 0) fund._lastGzIdx = gzIdx;

            const navDateStr = incomingNavDateStr0;
            const shouldAcceptEstimate = !(navDateStr === todayStr0 && acceptGz);
            const isOfficialSnapshot = (navDateStr === todayStr0)
                && (gzDateStr === todayStr0)
                && (String(data.gsz) === String(data.dwjz));

            if (Number.isFinite(Number(data.officialDayGrowth))) {
                fund._officialDayGrowth = Number(data.officialDayGrowth);
                fund._officialDayGrowthDate = String(data.officialDayGrowthDate || data.jzrq || '');
            }

            if (isOfficialSnapshot) {
                const offChg = parseFloat(data.gszzl);
                if (Number.isFinite(offChg)) {
                    fund.dayGrowth = offChg;
                    fund._dayGrowthSource = 'official';
                    fund._fundgzDayGrowth = null;
                    fund._officialDayGrowth = offChg;
                    fund._officialDayGrowthDate = navDateStr;
                }
            }

            if (acceptGz && shouldAcceptEstimate) {
                fund._fundgzDayGrowth = data.gszzl;
                fund.dayGrowth = data.gszzl;
                fund.estimatedNav = data.gsz;
                fund.estimatedTime = data.gztime;
            }

            const status = getMarketStatus();
            const gszNum0 = parseFloat(data.gsz);
            const dwjzNum0 = parseFloat(shouldUpdateOfficialNav0 ? data.dwjz : fund.currentNav);
            const seed = status.canRealtimeUpdate
                ? ((Number.isFinite(gszNum0) && gszNum0 > 0) ? gszNum0 : dwjzNum0)
                : dwjzNum0;
            if (!Array.isArray(fund.realtimeHistory)) fund.realtimeHistory = [];
            const allowRealtimeWrite = (status.canRealtimeUpdate || status.reason === '鍗堥棿浼戝競' || status.reason === '鐩樺悗琛ュ叏');
            if (allowRealtimeWrite && acceptGz && shouldAcceptEstimate) {
                const v0 = parseFloat(data.gsz);
                const v = (Number.isFinite(v0) && v0 > 0) ? v0 : seed;
                if (Number.isFinite(v) && v > 0) {
                    const idx = gzIdx >= 0 ? gzIdx : getRealtimeMinuteIndex();
                    if (idx >= 0) {
                        if (fund.realtimeHistory.length < 242) fund.realtimeHistory.length = 242;
                        fund.realtimeHistory[idx] = v;
                        for (let j = idx + 1; j < fund.realtimeHistory.length; j++) fund.realtimeHistory[j] = undefined;
                    }
                }
            }

            const shNow = getShanghaiTimeParts();
            const todayStrNow = `${shNow.year}-${String(shNow.month).padStart(2,'0')}-${String(shNow.day).padStart(2,'0')}`;
            const hhNow = String(shNow.hour).padStart(2, '0');
            const mmNow = String(shNow.minute).padStart(2, '0');
            fund.lastUpdateTime = `${todayStrNow} ${hhNow}:${mmNow}`;
            saveFunds();

            if (!suppressRender) {
                clearTimeout(renderFundListTimer);
                renderFundListTimer = setTimeout(() => renderFundList(), 50);
            }

            if (allowRealtimeWrite && acceptGz) {
                updateMiniChart(fund);
            } else if (!miniCharts[fund.code]) {
                initMiniChart(fund);
            }

            if (selectedFund?.code === fund.code) {
                updateMainDisplay(fund);
                if (currentTimeRange === 'realtime') updateRealtimeChart();
            }
        }

        fetchWithFallback = async function(code) {
            return await fetchSnapshotViaApi(code);
        };

        fetchFundData = async function(fund, options = {}) {
            try {
                const data = await (fundgzQueue = fundgzQueue.then(() => fetchWithFallback(fund.code)));
                applySnapshotToFund(fund, data, options);
            } catch (e) {
                console.error('鑾峰彇鍩洪噾鏁版嵁澶辫触:', e);
                showToast('鏁版嵁鑾峰彇澶辫触锛岃绋嶅悗閲嶈瘯', 'error');
            }
        };

        fetchBaiduNewestForFund = async function(fund) {
            if (!fund || !fund.code) return false;
            const snapshot = await fetchSnapshotViaApi(fund.code);
            if (Number.isFinite(Number(snapshot.officialDayGrowth))) {
                fund._officialDayGrowth = Number(snapshot.officialDayGrowth);
                fund._officialDayGrowthDate = String(snapshot.officialDayGrowthDate || '');
                if (Number.isFinite(Number(snapshot.dwjz))) {
                    fund.currentNav = snapshot.dwjz;
                    fund.navDate = snapshot.jzrq;
                }
                return true;
            }
            return false;
        };

        fetchHistoryData = async function(code, renderChart = true) {
            if (historyCache[code]) {
                if (renderChart) renderHistoryChart(code);
                resetHistoryTable(code);
                if (selectedFund && selectedFund.code === code) updateMainDisplay(selectedFund);
                return;
            }

            try {
                const payload = await runWithSourceStat('api_history', async () =>
                    await edgeApiGetJson(EDGE_API.history, { code })
                );
                const raw = Array.isArray(payload?.history) ? payload.history : [];
                if (raw.length === 0) throw new Error('history empty');
                historyCache[code] = raw.map(item => ({ x: item.x, y: item.y }));

                const fundRef = funds.find(f => f.code === code);
                if (fundRef) {
                    const latest = raw[raw.length - 1];
                    const jzrq = tsToDateStr(latest.x);
                    if (jzrq > (fundRef.navDate || '')) {
                        fundRef.navDate = jzrq;
                        fundRef.currentNav = latest.y;
                        saveFunds();
                    }
                    if (selectedFund && selectedFund.code === code) updateMainDisplay(selectedFund);
                }

                if (renderChart) renderHistoryChart(code);
                resetHistoryTable(code);
            } catch (e) {
                console.error('馃挜 鍘嗗彶鏁版嵁鍔犺浇澶辫触:', e);
                document.getElementById('historyTableBody').innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-500);padding:40px;">鏁版嵁鍔犺浇澶辫触</td></tr>`;
            }
        };

        fetchFundSuggest = async function(keyword) {
            const key = (keyword || '').trim();
            if (!key) return [];
            const payload = await runWithSourceStat('api_suggest', async () =>
                await edgeApiGetJson(EDGE_API.suggest, { keyword: key })
            );
            return Array.isArray(payload?.items) ? payload.items : [];
        };

        function updateHoldingsEstimate(fund, holdings) {
            const top10Weight = holdings.reduce((sum, h) => sum + (parseFloat(h.ratio) || 0), 0);
            let top10Contribution = 0;
            holdings.forEach(h => {
                const w = parseFloat(h.ratio) || 0;
                const c = parseFloat(h.chg) || 0;
                top10Contribution += (w / 100) * c;
            });

            const residualWeight = 100 - top10Weight;
            let residualRate = 0;
            const fundgzGszzl = parseFloat(fund._fundgzDayGrowth);
            if (!isNaN(fundgzGszzl) && residualWeight > 0.01) {
                residualRate = (fundgzGszzl - top10Contribution) / (residualWeight / 100);
                const top10AvgRate = top10Weight > 0 ? top10Contribution / (top10Weight / 100) : 0;
                if (Math.abs(residualRate) > Math.abs(top10AvgRate) * 3 + 5) {
                    residualRate = top10AvgRate;
                }
            } else if (top10Weight > 0) {
                residualRate = top10Contribution / (top10Weight / 100);
            }

            const fallbackEst = top10Contribution + (residualWeight / 100) * residualRate;
            const estDayChg = (!isNaN(fundgzGszzl)) ? fundgzGszzl : fallbackEst;

            holdingsCache[fund.code] = {
                top10Weight,
                top10Contribution,
                residualWeight,
                residualRate,
                estDayChg,
                timestamp: Date.now()
            };
            if (Number.isFinite(estDayChg)) fund.dayGrowth = estDayChg;
            return top10Weight;
        }

        function renderHoldingsPayload(fund, payload) {
            const tbody = document.getElementById('holdingsTableBody');
            const tags = document.getElementById('sectorTags');
            if (!tbody || !tags) return;

            const status0 = getMarketStatus();
            const holdings = Array.isArray(payload?.holdings) ? payload.holdings : [];
            if (holdings.length === 0) {
                fund._noStockHoldings = true;
                try { delete holdingsCache[fund.code]; } catch {}
                setHoldingsSideVisible(false);
                return;
            }

            fund._noStockHoldings = false;
            setHoldingsSideVisible(true);

            const quotes = holdings.map(h => ({
                ...h,
                chg: normalizeStockChg(Number(h.chg) || 0, status0),
                industry: h.industry || '鍏朵粬'
            }));

            const top10Weight = updateHoldingsEstimate(fund, quotes);
            const top10WeightTag = `<span class="sector-tag top10-weight">鍓嶅崄鎸佷粨鍗犳瘮鍚堣锛?${top10Weight.toFixed(2)}%锛堣偂绁ㄦ寔浠擄級</span>`;

            let sectorList = Array.isArray(payload?.sectors) ? payload.sectors.slice(0, 6) : [];
            if (sectorList.length === 0) {
                const sectorMap = {};
                quotes.forEach(h => {
                    const name = h.industry || '鍏朵粬';
                    if (!sectorMap[name]) sectorMap[name] = { name, weight: 0 };
                    sectorMap[name].weight += (parseFloat(h.ratio) || 0);
                });
                sectorList = Object.values(sectorMap).sort((a, b) => b.weight - a.weight).slice(0, 6);
            }

            tags.innerHTML = top10WeightTag + sectorList.map(s =>
                `<span class="sector-tag">${s.name} ${Number(s.weight || 0).toFixed(1)}%</span>`
            ).join('');

            let holdingDateLabel = '';
            if (payload?.holdingDate) {
                holdingDateLabel = ` <span style="font-size:0.7rem;color:var(--gray-500);font-weight:500;">(${payload.holdingDate})</span>`;
            }
            document.querySelector('.table-header').innerHTML = `鍩洪噾鎸佷粨锛圱OP 10锛?${holdingDateLabel}`;

            fund._topHoldings = quotes.map(h => ({ code: h.code, name: h.name, ratio: h.ratio || 0 }));
            tbody.innerHTML = quotes.map(h => `
                <tr data-code="${h.code}" onclick="openStockDetail('${h.code}')">
                    <td>${h.name}</td>
                    <td style="font-family:'JetBrains Mono',monospace;font-size:0.8125rem;">${h.code}</td>
                    <td><strong>${h.ratio ? Number(h.ratio).toFixed(2) + '%' : '--'}</strong></td>
                    <td class="holding-chg ${h.chg >= 0 ? 'positive' : 'negative'}"><strong>${(h.chg > 0 ? '+' : '') + h.chg.toFixed(2) + '%'}</strong></td>
                </tr>
            `).join('');
        }

        loadHoldingsAndSectors = async function(fund, options = {}) {
            const tbody = document.getElementById('holdingsTableBody');
            const tags = document.getElementById('sectorTags');
            if (!options.silent) {
                if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--gray-500); padding: 40px;">鍔犺浇涓?..</td></tr>`;
                if (tags) tags.innerHTML = `<span style="font-size: 0.8125rem; color: var(--gray-500);">鍔犺浇涓?..</span>`;
            }

            try {
                const payload = await runWithSourceStat('api_holdings', async () =>
                    await edgeApiGetJson(EDGE_API.holdings, { code: fund.code })
                );
                renderHoldingsPayload(fund, payload);
            } catch (e) {
                console.error('鎸佷粨鏁版嵁鍔犺浇澶辫触:', e);
                if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--gray-500);">鏁版嵁鍔犺浇澶辫触锛岃绋嶅悗閲嶈瘯</td></tr>`;
                if (tags) tags.innerHTML = `<span style="font-size: 0.8125rem; color: var(--gray-500);">鍔犺浇澶辫触</span>`;
            }
        };

        updateHoldingsChgOnly = async function(fund) {
            await loadHoldingsAndSectors(fund, { silent: true });
        };

        fetchIndexTrendSnapshot = async function(key) {
            const payload = await runWithSourceStat('api_indices', async () =>
                await edgeApiGetJson(EDGE_API.indices, { keys: key })
            );
            const item = payload?.items?.[key];
            if (!item) return;
            indexTrendCache[key] = {
                times: item.times || [],
                prices: item.prices || [],
                preClose: item.preClose,
                updatedAt: Date.now()
            };
        };

        fetchMarketIndices = async function(force = false) {
            const grid = document.getElementById('indicesGrid');
            if (!grid) return;

            const nowTs = Date.now();
            const shouldFetch = force || Object.keys(indexTrendCache).length === 0 || Object.values(indexTrendCache).some(c => nowTs - (c.updatedAt || 0) > 20000);
            if (shouldFetch) {
                const payload = await runWithSourceStat('api_indices', async () =>
                    await edgeApiGetJson(EDGE_API.indices)
                );
                const items = payload?.items || {};
                Object.entries(items).forEach(([key, item]) => {
                    indexTrendCache[key] = {
                        times: item.times || [],
                        prices: item.prices || [],
                        preClose: item.preClose,
                        updatedAt: Date.now()
                    };
                });
            }

            const indexCards = [];
            for (const [key, config] of Object.entries(MARKET_INDICES)) {
                const cached = indexTrendCache[key];
                const fresh = cached && (nowTs - (cached.updatedAt || 0) < 2 * 60 * 1000);
                const lastPrice = fresh ? cached.prices?.[cached.prices.length - 1] : NaN;
                const preClose = fresh ? cached.preClose : NaN;
                const pct = (fresh && Number.isFinite(lastPrice) && Number.isFinite(preClose) && preClose !== 0)
                    ? ((lastPrice - preClose) / preClose * 100)
                    : NaN;
                const isClosed = config.type === 'cn' ? !getMarketStatus().isOpen : !isUsMarketOpenNow();

                if (fresh && Number.isFinite(lastPrice)) {
                    const isPositive = Number.isFinite(pct) ? (pct >= 0) : true;
                    const formattedChange = Number.isFinite(pct) ? ((pct >= 0 ? '+' : '') + pct.toFixed(2) + '%') : '--';
                    const timeStr = (Array.isArray(cached.times) && cached.times.length > 0) ? (cached.times[cached.times.length - 1] || '--') : '--';
                    marketIndices[key] = { price: lastPrice.toFixed(2), change: pct, changePct: formattedChange, time: timeStr, secid: config.secid, name: config.name };
                    indexCards.push(`
                        <div class="index-card ${isPositive ? 'positive' : 'negative'} ${selectedIndexKey === key ? 'selected' : ''} ${isClosed ? 'closed' : ''}" 
                             onclick="selectIndex('${key}')" id="indexCard_${key}">
                            <div class="index-header">
                                <div class="index-name"><span class="index-flag">${config.flag}</span>${config.name}</div>
                                <span class="index-status-badge">${isClosed ? 'Closed' : 'Live'}</span>
                            </div>
                            <div class="index-body">
                                <div class="index-value">${lastPrice.toFixed(2)}</div>
                                <div class="index-change">${formattedChange}</div>
                            </div>
                            <div class="index-chart-container" id="chartContainer_${key}" style="display: none;">
                                <div class="index-mini-chart" id="indexChart_${key}"></div>
                            </div>
                        </div>
                    `);
                } else {
                    indexCards.push(`
                        <div class="index-card">
                            <div class="index-header"><div class="index-name"><span class="index-flag">${config.flag}</span>${config.name}</div></div>
                            <div class="index-body"><div class="index-value">---</div><div class="index-change">鍔犺浇澶辫触</div></div>
                        </div>
                    `);
                }
            }
            grid.innerHTML = indexCards.join('');

            if (selectedIndexKey) {
                const card = document.getElementById(`indexCard_${selectedIndexKey}`);
                const container = document.getElementById(`chartContainer_${selectedIndexKey}`);
                if (card) card.classList.add('selected');
                if (container) container.style.display = 'block';
                if (indexCharts[selectedIndexKey]) {
                    try { indexCharts[selectedIndexKey].dispose(); } catch {}
                    delete indexCharts[selectedIndexKey];
                }
                const cached = indexTrendCache[selectedIndexKey];
                if (cached) drawIndexMiniChart(selectedIndexKey, cached);
            }
        };

        fetchAndDrawIndexKline = async function(key) {
            await fetchIndexTrendSnapshot(key);
            const cached = indexTrendCache[key];
            if (cached) drawIndexMiniChart(key, cached);
        };

        function isMiniChartVisible(code) {
            const chartDom = document.getElementById(`miniChart_${code}`);
            if (!chartDom) return false;
            const rect = chartDom.getBoundingClientRect();
            return rect.top < window.innerHeight + 80 && rect.bottom > -80;
        }

        updateMiniChart = function(fund) {
            if (!fund || !fund.code) return;
            const isSelected = selectedFund?.code === fund.code;
            if (!isSelected && !isMiniChartVisible(fund.code)) return;

            const lastUpdate = chartUpdateThrottles.get(fund.code);
            const now = Date.now();
            if (lastUpdate && now - lastUpdate < 200) return;
            chartUpdateThrottles.set(fund.code, now);

            const chartDom = document.getElementById(`miniChart_${fund.code}`);
            if (!chartDom) return;

            const status = getMarketStatus();
            if (!status.canRealtimeUpdate && status.reason !== '鍗堥棿浼戝競') return;

            const c = miniCharts[fund.code];
            if (!c) { initMiniChart(fund); return; }

            const dom0 = (typeof c.getDom === 'function') ? c.getDom() : null;
            if (dom0 && dom0 !== chartDom) {
                c.dispose();
                delete miniCharts[fund.code];
                initMiniChart(fund);
                return;
            }

            const { xData, yData } = getRealtimeChartData(fund);
            const isUp = getDisplayDayGrowth(fund) >= 0;
            c.setOption({
                xAxis: { data: xData },
                series: [{
                    data: yData,
                    connectNulls: true,
                    lineStyle: { width: 2, color: isUp ? '#ef4444' : '#10b981' },
                    areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: isUp ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)' }, { offset: 1, color: 'rgba(255,255,255,0)' }]) }
                }]
            }, { notMerge: false, lazyUpdate: true, silent: true });
        };

        refreshAllFunds = async function(options = {}) {
            const fromInit = !!options.fromInit;
            const btn = document.getElementById('overviewRefreshBtn');
            if (!fromInit) {
                if (!btn) return;
                if (typeof btn.blur === 'function') btn.blur();
                if (btn.disabled) return;
                btn.classList.add('refreshing');
                btn.disabled = true;
            }

            try {
                const list = Array.isArray(funds) ? funds.slice() : [];
                const snapshots = await fetchBatchSnapshotsViaApi(list.map(f => f.code));
                const snapshotMap = new Map(snapshots.map(item => [item.code, item]));

                list.forEach(fund => {
                    const snapshot = snapshotMap.get(fund.code);
                    if (snapshot) applySnapshotToFund(fund, snapshot, { suppressRender: true });
                });

                saveFunds();
                renderFundList();
                renderFundOverview();
                if (selectedFund?.code && currentTimeRange === 'realtime') updateRealtimeChart();
                if (!fromInit) showToast('鎵€鏈夊熀閲戞暟鎹凡鍒锋柊');
            } catch (error) {
                console.error('鍒锋柊澶辫触:', error);
                if (!fromInit) showToast('鍒锋柊澶辫触锛岃绋嶅悗閲嶈瘯', 'error');
            } finally {
                if (!fromInit && btn) {
                    btn.classList.remove('refreshing');
                    btn.disabled = false;
                    if (typeof btn.blur === 'function') btn.blur();
                }
            }
        };
