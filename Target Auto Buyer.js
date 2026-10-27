// ==UserScript==
// @name         Target Auto Buyer
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Target Auto Buyer ⚡ v4.0 — Pokemon Drop & Auto-Monitor Edition with Multi-URL, Multi-Account, Cart Qty Fix & Discord/Telegram alerts
// @author       Pythonic Shariful
// @match        https://www.target.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @connect      discordapp.com
// @connect      api.telegram.org
// @connect      redsky.target.com
// ==/UserScript==

(function() {
    'use strict';

    // =====================================================================
    //  CONFIGURATION — All tunable constants in one place
    // =====================================================================
    const CFG = {
        // Stock polling
        POLL_MIN_MS:            500,     // Normal-mode minimum poll interval
        POLL_MAX_MS:           1500,     // Normal-mode maximum poll interval
        DROP_MODE_POLL_MS:      250,     // Ultra-aggressive drop-mode interval
        ADAPTIVE_LEAD_SEC:       30,     // Seconds before drop time to switch to aggressive

        // API resilience
        API_MAX_RETRIES:          3,
        API_RETRY_BASE_MS:      150,     // Exponential backoff base

        // Add-to-cart
        ATC_MAX_RETRIES:          3,
        ATC_RETRY_MS:           800,     // Delay between ATC re-clicks
        CART_CONFIRM_TIMEOUT_MS:4000,    // Max wait for cart confirmation before fallback

        // Checkout
        CHECKOUT_INTERVAL_MS:   200,     // Checkout loop speed (was 500ms)
        STARTUP_POLL_MS:        100,     // How often to check if page is ready
        STARTUP_MAX_WAIT_MS:   5000,     // Max wait for page ready before proceeding anyway

        // Session pre-warming
        SESSION_CHECK_URL: 'https://www.target.com/co-cart',

        // Multi-Tab & Broadcast
        CHANNEL_NAME: 'target_auto_buyer_channel_v4',
    };

    // =====================================================================
    //  PERFORMANCE METRICS & ORDER STATS
    // =====================================================================
    const metrics = {
        pollCount: 0,
        stockDetectedAt: null,
        atcClickedAt: null,
        cartConfirmedAt: null,
        checkoutStartedAt: null,
        orderPlacedAt: null,
        reset() {
            this.pollCount = 0;
            this.stockDetectedAt = null;
            this.atcClickedAt = null;
            this.cartConfirmedAt = null;
            this.checkoutStartedAt = null;
            this.orderPlacedAt = null;
        },
        elapsed(from) {
            if (!from) return '—';
            return ((Date.now() - from) / 1000).toFixed(2) + 's';
        },
        summary() {
            const parts = [];
            if (this.stockDetectedAt) {
                parts.push(`Stock→ATC: ${this.atcClickedAt ? ((this.atcClickedAt - this.stockDetectedAt) / 1000).toFixed(2) + 's' : '...'}`);
            }
            if (this.atcClickedAt && this.cartConfirmedAt) {
                parts.push(`ATC→Cart: ${((this.cartConfirmedAt - this.atcClickedAt) / 1000).toFixed(2)}s`);
            }
            if (this.cartConfirmedAt && this.checkoutStartedAt) {
                parts.push(`Cart→Checkout: ${((this.checkoutStartedAt - this.cartConfirmedAt) / 1000).toFixed(2)}s`);
            }
            if (this.stockDetectedAt && this.orderPlacedAt) {
                parts.push(`TOTAL: ${((this.orderPlacedAt - this.stockDetectedAt) / 1000).toFixed(2)}s`);
            }
            return parts.length ? parts.join(' | ') : 'Waiting...';
        }
    };

    // =====================================================================
    //  CROSS-TAB BROADCAST CHANNEL (Multi-Account & Multi-Tab)
    // =====================================================================
    const tabId = 'tab_' + Math.random().toString(36).substring(2, 9);
    let broadcastChannel = null;

    try {
        if (typeof BroadcastChannel !== 'undefined') {
            broadcastChannel = new BroadcastChannel(CFG.CHANNEL_NAME);
            broadcastChannel.onmessage = (event) => {
                handleBroadcastMessage(event.data);
            };
        }
    } catch (e) {
        // Fallback or ignore if unsupported
    }

    function sendBroadcast(type, payload = {}) {
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage({ type, tabId, ...payload });
            } catch (e) {}
        }
    }

    function handleBroadcastMessage(data) {
        if (!data || data.tabId === tabId) return;

        switch (data.type) {
            case 'GLOBAL_START':
                if (!getTabRunning()) {
                    console.log(`Target Bot [Multi-Tab]: Received START from ${data.tabId}`);
                    setTabRunning(true);
                    updateStatusUI(true);
                    runBot();
                }
                break;
            case 'GLOBAL_STOP':
                if (getTabRunning()) {
                    console.log(`Target Bot [Multi-Tab]: Received STOP from ${data.tabId}`);
                    setTabRunning(false);
                    updateStatusUI(false);
                    stopAllTimers();
                }
                break;
            case 'ORDER_COMPLETED':
                console.log(`Target Bot [Multi-Tab]: Tab ${data.tabId} completed an order! Total purchased: ${data.totalPurchased}`);
                updateGoalUI();
                break;
            case 'CLAIM_TCIN':
                // Another tab is already handling this TCIN
                if (data.tcin && data.tcin === extractTcin() && getTabRunning()) {
                    console.log(`Target Bot [Multi-Tab]: Notice: TCIN ${data.tcin} is also being processed by ${data.tabId}`);
                }
                break;
        }
    }

    // =====================================================================
    //  CONSOLE LOG HOOK — High-precision timestamps for diagnostics
    // =====================================================================
    const originalConsoleLog = console.log;
    console.log = function(...args) {
        originalConsoleLog.apply(console, args);
        const logArea = document.getElementById('bot-log-area');
        if (logArea) {
            const message = args.join(' ');
            const now = new Date();
            const time = now.toLocaleTimeString('en-US', {
                hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
            }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
            const lines = logArea.textContent ? logArea.textContent.split('\n') : [];
            lines.push(`[${time}] ${message}`);
            logArea.textContent = lines.slice(-300).join('\n');
            logArea.scrollTop = logArea.scrollHeight;
        }
    };

    // =====================================================================
    //  BOT STATE — Centralized state management
    // =====================================================================
    const state = {
        atcRetries:           0,
        placeOrderAttempted:  false,
        cartObserver:         null,
        checkoutLoop:         null,
        pollTimeout:          null,
        cartTimeout:          null,
        searchPollTimeout:    null,
        placeOrderError:      null,
        domObserver:          null,
        sessionValid:         null,
        dropTimerInterval:    null,
        multiUrlIndex:        0,
        lastAddedTcin:        null,
    };

    function stopAllTimers() {
        clearTimeout(state.pollTimeout);
        clearTimeout(state.cartTimeout);
        clearTimeout(state.searchPollTimeout);
        if (state.cartObserver) { state.cartObserver.disconnect(); state.cartObserver = null; }
        if (state.checkoutLoop) { clearInterval(state.checkoutLoop); state.checkoutLoop = null; }
        if (state.domObserver)  { state.domObserver.disconnect(); state.domObserver = null; }
        if (state.dropTimerInterval) { clearInterval(state.dropTimerInterval); state.dropTimerInterval = null; }
        state.atcRetries = 0;
        state.placeOrderAttempted = false;
        state.placeOrderError = null;
    }

    // =====================================================================
    //  TAB-SCOPED RUNNING STATE  (sessionStorage so each tab is independent)
    // =====================================================================
    function getTabRunning() {
        try { return window.sessionStorage.getItem('targetBotRunning') === '1'; }
        catch (e) { return false; }
    }

    function setTabRunning(running) {
        try {
            if (running) window.sessionStorage.setItem('targetBotRunning', '1');
            else         window.sessionStorage.removeItem('targetBotRunning');
        } catch (e) { /* ignore */ }
    }

    // =====================================================================
    //  PURCHASE GOAL TRACKING (Persists across orders & tabs)
    // =====================================================================
    function getPurchasedCount() {
        return parseInt(GM_getValue('purchasedCount', '0'), 10) || 0;
    }

    function incrementPurchasedCount(qty = 1) {
        const count = getPurchasedCount() + qty;
        GM_setValue('purchasedCount', String(count));
        sendBroadcast('ORDER_COMPLETED', { totalPurchased: count, qtyAdded: qty });
        return count;
    }

    function getTargetGoal() {
        return parseInt(GM_getValue('targetGoal', '1000'), 10) || 1000;
    }

    // =====================================================================
    //  DOM HELPERS
    // =====================================================================
    function $(sel, root = document)  { return root.querySelector(sel); }
    function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
    function xpath(path, root = document) {
        return document.evaluate(path, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    function isDisabled(el) {
        if (!el) return true;
        if (el.disabled) return true;
        if ((el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
        if ((el.getAttribute('data-component-state') || '').toLowerCase() === 'disabled') return true;
        return /\.disabled$/i.test(el.id || '');
    }

    /** Set a React-controlled input's value without React swallowing the change */
    function setNativeValue(el, value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
            setter.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // =====================================================================
    //  TCIN EXTRACTION
    // =====================================================================
    function extractTcin(url = window.location.href) {
        const m = url.match(/A-(\d+)/);
        return m ? m[1] : null;
    }

    // =====================================================================
    //  PRODUCT TITLE EXTRACTION
    // =====================================================================
    function getProductTitle() {
        const titleEl = $('h1[data-test="product-title"]') || $('[data-test="product-title"]') || $('h1');
        if (titleEl && titleEl.textContent.trim()) {
            return titleEl.textContent.trim();
        }
        const cleanDocTitle = (document.title || '').replace(/\s*:\s*Target$/i, '').trim();
        return cleanDocTitle || 'Target Product';
    }

    // =====================================================================
    //  HTTP TRANSPORT — GM_xmlhttpRequest with fetch fallback
    // =====================================================================
    function httpRequest(options) {
        return new Promise((resolve, reject) => {
            const gmXhr = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
                          (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest : null;
            if (gmXhr) {
                gmXhr({
                    method: options.method || 'GET',
                    url: options.url,
                    headers: options.headers || {},
                    data: options.data,
                    timeout: options.timeout || 10000,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            resolve(res.responseText);
                        } else {
                            reject(new Error(`HTTP ${res.status}: ${res.responseText || res.statusText}`));
                        }
                    },
                    onerror: (err) => reject(new Error(err?.error || err?.statusText || 'Network request failed')),
                    ontimeout: () => reject(new Error('Request timed out')),
                });
            } else if (typeof fetch === 'function') {
                fetch(options.url, {
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    body: options.data,
                })
                .then(async res => {
                    if (res.ok) resolve(await res.text());
                    else reject(new Error(`HTTP ${res.status}: ${await res.text()}`));
                })
                .catch(reject);
            } else {
                reject(new Error('No HTTP transport available'));
            }
        });
    }

    // =====================================================================
    //  AUDIO NOTIFICATION SYSTEM (Web Audio API Synthesizer)
    // =====================================================================
    const Sound = {
        ctx: null,
        getContext() {
            if (!this.ctx) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (AudioCtx) {
                    this.ctx = new AudioCtx();
                }
            }
            if (this.ctx && this.ctx.state === 'suspended') {
                this.ctx.resume().catch(() => {});
            }
            return this.ctx;
        },

        playTone(freq, type, duration, startTime = 0, gainLevel = 0.15) {
            const ctx = this.getContext();
            if (!ctx) return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = type || 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);

            gain.gain.setValueAtTime(gainLevel, ctx.currentTime + startTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startTime + duration);

            osc.connect(gain);
            gain.connect(ctx.destination);

            osc.start(ctx.currentTime + startTime);
            osc.stop(ctx.currentTime + startTime + duration);
        },

        // Stock alert: Ascending arpeggio (C5 -> E5 -> G5 -> C6)
        stockAlert() {
            if (!GM_getValue('soundEnabled', true)) return;
            try {
                this.playTone(523.25, 'triangle', 0.12, 0.00, 0.22); // C5
                this.playTone(659.25, 'triangle', 0.12, 0.10, 0.22); // E5
                this.playTone(783.99, 'triangle', 0.12, 0.20, 0.22); // G5
                this.playTone(1046.50, 'sine',     0.35, 0.30, 0.28); // C6
            } catch (e) {
                console.log(`Target Bot: Audio playback error: ${e.message}`);
            }
        },

        // Cart alert: Positive two-tone chime
        cartAlert() {
            if (!GM_getValue('soundEnabled', true)) return;
            try {
                this.playTone(783.99, 'sine', 0.15, 0.00, 0.20); // G5
                this.playTone(1046.50, 'sine', 0.25, 0.12, 0.25); // C6
            } catch (e) {
                console.log(`Target Bot: Audio playback error: ${e.message}`);
            }
        },

        // Order Confirmed: Victory fanfare chord
        orderConfirmedAlert() {
            if (!GM_getValue('soundEnabled', true)) return;
            try {
                this.playTone(523.25, 'triangle', 0.12, 0.00, 0.25); // C5
                this.playTone(523.25, 'triangle', 0.12, 0.12, 0.25); // C5
                this.playTone(523.25, 'triangle', 0.12, 0.24, 0.25); // C5
                this.playTone(659.25, 'triangle', 0.20, 0.36, 0.28); // E5
                this.playTone(783.99, 'sine',     0.22, 0.54, 0.30); // G5
                this.playTone(1046.50, 'sine',    0.55, 0.72, 0.35); // C6
            } catch (e) {
                console.log(`Target Bot: Audio playback error: ${e.message}`);
            }
        },

        // Error / Alert: Double alert pulse
        errorAlert() {
            if (!GM_getValue('soundEnabled', true)) return;
            try {
                this.playTone(330, 'sawtooth', 0.20, 0.00, 0.15);
                this.playTone(260, 'sawtooth', 0.30, 0.18, 0.18);
            } catch (e) {
                console.log(`Target Bot: Audio playback error: ${e.message}`);
            }
        }
    };

    // =====================================================================
    //  DISCORD & TELEGRAM WEBHOOK NOTIFIERS
    // =====================================================================
    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    async function sendDiscordNotification(event, details = {}) {
        const webhookUrl = GM_getValue('discordWebhook', '').trim();
        if (!webhookUrl) return;

        const colors = {
            stock:     0x22c55e, // Vibrant Green
            cart:      0x3b82f6, // Bright Blue
            submitted: 0xf59e0b, // Amber Warning/Pending
            order:     0x10b981, // Emerald Celebration
            error:     0xef4444, // Red Alert
            test:      0x8b5cf6, // Violet
        };

        const titles = {
            stock:     '🚨 TARGET IN-STOCK DETECTED',
            cart:      '🛒 ITEM ADDED TO CART',
            submitted: '🛍️ CHECKOUT SUBMITTED',
            order:     '🎉 ORDER CONFIRMED SUCCESSFULLY',
            error:     '⚠️ TARGET BOT WARNING / ERROR',
            test:      '🧪 DISCORD WEBHOOK TEST SUCCESSFUL',
        };

        const embedFields = [];
        if (details.productName) {
            embedFields.push({ name: '📦 Product', value: `[${details.productName}](${details.url || window.location.href})`, inline: false });
        }
        if (details.tcin) {
            embedFields.push({ name: '🔢 TCIN', value: `\`${details.tcin}\``, inline: true });
        }
        if (details.price) {
            embedFields.push({ name: '💰 Price', value: `**${details.price}**`, inline: true });
        }
        if (details.qty) {
            embedFields.push({ name: '🛒 Qty', value: `\`${details.qty}\``, inline: true });
        }
        if (details.goal) {
            embedFields.push({ name: '🎯 Goal Progress', value: `\`${details.goal}\``, inline: true });
        }
        if (details.metrics) {
            embedFields.push({ name: '⚡ Latency / Timing', value: `\`${details.metrics}\``, inline: false });
        }
        if (details.customFields && Array.isArray(details.customFields)) {
            embedFields.push(...details.customFields);
        }

        const embed = {
            title: details.title || titles[event] || 'Target Auto Buyer Notification',
            description: details.message || (details.url ? `[View Product on Target.com](${details.url})` : ''),
            url: details.url || window.location.href,
            color: colors[event] || 0xcc0000,
            fields: embedFields,
            thumbnail: {
                url: 'https://assets.targetimg1.com/web/static-resources/favicons/favicon.ico'
            },
            footer: {
                text: 'Target Auto Buyer ⚡ v4.0 Pokemon Edition',
                icon_url: 'https://assets.targetimg1.com/web/static-resources/favicons/favicon.ico'
            },
            timestamp: new Date().toISOString(),
        };

        const payload = JSON.stringify({
            username: 'Target Auto Buyer v4.0',
            avatar_url: 'https://assets.targetimg1.com/web/static-resources/favicons/favicon.ico',
            embeds: [embed],
        });

        try {
            await httpRequest({
                method: 'POST',
                url: webhookUrl,
                headers: { 'Content-Type': 'application/json' },
                data: payload,
            });
            console.log(`Target Bot: 💬 Discord embed notification sent (${event})`);
        } catch (err) {
            console.log(`Target Bot: ⚠️ Discord notification failed: ${err.message}`);
        }
    }

    async function sendTelegramNotification(event, details = {}) {
        const token = GM_getValue('telegramToken', '').trim();
        const chatId = GM_getValue('telegramChatId', '').trim();
        if (!token || !chatId) return;

        const eventHeaders = {
            stock:     '🚨 <b>TARGET ITEM IN-STOCK!</b>',
            cart:      '🛒 <b>ADDED TO CART!</b>',
            submitted: '🛍️ <b>ORDER SUBMITTED!</b>',
            order:     '🎉 <b>ORDER CONFIRMED!</b>',
            error:     '⚠️ <b>BOT ALERT / ATTENTION NEEDED</b>',
            test:      '🧪 <b>TELEGRAM INTEGRATION TEST</b>',
        };

        const header = eventHeaders[event] || '🎯 <b>TARGET AUTO BUYER ALERT</b>';

        let text = `${header}\n`;
        text += `━━━━━━━━━━━━━━━━━━━━\n`;

        if (details.productName) {
            text += `📦 <b>Product:</b> <i>${escapeHtml(details.productName)}</i>\n`;
        }
        if (details.tcin) {
            text += `🔢 <b>TCIN:</b> <code>${escapeHtml(String(details.tcin))}</code>\n`;
        }
        if (details.price) {
            text += `💰 <b>Price:</b> <code>${escapeHtml(String(details.price))}</code>\n`;
        }
        if (details.qty) {
            text += `🛒 <b>Quantity:</b> <code>${escapeHtml(String(details.qty))}</code>\n`;
        }
        if (details.goal) {
            text += `🎯 <b>Goal Progress:</b> <code>${escapeHtml(String(details.goal))}</code>\n`;
        }
        if (details.metrics) {
            text += `⚡ <b>Latency:</b> <code>${escapeHtml(details.metrics)}</code>\n`;
        }
        if (details.message) {
            text += `\n💬 <b>Details:</b> ${escapeHtml(details.message)}\n`;
        }
        if (details.url) {
            text += `\n🔗 <a href="${details.url}"><b>👉 View on Target.com</b></a>\n`;
        }

        const now = new Date().toLocaleTimeString('en-US', { hour12: false });
        text += `━━━━━━━━━━━━━━━━━━━━\n`;
        text += `⏰ <i>${now} • Target Auto Buyer ⚡ v4.0</i>`;

        const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
        const payload = JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
        });

        try {
            await httpRequest({
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: payload,
            });
            console.log(`Target Bot: ✈️ Telegram notification sent (${event})`);
        } catch (err) {
            console.log(`Target Bot: ⚠️ Telegram notification failed: ${err.message}`);
        }
    }

    const Notifier = {
        lastStockNoticeTime: 0,
        lastCartNoticeTime: 0,
        lastOrderNoticeTime: 0,

        async notifyStock(tcin, price) {
            const now = Date.now();
            if (now - this.lastStockNoticeTime < 10000) return;
            this.lastStockNoticeTime = now;

            const title = getProductTitle();
            const url = window.location.href;
            const qty = GM_getValue('qty', '1');
            const priceStr = price ? `$${price}` : 'Check PDP';

            Sound.stockAlert();

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyStock', true)) {
                sendDiscordNotification('stock', {
                    title: '🚨 TARGET ITEM IN-STOCK!',
                    message: `Product is in-stock! Attempting immediate add-to-cart...`,
                    productName: title,
                    tcin: tcin,
                    price: priceStr,
                    qty: qty,
                    url: url,
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyStock', true)) {
                sendTelegramNotification('stock', {
                    message: 'Stock detected on Target! Auto-buying initiated.',
                    productName: title,
                    tcin: tcin,
                    price: priceStr,
                    qty: qty,
                    url: url,
                }).catch(() => {});
            }
        },

        async notifyCart(tcin) {
            const now = Date.now();
            if (now - this.lastCartNoticeTime < 10000) return;
            this.lastCartNoticeTime = now;

            const title = getProductTitle();
            const url = window.location.href;
            const elapsed = metrics.atcClickedAt ? `${((Date.now() - metrics.atcClickedAt) / 1000).toFixed(2)}s` : 'Instant';

            Sound.cartAlert();

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyCart', true)) {
                sendDiscordNotification('cart', {
                    title: '🛒 ADDED TO CART CONFIRMED!',
                    message: `Item added to cart in **${elapsed}**! Proceeding to checkout...`,
                    productName: title,
                    tcin: tcin || extractTcin(),
                    url: url,
                    metrics: `ATC→Cart: ${elapsed}`,
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyCart', true)) {
                sendTelegramNotification('cart', {
                    message: `Item successfully placed in cart in ${elapsed}. Heading to checkout!`,
                    productName: title,
                    tcin: tcin || extractTcin(),
                    url: url,
                    metrics: `ATC→Cart: ${elapsed}`,
                }).catch(() => {});
            }
        },

        async notifyOrderPlaced() {
            const title = getProductTitle();
            const url = window.location.href;
            const tcin = extractTcin();

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendDiscordNotification('submitted', {
                    title: '🛍️ PLACE ORDER SUBMITTED!',
                    message: `Place Order clicked once. Waiting for order confirmation page...`,
                    productName: title,
                    tcin: tcin,
                    url: url,
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendTelegramNotification('submitted', {
                    message: 'Place Order button submitted. Awaiting confirmation.',
                    productName: title,
                    tcin: tcin,
                    url: url,
                }).catch(() => {});
            }
        },

        async notifyOrderConfirmed(qtyBought = 1) {
            const now = Date.now();
            if (now - this.lastOrderNoticeTime < 10000) return;
            this.lastOrderNoticeTime = now;

            const title = getProductTitle();
            const url = window.location.href;
            const tcin = extractTcin();
            const timingSummary = metrics.summary();
            const currentTotal = getPurchasedCount();
            const goalTotal = getTargetGoal();
            const goalStr = `${currentTotal}/${goalTotal} units`;

            Sound.orderConfirmedAlert();

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendDiscordNotification('order', {
                    title: '🎉 TARGET ORDER CONFIRMED!',
                    message: `Target order placed and confirmed successfully! Verify your confirmation email.`,
                    productName: title,
                    tcin: tcin,
                    url: url,
                    qty: qtyBought,
                    goal: goalStr,
                    metrics: timingSummary,
                    customFields: [
                        { name: '✅ Status', value: 'Order Accepted & Confirmed', inline: true },
                        { name: '🎯 Progress', value: goalStr, inline: true }
                    ]
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendTelegramNotification('order', {
                    message: `Order confirmed by Target! Goal progress: ${goalStr}`,
                    productName: title,
                    tcin: tcin,
                    url: url,
                    qty: qtyBought,
                    goal: goalStr,
                    metrics: timingSummary,
                }).catch(() => {});
            }
        },

        async notifyError(message) {
            Sound.errorAlert();
            const title = getProductTitle();
            const url = window.location.href;

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyError', true)) {
                sendDiscordNotification('error', {
                    title: '⚠️ TARGET BOT ALERT / ATTENTION',
                    message: message,
                    productName: title,
                    tcin: extractTcin(),
                    url: url,
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyError', true)) {
                sendTelegramNotification('error', {
                    message: message,
                    productName: title,
                    tcin: extractTcin(),
                    url: url,
                }).catch(() => {});
            }
        }
    };

    // =====================================================================
    //  POLL INTERVAL — respects drop-mode and adaptive timing
    // =====================================================================
    function getPollInterval() {
        if (GM_getValue('dropMode', false)) return CFG.DROP_MODE_POLL_MS;

        const dropTime = GM_getValue('dropTime', '');
        if (dropTime) {
            const target = new Date(dropTime).getTime();
            const now    = Date.now();
            const diff   = (target - now) / 1000;
            if (diff > 0 && diff <= CFG.ADAPTIVE_LEAD_SEC) {
                return CFG.DROP_MODE_POLL_MS;
            }
        }

        const lo = Math.max(200, parseInt(GM_getValue('minDelay', String(CFG.POLL_MIN_MS)), 10) || CFG.POLL_MIN_MS);
        const hi = Math.max(lo,  parseInt(GM_getValue('maxDelay', String(CFG.POLL_MAX_MS)), 10) || CFG.POLL_MAX_MS);
        return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }

    // =====================================================================
    //  SMART PRICE PARSER (Fixes $800+ and Price Ranges)
    // =====================================================================
    function getCurrentPrice() {
        const priceContainer =
            $('[data-test="product-price"]') ||
            $('[data-test="@web/Price/Large"]') ||
            $('span.styles_currentPriceFontSize__Xps20') ||
            $('div[data-test="product-price"]') ||
            $('span[data-test="product-price"]');

        if (!priceContainer) {
            const priceEl = xpath("//*[contains(text(), '$') and (contains(@class, 'price') or contains(@data-test, 'price'))]");
            if (priceEl) {
                const m = (priceEl.textContent || '').match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
                if (m) return parseFloat(m[1].replace(/,/g, ''));
            }
            return null;
        }

        const firstSpan = priceContainer.querySelector('span') || priceContainer;
        const rawText = (firstSpan.textContent || priceContainer.textContent || '').trim();

        // Extract first valid dollar amount
        const match = rawText.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        if (match) {
            const val = parseFloat(match[1].replace(/,/g, ''));
            return Number.isFinite(val) ? val : null;
        }

        const cleaned = rawText.split(/[-–—\s]|reg|was/i)[0].replace(/[^0-9.]/g, '');
        const val = parseFloat(cleaned);
        return Number.isFinite(val) ? val : null;
    }

    function getMaxPrice() {
        const v = parseFloat((GM_getValue('maxPrice', '0') || '0').toString().trim());
        return Number.isFinite(v) ? v : 0;
    }

    // =====================================================================
    //  FIND ADD-TO-CART BUTTON — Comprehensive & Prioritized (Fixes Bug 1)
    // =====================================================================
    function findATCButton() {
        const tcin = extractTcin();

        // Priority 1: Direct active ATC / Shipping button
        const selectors = [
            'button[data-test="shippingButton"]:not([disabled])',
            'button[data-test="shipItButton"]:not([disabled])',
            'button[data-test="orderPickupButton"]:not([disabled])',
            'button[data-test="addToCartButton"]:not([disabled])',
        ];

        if (tcin) {
            selectors.unshift(`button#addToCartButtonOrTextIdFor${tcin}:not([disabled])`);
            selectors.unshift(`#addToCartButtonOrTextIdFor${tcin}:not([disabled])`);
        }
        selectors.push('button[id^="addToCartButtonOrTextIdFor"]:not([disabled])');

        for (const sel of selectors) {
            const btn = $(sel);
            if (btn && isVisible(btn) && !isDisabled(btn)) {
                return btn;
            }
        }

        // Priority 2: Fulfillment selector needs to be clicked first (e.g. Shipping cell)
        const shippingCell =
            $('button[data-test="fulfillment-cell-shipping"]:not([disabled])') ||
            $('div[data-test="fulfillment-cell-shipping"] button:not([disabled])') ||
            $('input[type="radio"][value="SHIPPING"]') ||
            $('button[data-test="@web/Fulfillment/ShippingButton"]:not([disabled])');

        if (shippingCell && isVisible(shippingCell) && !isDisabled(shippingCell)) {
            const isSelected = shippingCell.getAttribute('aria-checked') === 'true' ||
                               shippingCell.classList.contains('selected') ||
                               shippingCell.checked;
            if (!isSelected) {
                console.log('Target Bot: Selecting Shipping fulfillment option first...');
                shippingCell.click();
            }
        }

        // Priority 3: Visible text buttons (Add to cart, Preorder, Ship it)
        const xpathList = [
            "//button[not(@disabled) and (contains(normalize-space(.), 'Add to cart') or contains(normalize-space(.), 'Preorder') or contains(normalize-space(.), 'Preorder now') or contains(normalize-space(.), 'Ship it'))]",
            "//button[not(@disabled) and @data-test='shippingButton']",
            "//button[not(@disabled) and contains(@id, 'addToCart')]"
        ];

        for (const xp of xpathList) {
            const btn = xpath(xp);
            if (btn && isVisible(btn) && !isDisabled(btn)) {
                return btn;
            }
        }

        return null;
    }

    // =====================================================================
    //  OUT-OF-STOCK DETECTION — Accurate (Doesn't falsely trigger on store pickup)
    // =====================================================================
    function isOutOfStock() {
        // If an active, enabled ATC button is already present, it is DEFINITELY in stock!
        if (findATCButton()) return false;

        // Targeted explicit OOS selectors
        const explicitOosSelectors = [
            '[data-test="outOfStockButton"]',
            '[data-test="soldOutButton"]',
            'button[disabled][data-test="shippingButton"]',
            'button[disabled][id^="addToCartButtonOrTextIdFor"]',
        ];

        for (const sel of explicitOosSelectors) {
            const el = $(sel);
            if (el && isVisible(el)) return true;
        }

        // Check if fulfillment shipping block specifically states Out of Stock
        const shippingBlock = $('[data-test="fulfillment-cell-shipping"]') || $('[data-test="shipping-drawer"]');
        if (shippingBlock) {
            const text = (shippingBlock.textContent || '').toLowerCase();
            if (text.includes('out of stock') || text.includes('sold out') || text.includes('unavailable')) {
                return true;
            }
        }

        // Global check ONLY if no fulfillment buttons exist at all
        const allAtcButtons = $$('button[id*="addToCart"], button[data-test*="shippingButton"], button[data-test*="addToCart"]');
        if (allAtcButtons.length > 0 && allAtcButtons.every(b => isDisabled(b))) {
            return true;
        }

        return false;
    }

    // =====================================================================
    //  QUANTITY CONTROLLER (Fixes Bug 2 — PDP, Drawer, and Cart Page)
    // =====================================================================
    const QuantityManager = {
        // Step 1: PDP Quantity Setting
        async applyQuantityOnPdp(targetQty) {
            if (!targetQty || targetQty === '1') return true;

            // A) Native <select>
            const nativeSelect = $('select[data-test="quantity-select"]') || $('select[name="quantity"]') || $('select[id^="select-"]');
            if (nativeSelect && isVisible(nativeSelect)) {
                if (nativeSelect.value !== targetQty) {
                    console.log(`Target Bot: Setting PDP native select quantity ${nativeSelect.value} → ${targetQty}`);
                    nativeSelect.value = targetQty;
                    nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    await sleep(150);
                    return true;
                }
            }

            // B) Target Custom Dropdown button
            const qtyBtn = $('button[data-test="custom-quantity-picker"]') ||
                           $('button[id^="select-"]') ||
                           $('button[data-test="quantity-select"]') ||
                           xpath("//button[contains(., 'Qty')]");

            if (qtyBtn && isVisible(qtyBtn)) {
                const currentText = (qtyBtn.innerText || qtyBtn.textContent || '').trim();
                const currentNum = currentText.match(/\d+/)?.[0] || '1';

                if (currentNum !== targetQty) {
                    console.log(`Target Bot: PDP Quantity is ${currentNum}, aiming for ${targetQty}. Opening dropdown...`);
                    qtyBtn.click();
                    await sleep(150);

                    // Find option matching targetQty
                    const option =
                        $(`div[role="listbox"] div[role="option"][data-value="${targetQty}"]`) ||
                        $(`ul[role="listbox"] li[role="option"][data-value="${targetQty}"]`) ||
                        $(`[data-test="select-option"][data-value="${targetQty}"]`) ||
                        $(`ul.Options_styles_options__UapY8 a[aria-label="${targetQty}"]`) ||
                        $(`ul a[aria-label="${targetQty}"]`) ||
                        xpath(`//*[@role='option' and (normalize-space()='${targetQty}' or @data-value='${targetQty}')]`) ||
                        xpath(`//button[normalize-space()='${targetQty}' or @data-value='${targetQty}']`);

                    if (option) {
                        console.log(`Target Bot: Selecting option ${targetQty}...`);
                        option.click();
                        await sleep(150);
                        return true;
                    } else {
                        // If exact target not found, select max available option
                        const allOptions = $$('[role="option"], ul a[aria-label]');
                        if (allOptions.length > 0) {
                            const lastOption = allOptions[allOptions.length - 1];
                            console.log(`Target Bot: Option ${targetQty} capped. Selecting highest available option: ${lastOption.textContent?.trim()}`);
                            lastOption.click();
                            await sleep(150);
                            return true;
                        }
                    }
                }
            }

            // C) Numeric Stepper (+ button)
            const plusBtn = $('button[data-test="stepper-plus"]') ||
                            $('button[data-test="quantity-stepper-increment"]') ||
                            $('button[aria-label="Increase quantity"]') ||
                            xpath("//button[@aria-label='Increase quantity' or contains(@aria-label, 'increase')]");

            if (plusBtn && isVisible(plusBtn) && !isDisabled(plusBtn)) {
                let attempts = 0;
                while (attempts < parseInt(targetQty, 10) - 1 && !isDisabled(plusBtn)) {
                    plusBtn.click();
                    attempts++;
                    await sleep(100);
                }
                return true;
            }

            return false;
        },

        // Step 2: Cart Page /cart Quantity Maximizer
        async applyQuantityOnCartPage(targetQty) {
            if (!targetQty || targetQty === '1') return true;
            console.log(`Target Bot: Checking/Adjusting cart quantity to ${targetQty}...`);

            // A) Cart item <select>
            const cartSelect = $('select[data-test="cartItem-qty"]') ||
                               $('select[data-test="cart-item-qty"]') ||
                               $('select[id^="cart-item-qty"]') ||
                               $('select[name="quantity"]');

            if (cartSelect && isVisible(cartSelect)) {
                if (cartSelect.value !== targetQty) {
                    // Check if option for targetQty exists
                    const hasOption = Array.from(cartSelect.options).some(o => o.value === targetQty);
                    if (hasOption) {
                        console.log(`Target Bot: Cart select: setting quantity to ${targetQty}...`);
                        cartSelect.value = targetQty;
                    } else {
                        // Select max allowed
                        const maxOption = cartSelect.options[cartSelect.options.length - 1];
                        console.log(`Target Bot: Cart limit detected. Selecting maximum allowed quantity: ${maxOption?.value}`);
                        cartSelect.value = maxOption?.value || '1';
                    }
                    cartSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    await sleep(400);
                    return true;
                }
            }

            // B) Cart item Stepper
            const plusBtn = $('button[data-test="cartItem-qty-increment"]') ||
                            $('button[data-test="stepper-plus"]') ||
                            $('button[aria-label="Increase quantity"]');

            if (plusBtn && isVisible(plusBtn) && !isDisabled(plusBtn)) {
                let count = 0;
                while (count < parseInt(targetQty, 10) - 1 && !isDisabled(plusBtn)) {
                    plusBtn.click();
                    count++;
                    await sleep(200);
                }
                return true;
            }

            return false;
        }
    };

    // =====================================================================
    //  API STOCK CHECK WITH RETRY + BACKOFF
    // =====================================================================
    async function checkStockApi(tcin) {
        const apiKey = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
        const url = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=${tcin}&key=${apiKey}`;

        for (let attempt = 1; attempt <= CFG.API_MAX_RETRIES; attempt++) {
            try {
                const resp = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    cache: 'no-store',
                });

                if (resp.ok) {
                    const data = await resp.json();
                    const status = data?.data?.product?.fulfillment?.shipping_options?.availability_status;
                    // Also check partner fulfillment or general availability
                    const storeStatus = data?.data?.product?.fulfillment?.store_options?.availability_status;
                    return status === 'IN_STOCK' || storeStatus === 'IN_STOCK';
                }

                if (resp.status >= 500 && attempt < CFG.API_MAX_RETRIES) {
                    await sleep(CFG.API_RETRY_BASE_MS * attempt);
                    continue;
                }
                return false;
            } catch (e) {
                if (attempt < CFG.API_MAX_RETRIES) {
                    await sleep(CFG.API_RETRY_BASE_MS * attempt);
                }
            }
        }
        return false;
    }

    // =====================================================================
    //  STOCK POLLING
    // =====================================================================
    async function pollStock(tcin) {
        if (!getTabRunning()) return;
        metrics.pollCount++;
        const pollNumber = metrics.pollCount;
        console.log(`Target Bot: Checking stock for TCIN ${tcin} (#${pollNumber})...`);

        // Check DOM first
        const directBtn = findATCButton();
        if (directBtn) {
            metrics.stockDetectedAt = Date.now();
            console.log(`Target Bot: ✅ ATC button detected directly in DOM! (#${pollNumber})`);
            Notifier.notifyStock(tcin, getCurrentPrice());
            beginAddToCart(directBtn);
            return;
        }

        // Query API
        const inStock = await checkStockApi(tcin);

        if (inStock) {
            metrics.stockDetectedAt = Date.now();
            console.log(`Target Bot: ✅ IN STOCK detected via API! (#${pollNumber})`);
            Notifier.notifyStock(tcin, getCurrentPrice());

            const btn = findATCButton();
            if (btn) {
                beginAddToCart(btn);
                return;
            }

            console.log('Target Bot: ATC button not ready in DOM yet. Fast-reloading...');
            window.location.reload();
            return;
        }

        console.log(`Target Bot: Stock check #${pollNumber} — not in stock yet.`);

        const interval = getPollInterval();
        clearTimeout(state.pollTimeout);
        state.pollTimeout = setTimeout(() => pollStock(tcin), interval);
    }

    // =====================================================================
    //  DUAL-MODE MONITORING (API + DOM)
    // =====================================================================
    function startDualModeMonitoring(tcin) {
        pollStock(tcin);

        if (state.domObserver) state.domObserver.disconnect();

        state.domObserver = new MutationObserver(() => {
            if (!getTabRunning()) { state.domObserver?.disconnect(); return; }
            const btn = findATCButton();
            if (btn) {
                console.log('Target Bot: ✅ ATC button appeared in DOM! Clicking immediately.');
                metrics.stockDetectedAt = metrics.stockDetectedAt || Date.now();
                Notifier.notifyStock(tcin, getCurrentPrice());
                clearTimeout(state.pollTimeout);
                state.domObserver.disconnect();
                state.domObserver = null;
                beginAddToCart(btn);
            }
        });

        const target = $('[data-test="product-detail-highlights"]')?.parentElement || document.body;
        state.domObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }

    // =====================================================================
    //  ADD TO CART
    // =====================================================================
    function beginAddToCart(button) {
        if (!getTabRunning()) return;
        state.atcRetries = 0;
        metrics.atcClickedAt = Date.now();
        state.lastAddedTcin = extractTcin();
        sendBroadcast('CLAIM_TCIN', { tcin: state.lastAddedTcin });
        clickATC(button);
    }

    function clickATC(button) {
        if (!getTabRunning()) return;
        state.atcRetries++;
        console.log(`Target Bot: 🛒 ATC click #${state.atcRetries}/${CFG.ATC_MAX_RETRIES}`);
        button.click();

        watchForCartConfirmation();

        clearTimeout(state.cartTimeout);
        state.cartTimeout = setTimeout(() => {
            if (!getTabRunning()) return;
            if (state.cartObserver) { state.cartObserver.disconnect(); state.cartObserver = null; }

            if (state.atcRetries < CFG.ATC_MAX_RETRIES) {
                console.log('Target Bot: Cart confirmation timeout — retrying click...');
                const btn = findATCButton();
                if (btn) {
                    clickATC(btn);
                } else {
                    console.log('Target Bot: ATC button gone. Navigating to cart/checkout...');
                    goToCartOrCheckout();
                }
            } else {
                console.log('Target Bot: Max ATC retries. Navigating to cart/checkout...');
                goToCartOrCheckout();
            }
        }, CFG.CART_CONFIRM_TIMEOUT_MS);
    }

    // =====================================================================
    //  CART CONFIRMATION
    // =====================================================================
    function watchForCartConfirmation() {
        if (state.cartObserver) state.cartObserver.disconnect();

        const checkCart = () => {
            if (!getTabRunning()) { state.cartObserver?.disconnect(); return; }

            // Dismiss warranty / protection plan modals
            const declineBtn = xpath("//button[contains(text(),'Decline coverage') or contains(text(),'No thanks') or contains(text(),'Decline')]");
            if (declineBtn && isVisible(declineBtn)) {
                console.log('Target Bot: Declining protection plan...');
                declineBtn.click();
            }

            // Check if cart drawer or redirect has occurred
            const viewCartBtn =
                xpath("//a[contains(text(),'View cart')]")  ||
                xpath("//button[contains(text(),'View cart')]") ||
                xpath("//a[contains(text(),'check out')]") ||
                $('[data-test="view-cart-checkout"]');

            const picker = $('button[data-test="custom-quantity-picker"]');
            const addedHeading = xpath("//*[contains(text(),'Added to cart') or contains(text(),'added to your cart')]");

            if (viewCartBtn || (picker && picker.innerText.toLowerCase().includes('in cart')) || addedHeading) {
                metrics.cartConfirmedAt = Date.now();
                const elapsed = metrics.atcClickedAt ? ((metrics.cartConfirmedAt - metrics.atcClickedAt) / 1000).toFixed(2) : '?';
                console.log(`Target Bot: ✅ Cart confirmed! (${elapsed}s) → Advancing to Cart/Checkout`);
                Notifier.notifyCart(extractTcin());

                clearTimeout(state.cartTimeout);
                if (state.cartObserver) { state.cartObserver.disconnect(); state.cartObserver = null; }

                goToCartOrCheckout();
                return true;
            }
            return false;
        };

        if (checkCart()) return;

        state.cartObserver = new MutationObserver(checkCart);
        state.cartObserver.observe(document.body, { childList: true, subtree: true });
    }

    // =====================================================================
    //  NAVIGATE TO CART OR CHECKOUT
    // =====================================================================
    function goToCartOrCheckout() {
        if (!getTabRunning()) return;
        metrics.checkoutStartedAt = Date.now();

        const targetQty = GM_getValue('qty', '1');
        // If target quantity > 1, routing through /cart ensures we can maximize quantity!
        if (targetQty && parseInt(targetQty, 10) > 1) {
            console.log(`Target Bot: Multi-quantity (${targetQty}) configured — routing via /cart to verify quantity...`);
            window.location.href = 'https://www.target.com/cart';
        } else {
            console.log('Target Bot: → Navigating directly to checkout...');
            window.location.href = 'https://www.target.com/checkout';
        }
    }

    function hasOrderConfirmation() {
        const confirmation = $('[data-test="orderConfirmation"], [data-test="order-confirmation"]');
        if (confirmation && isVisible(confirmation)) return true;

        const confirmationHeading = xpath(
            "//*[self::h1 or self::h2][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'thank you for your order') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'order confirmation')]"
        );
        return Boolean(confirmationHeading && isVisible(confirmationHeading));
    }

    function stopWithOrderStatus(message, statusText) {
        console.log(`Target Bot: ${message}`);
        setTabRunning(false);
        stopAllTimers();
        updateStatusUI(false, statusText);
    }

    // =====================================================================
    //  PRODUCT PAGE HANDLER — Orchestrator
    // =====================================================================
    async function handleProductPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: Analyzing product page...');

        // 1. Check if an active ATC button is ready right now!
        const immediateBtn = findATCButton();
        if (immediateBtn) {
            console.log('Target Bot: 🛒 Active Add-to-Cart button found immediately!');

            // Price check
            const maxPrice = getMaxPrice();
            const currentPrice = getCurrentPrice();
            const skipPriceCheck = GM_getValue('skipPriceCheck', true);

            if (!skipPriceCheck && maxPrice > 0 && currentPrice !== null && currentPrice > maxPrice) {
                console.log(`Target Bot: Price $${currentPrice} > max $${maxPrice}. Monitoring for price drop...`);
                const tcin = extractTcin();
                if (tcin) startDualModeMonitoring(tcin);
                return;
            }

            // Apply quantity on PDP if available
            const targetQty = GM_getValue('qty', '1');
            await QuantityManager.applyQuantityOnPdp(targetQty);

            metrics.stockDetectedAt = metrics.stockDetectedAt || Date.now();
            Notifier.notifyStock(extractTcin(), currentPrice);
            beginAddToCart(immediateBtn);
            return;
        }

        // 2. Check if item is truly Out of Stock
        if (isOutOfStock()) {
            console.log('Target Bot: ❌ Item appears Out of Stock. Starting monitoring...');
            const tcin = extractTcin();
            if (tcin) {
                startDualModeMonitoring(tcin);
            } else {
                clearTimeout(state.pollTimeout);
                state.pollTimeout = setTimeout(() => {
                    if (getTabRunning()) window.location.reload();
                }, 2000);
            }
            return;
        }

        // 3. Fallback: button not ready yet
        const tcin = extractTcin();
        if (tcin) {
            console.log('Target Bot: ATC button loading... Starting dual-mode monitoring.');
            startDualModeMonitoring(tcin);
        } else {
            clearTimeout(state.pollTimeout);
            state.pollTimeout = setTimeout(() => {
                if (getTabRunning()) window.location.reload();
            }, 2000);
        }
    }

    // =====================================================================
    //  DAY 2: POKEMON CATEGORY / SEARCH AUTO-SCANNER
    // =====================================================================
    async function handleSearchPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: 🔍 Scanning Search / Category page for in-stock Pokemon items...');

        const autoScanEnabled = GM_getValue('pokemonAutoScan', true);
        if (!autoScanEnabled) {
            console.log('Target Bot: Pokemon Auto-Scan is disabled in settings.');
            return;
        }

        const keywordsStr = GM_getValue('pokemonKeywords', '30th, ascended, pitch black, booster, elite trainer, scarlet, celebration');
        const keywords = keywordsStr.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

        const blacklistStr = GM_getValue('pokemonBlacklist', 'shirt, socks, hoodie, costume, plush, binder, book, blanket');
        const blacklist = blacklistStr.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

        const productCards = $$('[data-test="product-card"], [data-test="@web/site-top-of-funnel/ProductCardWrapper"], div[data-test="product-grid"] > div');
        console.log(`Target Bot: Found ${productCards.length} product cards on page.`);

        let matchFound = null;

        for (const card of productCards) {
            const titleEl = $('[data-test="product-title"]', card) || $('a[href*="/p/"]', card);
            const title = (titleEl?.textContent || '').toLowerCase();
            const link = $('a[href*="/p/"]', card)?.href;

            if (!title || !link) continue;

            // Check blacklist
            if (blacklist.some(b => title.includes(b))) continue;

            // Check whitelist
            const isMatch = keywords.length === 0 || keywords.some(k => title.includes(k));
            if (!isMatch) continue;

            // Check if card has active ATC button
            const cardAtc = $('button[data-test="shippingButton"]:not([disabled])', card) ||
                            $('button[id*="addToCart"]:not([disabled])', card) ||
                            xpath(".//button[not(@disabled) and contains(., 'Add to cart')]", card);

            if (cardAtc && isVisible(cardAtc) && !isDisabled(cardAtc)) {
                console.log(`Target Bot: 🎯 In-stock Pokemon match found on search page: "${title}"`);
                matchFound = { link, btn: cardAtc };
                break;
            }

            // Check if card shows in-stock status
            const cardText = (card.textContent || '').toLowerCase();
            if (!cardText.includes('out of stock') && !cardText.includes('sold out')) {
                matchFound = { link, btn: null };
                break;
            }
        }

        if (matchFound) {
            console.log(`Target Bot: 🚀 Navigating to matched product: ${matchFound.link}`);
            window.location.href = matchFound.link;
            return;
        }

        console.log('Target Bot: No available Pokemon products in current view. Re-scanning in 4 seconds...');
        clearTimeout(state.searchPollTimeout);
        state.searchPollTimeout = setTimeout(() => {
            if (getTabRunning()) {
                window.location.reload();
            }
        }, 4000);
    }

    // =====================================================================
    //  DAY 2: MULTI-URL MONITOR MODE
    // =====================================================================
    function handleMultiUrlMonitor() {
        const rawUrls = GM_getValue('multiUrls', '').trim();
        if (!rawUrls) return false;

        const urls = rawUrls.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
        if (urls.length <= 1) return false;

        // Cycle through URLs if current URL is out of stock
        console.log(`Target Bot: Multi-URL mode active with ${urls.length} URLs.`);
        return true;
    }

    // =====================================================================
    //  CHECKOUT HANDLER — Fast loop with Auto-CVV & Place Order
    // =====================================================================
    function handleCheckoutPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: Handling checkout page...');
        if (state.checkoutLoop) return;

        state.checkoutLoop = setInterval(() => {
            if (!getTabRunning()) {
                clearInterval(state.checkoutLoop); state.checkoutLoop = null;
                return;
            }

            const url = window.location.href;

            if (hasOrderConfirmation()) {
                metrics.orderPlacedAt = Date.now();
                const qtyBought = parseInt(GM_getValue('qty', '1'), 10) || 1;
                const newTotal = incrementPurchasedCount(qtyBought);
                const targetGoal = getTargetGoal();

                console.log(`Target Bot: 🎉 Order confirmed! Total units: ${newTotal}/${targetGoal}`);
                Notifier.notifyOrderConfirmed(qtyBought);

                // Day 2 Repeat Purchase Loop
                if (newTotal < targetGoal && GM_getValue('repeatPurchaseLoop', true)) {
                    console.log(`Target Bot: 🔄 Repeat Purchase Loop: ${newTotal}/${targetGoal} purchased. Returning to product/monitor in 3s...`);
                    updateStatusUI(true, `🔄 Bought ${newTotal}/${targetGoal}`);
                    setTimeout(() => {
                        const returnUrl = GM_getValue('lastProductUrl', '') || 'https://www.target.com/s?searchTerm=pokemon';
                        window.location.href = returnUrl;
                    }, 3000);
                    return;
                }

                stopWithOrderStatus(`Order confirmed successfully. Goal reached: ${newTotal}/${targetGoal}`, '✅ Order Confirmed');
                return;
            }

            if (!url.includes('/checkout') && !url.includes('/co-')) {
                Notifier.notifyError('Checkout ended without recognized order confirmation.');
                stopWithOrderStatus('Checkout ended without recognized confirmation. Check your Target account.', '⚠️ Verify Order');
                return;
            }

            // Detect cart errors / sold out
            for (const msg of $$('[data-test="boxEmptyMsg"], [data-test="error-message"], [data-test="cartEmptyMessage"]')) {
                const t = (msg.textContent || '').toLowerCase();
                if (t.includes('removed') || t.includes('empty') || t.includes('no longer available') || t.includes('sold out')) {
                    console.log('Target Bot: ⚠️ Item was removed from cart or sold out!');
                    Notifier.notifyError('Item was removed from cart or sold out during checkout!');
                    clearInterval(state.checkoutLoop); state.checkoutLoop = null;
                    window.history.back();
                    return;
                }
            }

            // 1. Login password
            const passField = $('#password');
            const loginBtn  = $('#login');
            if (passField && isVisible(passField)) {
                const pass = GM_getValue('password', '');
                if (pass && (!passField.value || passField.value !== pass)) {
                    console.log('Target Bot: Entering password...');
                    setNativeValue(passField, pass);
                }
                if (passField.value && loginBtn && !isDisabled(loginBtn)) {
                    loginBtn.click();
                    console.log('Target Bot: Clicked Login');
                    return;
                }
                if (passField.value) return;
            }

            // 2. Skip prompts
            const skipBtn = xpath("//a[normalize-space()='Skip']") || xpath("//button[normalize-space()='Skip']");
            if (skipBtn && isVisible(skipBtn)) {
                console.log('Target Bot: Clicking Skip...');
                skipBtn.click();
                return;
            }

            // 3. Save and continue
            const sncBtn = xpath("//button[contains(text(),'Save and continue')]");
            if (sncBtn && isVisible(sncBtn) && !isDisabled(sncBtn)) {
                console.log('Target Bot: Clicking Save and Continue...');
                sncBtn.click();
                return;
            }

            // 4. CVV auto-fill
            const cvvField   = $('#enter-cvv') || $('input[data-test="credit-card-cvv-input"]') || $('input[id*="cvv"]');
            const confirmBtn = $('button[data-test="confirm-button"]');
            if (cvvField && !cvvField.disabled && isVisible(cvvField)) {
                const activeCvv = getActiveAccountCvv();
                if (activeCvv && (!cvvField.value || cvvField.value !== activeCvv)) {
                    console.log('Target Bot: Entering CVV...');
                    setNativeValue(cvvField, activeCvv);
                }
                if (cvvField.value === activeCvv && confirmBtn && !isDisabled(confirmBtn)) {
                    confirmBtn.click();
                    console.log('Target Bot: Confirmed CVV');
                    return;
                }
                if (cvvField.value === activeCvv) return;
            }

            // 5. Place Order button
            const placeBtn = $('button[data-test="placeOrderButton"]');
            if (placeBtn && !isDisabled(placeBtn) && isVisible(placeBtn)) {
                if (!state.placeOrderAttempted) {
                    state.placeOrderAttempted = true;
                    state.placeOrderError = null;
                    placeBtn.click();
                    console.log('Target Bot: 🛍️ Place Order submitted once. Waiting for confirmation...');
                    updateStatusUI(true, '⏳ Awaiting Confirmation');
                    Notifier.notifyOrderPlaced();
                } else {
                    const error = $('[data-test="error-message"]');
                    const errorMessage = error && isVisible(error) ? error.textContent.trim() : '';
                    if (errorMessage && errorMessage !== state.placeOrderError) {
                        state.placeOrderError = errorMessage;
                        console.log(`Target Bot: ⚠️ Checkout error after submission: ${errorMessage}`);
                    }
                }
            }
        }, CFG.CHECKOUT_INTERVAL_MS);
    }

    // =====================================================================
    //  CART PAGE HANDLER — Quantity Adjust + Auto-Checkout
    // =====================================================================
    async function handleCartPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: On Cart page — verifying quantity and advancing to checkout...');

        const targetQty = GM_getValue('qty', '1');
        await QuantityManager.applyQuantityOnCartPage(targetQty);

        const clickCartCheckout = () => {
            if (!getTabRunning()) return true;

            const checkoutBtn =
                $('button[data-test="checkout-button"]') ||
                $('[data-test="checkout-button-primary"]') ||
                $('[data-test="order-summary-checkout-button"]') ||
                xpath("//button[contains(.,'Check out') or contains(.,'check out') or contains(.,'Sign in to check out')]");

            if (checkoutBtn && isVisible(checkoutBtn) && !isDisabled(checkoutBtn)) {
                console.log('Target Bot: 🛒 Checkout button clicked on cart page!');
                metrics.checkoutStartedAt = metrics.checkoutStartedAt || Date.now();
                checkoutBtn.click();
                return true;
            }
            return false;
        };

        if (clickCartCheckout()) return;

        const cartInterval = setInterval(() => {
            if (!getTabRunning() || clickCartCheckout()) {
                clearInterval(cartInterval);
            }
        }, 100);
    }

    // =====================================================================
    //  SESSION PRE-WARMING
    // =====================================================================
    async function preWarmSession() {
        try {
            const resp = await fetch(CFG.SESSION_CHECK_URL, {
                method: 'HEAD',
                credentials: 'include',
                cache: 'no-store',
            });
            state.sessionValid = resp.ok || resp.status === 302;
            if (state.sessionValid) {
                console.log('Target Bot: ✅ Session is valid (pre-warmed)');
            } else {
                console.log(`Target Bot: ⚠️ Session check status: ${resp.status}`);
            }
        } catch (e) {
            state.sessionValid = null;
        }
    }

    // =====================================================================
    //  ACTIVE ACCOUNT CVV RESOLVER (Multi-Account Support)
    // =====================================================================
    function getActiveAccountCvv() {
        const activeProfileIdx = parseInt(GM_getValue('activeAccountIndex', '0'), 10) || 0;
        const profilesRaw = GM_getValue('accountProfiles', '[]');
        try {
            const profiles = JSON.parse(profilesRaw);
            if (profiles[activeProfileIdx] && profiles[activeProfileIdx].cvv) {
                return profiles[activeProfileIdx].cvv;
            }
        } catch (e) {}
        return GM_getValue('cvv', '');
    }

    // =====================================================================
    //  STATE MACHINE — Routes to proper handler
    // =====================================================================
    function runBot() {
        if (!getTabRunning()) return;

        const url = window.location.href;

        if (url.includes('target.com/p/')) {
            GM_setValue('lastProductUrl', url);
            handleProductPage();
        } else if (url.includes('target.com/s?') || url.includes('target.com/c/')) {
            handleSearchPage();
        } else if (url.includes('target.com/cart') || url.includes('target.com/co-cart')) {
            handleCartPage();
        } else if (url.includes('/checkout') || url.includes('/co-')) {
            handleCheckoutPage();
        } else {
            console.log('Target Bot: Navigate to a product page, search page, or cart to begin.');
        }
    }

    // =====================================================================
    //  UI STATUS UPDATER
    // =====================================================================
    function updateStatusUI(running, customText) {
        const el = $('#bot-status');
        if (!el) return;
        el.innerText = customText || (running ? 'Running' : 'Stopped');
        el.style.color = customText && customText.startsWith('✅')
            ? '#16a34a'
            : customText && customText.startsWith('⚠️')
                ? '#d97706'
                : running ? '#16a34a' : '#b91c1c';
    }

    function updateMetricsUI() {
        const el = $('#bot-metrics');
        if (el) el.textContent = metrics.summary();
    }

    function updateGoalUI() {
        const el = $('#bot-goal-display');
        if (el) {
            el.textContent = `${getPurchasedCount()} / ${getTargetGoal()} units`;
        }
    }

    // =====================================================================
    //  UI CREATION — Modern Tabbed Dashboard (Day 1, 2 & 3 Integrated)
    // =====================================================================
    function createUI() {
        if ($('#target-bot-ui')) return;

        GM_addStyle(`
            #target-bot-ui {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 999999;
                font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
                color: #111827;
            }
            #target-bot-ui .tb-card {
                width: 380px;
                border-radius: 16px;
                background: rgba(255, 255, 255, 0.94);
                border: 1px solid rgba(17, 24, 39, 0.14);
                box-shadow: 0 20px 48px rgba(0, 0, 0, 0.22);
                overflow: hidden;
                backdrop-filter: blur(10px);
                transition: width 160ms ease;
                max-height: 92vh;
                display: flex;
                flex-direction: column;
            }
            #target-bot-ui.tb-minimized .tb-card {
                width: auto;
            }
            #target-bot-ui.tb-minimized .tb-body,
            #target-bot-ui.tb-minimized .tb-tabs {
                display: none;
            }
            #target-bot-ui.tb-large .tb-card {
                width: 480px;
            }
            #target-bot-ui .tb-header {
                padding: 12px 14px;
                background: linear-gradient(135deg, #cc0000 0%, #ff2d20 100%);
                color: #ffffff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                cursor: grab;
                user-select: none;
            }
            #target-bot-ui .tb-header:active {
                cursor: grabbing;
            }
            #target-bot-ui .tb-title-group {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #target-bot-ui .tb-title {
                font-size: 14px;
                font-weight: 800;
                letter-spacing: 0.2px;
            }
            #target-bot-ui .tb-pill {
                font-size: 10px;
                font-weight: 800;
                padding: 3px 7px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.22);
                border: 1px solid rgba(255, 255, 255, 0.3);
            }
            #target-bot-ui .tb-header-actions {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            #target-bot-ui .tb-icon-btn {
                width: 26px;
                height: 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid rgba(255, 255, 255, 0.35);
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.18);
                color: #fff;
                font-size: 14px;
                cursor: pointer;
            }
            /* Navigation Tabs */
            #target-bot-ui .tb-tabs {
                display: flex;
                background: rgba(17, 24, 39, 0.04);
                border-bottom: 1px solid rgba(17, 24, 39, 0.08);
                overflow-x: auto;
            }
            #target-bot-ui .tb-tab-btn {
                flex: 1;
                padding: 9px 6px;
                border: none;
                background: transparent;
                font-size: 11px;
                font-weight: 700;
                color: #6b7280;
                cursor: pointer;
                text-align: center;
                white-space: nowrap;
                transition: all 120ms ease;
                border-bottom: 2px solid transparent;
            }
            #target-bot-ui .tb-tab-btn.active {
                color: #cc0000;
                border-bottom-color: #cc0000;
                background: rgba(204, 0, 0, 0.04);
            }
            #target-bot-ui .tb-body {
                padding: 12px 14px 14px;
                overflow-y: auto;
                max-height: calc(92vh - 96px);
            }
            #target-bot-ui .tb-tab-content {
                display: none;
            }
            #target-bot-ui .tb-tab-content.active {
                display: block;
            }
            #target-bot-ui .tb-grid-2 {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
            }
            #target-bot-ui .tb-field {
                margin-bottom: 10px;
            }
            #target-bot-ui .tb-label {
                display: block;
                font-size: 11px;
                font-weight: 700;
                color: #374151;
                margin-bottom: 5px;
            }
            #target-bot-ui .tb-input {
                width: 100%;
                box-sizing: border-box;
                padding: 9px 10px;
                border-radius: 9px;
                border: 1px solid rgba(17, 24, 39, 0.16);
                background: #ffffff;
                outline: none;
                font-size: 12px;
                transition: border-color 140ms ease;
            }
            #target-bot-ui .tb-input:focus {
                border-color: #cc0000;
            }
            #target-bot-ui textarea.tb-input {
                resize: vertical;
                min-height: 60px;
                font-family: ui-monospace, monospace;
                font-size: 11px;
            }
            #target-bot-ui .tb-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
                padding: 7px 10px;
                border-radius: 9px;
                background: rgba(17, 24, 39, 0.03);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-toggle-label {
                font-size: 11px;
                font-weight: 700;
                color: #374151;
            }
            #target-bot-ui .tb-switch {
                position: relative;
                width: 38px;
                height: 20px;
                background: #d1d5db;
                border-radius: 10px;
                cursor: pointer;
                transition: background 200ms;
                flex-shrink: 0;
            }
            #target-bot-ui .tb-switch.active {
                background: #16a34a;
            }
            #target-bot-ui .tb-switch::after {
                content: '';
                position: absolute;
                top: 2px;
                left: 2px;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #fff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                transition: transform 200ms;
            }
            #target-bot-ui .tb-switch.active::after {
                transform: translateX(18px);
            }
            #target-bot-ui .tb-status-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin: 10px 0 8px;
                padding: 8px 10px;
                border-radius: 10px;
                background: rgba(17, 24, 39, 0.04);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-status-value {
                font-size: 11px;
                font-weight: 800;
                padding: 3px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.9);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-metrics {
                font-size: 10px;
                font-family: ui-monospace, monospace;
                color: #6b7280;
                padding: 5px 8px;
                margin-bottom: 8px;
                border-radius: 8px;
                background: rgba(17, 24, 39, 0.03);
                border: 1px solid rgba(17, 24, 39, 0.06);
                white-space: nowrap;
                overflow-x: auto;
            }
            #target-bot-ui .tb-log {
                width: 100%;
                height: 110px;
                border-radius: 10px;
                background: #111827;
                color: #e5e7eb;
                font-family: ui-monospace, monospace;
                font-size: 10px;
                line-height: 1.4;
                overflow-y: auto;
                padding: 8px;
                box-sizing: border-box;
                white-space: pre-wrap;
            }
            #target-bot-ui .tb-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin-top: 10px;
            }
            #target-bot-ui .tb-btn {
                border: none;
                border-radius: 10px;
                padding: 9px 12px;
                font-size: 12px;
                font-weight: 800;
                cursor: pointer;
            }
            #target-bot-ui .tb-btn-primary {
                background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%);
                color: #ffffff;
            }
            #target-bot-ui .tb-btn-danger {
                background: linear-gradient(135deg, #b91c1c 0%, #ef4444 100%);
                color: #ffffff;
            }
            #target-bot-ui .tb-btn-secondary {
                background: #f3f4f6;
                color: #374151;
                border: 1px solid rgba(17, 24, 39, 0.15);
            }
            #target-bot-ui .tb-account-badge {
                display: inline-block;
                padding: 3px 6px;
                border-radius: 6px;
                background: #e0f2fe;
                color: #0369a1;
                font-size: 10px;
                font-weight: 700;
                margin-right: 4px;
            }
        `);

        const ui = document.createElement('div');
        ui.id = 'target-bot-ui';
        const isLarge = GM_getValue('uiSize', 'compact') === 'large';
        const isMinimized = GM_getValue('uiMinimized', false);
        ui.classList.toggle('tb-large', isLarge);
        ui.classList.toggle('tb-minimized', isMinimized);

        ui.innerHTML = `
            <div class="tb-card">
                <div class="tb-header">
                    <div class="tb-title-group">
                        <div class="tb-title">Target Auto Buyer</div>
                        <div class="tb-pill">v4.0 ⚡</div>
                    </div>
                    <div class="tb-header-actions">
                        <button id="bot-size-toggle" class="tb-icon-btn" type="button" title="Panel Size">${isLarge ? '⊟' : '⊞'}</button>
                        <button id="bot-minimize-toggle" class="tb-icon-btn" type="button" title="Minimize">${isMinimized ? '□' : '−'}</button>
                    </div>
                </div>

                <div class="tb-tabs">
                    <button class="tb-tab-btn active" data-tab="tab-drop">⚡ Drop</button>
                    <button class="tb-tab-btn" data-tab="tab-pokemon">🔍 Pokemon</button>
                    <button class="tb-tab-btn" data-tab="tab-accounts">👥 Accounts</button>
                    <button class="tb-tab-btn" data-tab="tab-alerts">🔔 Alerts</button>
                    <button class="tb-tab-btn" data-tab="tab-logs">📋 Logs</button>
                </div>

                <div id="bot-panel-body" class="tb-body">
                    <!-- TAB 1: DROP & CHECKOUT -->
                    <div id="tab-drop" class="tb-tab-content active">
                        <div class="tb-grid-2">
                            <div class="tb-field">
                                <label class="tb-label" for="bot-qty">Quantity</label>
                                <input class="tb-input" type="number" id="bot-qty" min="1" max="100" value="${GM_getValue('qty', '1')}" />
                            </div>
                            <div class="tb-field">
                                <label class="tb-label" for="bot-max-price">Max Price ($0=any)</label>
                                <input class="tb-input" type="number" id="bot-max-price" min="0" step="0.01" value="${GM_getValue('maxPrice', '0')}" />
                            </div>
                        </div>

                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">Skip Price Check for Marketplace</span>
                            <div id="bot-skip-price" class="tb-switch ${GM_getValue('skipPriceCheck', true) ? 'active' : ''}"></div>
                        </div>

                        <div class="tb-grid-2">
                            <div class="tb-field">
                                <label class="tb-label" for="bot-cvv">Default CVV</label>
                                <input class="tb-input" type="text" id="bot-cvv" maxlength="4" value="${GM_getValue('cvv', '')}" />
                            </div>
                            <div class="tb-field">
                                <label class="tb-label" for="bot-drop-time">Drop Time</label>
                                <input class="tb-input" type="datetime-local" id="bot-drop-time" value="${GM_getValue('dropTime', '')}" />
                            </div>
                        </div>

                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">⚡ Drop Mode (250ms polls)</span>
                            <div id="bot-drop-mode" class="tb-switch ${GM_getValue('dropMode', false) ? 'active' : ''}"></div>
                        </div>

                        <div class="tb-status-row">
                            <span class="tb-label" style="margin: 0;">Goal Progress</span>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <span id="bot-goal-display" class="tb-status-value">${getPurchasedCount()} / ${getTargetGoal()} units</span>
                                <button type="button" id="bot-reset-goal" class="tb-btn tb-btn-secondary" style="padding: 2px 6px; font-size: 10px;" title="Reset goal progress counter to 0">Reset</button>
                            </div>
                        </div>
                    </div>

                    <!-- TAB 2: POKEMON & AUTO-MONITOR -->
                    <div id="tab-pokemon" class="tb-tab-content">
                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">🔍 Auto-Scan Pokemon Categories</span>
                            <div id="bot-pokemon-autoscan" class="tb-switch ${GM_getValue('pokemonAutoScan', true) ? 'active' : ''}"></div>
                        </div>

                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">🔄 Repeat Purchase Loop (Auto-Rebuy)</span>
                            <div id="bot-repeat-loop" class="tb-switch ${GM_getValue('repeatPurchaseLoop', true) ? 'active' : ''}"></div>
                        </div>

                        <div class="tb-field">
                            <label class="tb-label" for="bot-target-goal">Total Purchase Goal (units)</label>
                            <input class="tb-input" type="number" id="bot-target-goal" min="1" max="10000" value="${GM_getValue('targetGoal', '1000')}" />
                        </div>

                        <div class="tb-field">
                            <label class="tb-label" for="bot-pokemon-keywords">Whitelist Keywords (comma separated)</label>
                            <input class="tb-input" type="text" id="bot-pokemon-keywords" value="${GM_getValue('pokemonKeywords', '30th, ascended, pitch black, booster, elite trainer, scarlet, celebration')}" />
                        </div>

                        <div class="tb-field">
                            <label class="tb-label" for="bot-pokemon-blacklist">Blacklist Keywords (skip plush, clothes, etc.)</label>
                            <input class="tb-input" type="text" id="bot-pokemon-blacklist" value="${GM_getValue('pokemonBlacklist', 'shirt, socks, hoodie, costume, plush, binder, book, blanket')}" />
                        </div>

                        <div class="tb-field">
                            <label class="tb-label" for="bot-multi-urls">Multi-URL Monitor (1 Target product URL per line)</label>
                            <textarea class="tb-input" id="bot-multi-urls" placeholder="https://www.target.com/p/...">${GM_getValue('multiUrls', '')}</textarea>
                        </div>
                    </div>

                    <!-- TAB 3: MULTI-ACCOUNT & PROXY -->
                    <div id="tab-accounts" class="tb-tab-content">
                        <div class="tb-field">
                            <label class="tb-label">Multi-Tab Status</label>
                            <div style="font-size: 11px; color: #4b5563; background: #f3f4f6; padding: 8px; border-radius: 8px;">
                                Current Tab: <span class="tb-account-badge">${tabId}</span>
                                <div>Tabs coordinate live via BroadcastChannel.</div>
                            </div>
                        </div>

                        <div class="tb-section-label" style="font-size: 11px; font-weight: 800; color: #374151; margin-bottom: 6px;">Add New Account</div>
                        <div class="tb-grid-2" style="margin-bottom: 6px;">
                            <input class="tb-input" type="text" id="bot-new-acc-name" placeholder="Account Name / Email" />
                            <input class="tb-input" type="text" id="bot-new-acc-cvv" maxlength="4" placeholder="CVV" />
                        </div>
                        <button type="button" id="bot-add-acc-btn" class="tb-btn tb-btn-secondary" style="width: 100%; margin-bottom: 10px; padding: 6px;">+ Add Account</button>

                        <div class="tb-field">
                            <label class="tb-label">Configured Accounts</label>
                            <div id="bot-accounts-list" style="max-height: 100px; overflow-y: auto; background: #fff; border: 1px solid rgba(17,24,39,0.12); border-radius: 8px; padding: 6px;"></div>
                        </div>

                        <div class="tb-field">
                            <label class="tb-label">🌐 Proxy Setup Guide</label>
                            <div style="font-size: 10px; color: #4b5563; line-height: 1.4; background: #f8fafc; padding: 8px; border-radius: 8px; border: 1px solid #e2e8f0;">
                                For running multiple Target accounts, use <b>US Residential Proxies</b> (e.g. Smartproxy, Bright Data). Bind each browser profile to a distinct proxy IP using <i>Proxy SwitchyOmega</i> or antidetect browsers.
                            </div>
                        </div>
                    </div>

                    <!-- TAB 4: ALERTS & WEBHOOKS -->
                    <div id="tab-alerts" class="tb-tab-content">
                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">🔊 Audio Alerts</span>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <button type="button" id="bot-test-sound" class="tb-btn tb-btn-secondary" style="padding: 3px 8px; font-size: 10px;">Test</button>
                                <div id="bot-sound-mode" class="tb-switch ${GM_getValue('soundEnabled', true) ? 'active' : ''}"></div>
                            </div>
                        </div>

                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">💬 Discord Webhook</span>
                            <div id="bot-discord-mode" class="tb-switch ${GM_getValue('discordEnabled', false) ? 'active' : ''}"></div>
                        </div>
                        <div id="bot-discord-fields" style="${GM_getValue('discordEnabled', false) ? '' : 'display:none;'} margin-bottom: 8px;">
                            <input class="tb-input" type="text" id="bot-discord-webhook" placeholder="https://discord.com/api/webhooks/..." value="${GM_getValue('discordWebhook', '')}" />
                            <button type="button" id="bot-test-discord" class="tb-btn tb-btn-secondary" style="width: 100%; margin-top: 4px; padding: 4px;">Test Discord</button>
                        </div>

                        <div class="tb-toggle-row">
                            <span class="tb-toggle-label">✈️ Telegram Bot</span>
                            <div id="bot-telegram-mode" class="tb-switch ${GM_getValue('telegramEnabled', false) ? 'active' : ''}"></div>
                        </div>
                        <div id="bot-telegram-fields" style="${GM_getValue('telegramEnabled', false) ? '' : 'display:none;'} margin-bottom: 8px;">
                            <input class="tb-input" style="margin-bottom: 4px;" type="text" id="bot-telegram-token" placeholder="Bot Token" value="${GM_getValue('telegramToken', '')}" />
                            <input class="tb-input" type="text" id="bot-telegram-chat-id" placeholder="Chat ID" value="${GM_getValue('telegramChatId', '')}" />
                            <button type="button" id="bot-test-telegram" class="tb-btn tb-btn-secondary" style="width: 100%; margin-top: 4px; padding: 4px;">Test Telegram</button>
                        </div>
                    </div>

                    <!-- TAB 5: LOGS & METRICS -->
                    <div id="tab-logs" class="tb-tab-content">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
                            <span class="tb-label" style="margin:0;">Latency & Stages</span>
                            <button type="button" id="bot-clear-logs" class="tb-btn tb-btn-secondary" style="padding: 2px 6px; font-size: 10px;">Clear Logs</button>
                        </div>
                        <div id="bot-metrics" class="tb-metrics">Waiting...</div>
                        <div id="bot-log-area" class="tb-log"></div>
                    </div>

                    <!-- FOOTER ACTIONS & STATUS -->
                    <div class="tb-status-row">
                        <span class="tb-label" style="margin: 0;">Status</span>
                        <span id="bot-status" class="tb-status-value" style="color: ${getTabRunning() ? '#16a34a' : '#b91c1c'};">${getTabRunning() ? 'Running' : 'Stopped'}</span>
                    </div>

                    <div class="tb-actions">
                        <button id="bot-start" class="tb-btn tb-btn-primary">▶ Start Bot</button>
                        <button id="bot-stop"  class="tb-btn tb-btn-danger">■ Stop Bot</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(ui);

        // Tab Switching Logic
        $$('.tb-tab-btn', ui).forEach(btn => {
            btn.addEventListener('click', () => {
                $$('.tb-tab-btn', ui).forEach(b => b.classList.remove('active'));
                $$('.tb-tab-content', ui).forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                const targetId = btn.getAttribute('data-tab');
                $(`#${targetId}`, ui)?.classList.add('active');
            });
        });

        // Window dragging & sizing
        const keepUIInViewport = () => {
            const rect = ui.getBoundingClientRect();
            const left = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - ui.offsetWidth));
            const top = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - ui.offsetHeight));
            ui.style.left = `${left}px`;
            ui.style.top = `${top}px`;
            ui.style.right = 'auto';
            ui.style.bottom = 'auto';
            return { left, top };
        };

        const savedPosition = GM_getValue('uiPosition', null);
        if (savedPosition && Number.isFinite(savedPosition.left) && Number.isFinite(savedPosition.top)) {
            ui.style.left = `${Math.min(Math.max(0, savedPosition.left), window.innerWidth - ui.offsetWidth)}px`;
            ui.style.top = `${Math.min(Math.max(0, savedPosition.top), window.innerHeight - ui.offsetHeight)}px`;
            ui.style.right = 'auto';
            ui.style.bottom = 'auto';
        }

        const header = ui.querySelector('.tb-header');
        let dragState = null;
        header.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const rect = ui.getBoundingClientRect();
            dragState = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
            };
            header.setPointerCapture(event.pointerId);
        });
        header.addEventListener('pointermove', event => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            const left = Math.min(Math.max(0, event.clientX - dragState.offsetX), Math.max(0, window.innerWidth - ui.offsetWidth));
            const top = Math.min(Math.max(0, event.clientY - dragState.offsetY), Math.max(0, window.innerHeight - ui.offsetHeight));
            ui.style.left = `${left}px`;
            ui.style.top = `${top}px`;
            ui.style.right = 'auto';
            ui.style.bottom = 'auto';
        });
        const stopDragging = event => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            dragState = null;
            const rect = ui.getBoundingClientRect();
            GM_setValue('uiPosition', { left: rect.left, top: rect.top });
        };
        header.addEventListener('pointerup', stopDragging);
        header.addEventListener('pointercancel', stopDragging);

        $('#bot-size-toggle').addEventListener('click', () => {
            const large = !ui.classList.contains('tb-large');
            ui.classList.toggle('tb-large', large);
            GM_setValue('uiSize', large ? 'large' : 'compact');
            $('#bot-size-toggle').textContent = large ? '⊟' : '⊞';
            GM_setValue('uiPosition', keepUIInViewport());
        });

        $('#bot-minimize-toggle').addEventListener('click', () => {
            const minimized = !ui.classList.contains('tb-minimized');
            ui.classList.toggle('tb-minimized', minimized);
            GM_setValue('uiMinimized', minimized);
            $('#bot-minimize-toggle').textContent = minimized ? '□' : '−';
            GM_setValue('uiPosition', keepUIInViewport());
        });

        // Save inputs
        const save = () => {
            GM_setValue('qty',                 $('#bot-qty')?.value || '1');
            GM_setValue('maxPrice',            $('#bot-max-price')?.value || '0');
            GM_setValue('cvv',                 $('#bot-cvv')?.value || '');
            GM_setValue('dropTime',            $('#bot-drop-time')?.value || '');
            GM_setValue('targetGoal',          $('#bot-target-goal')?.value || '1000');
            GM_setValue('pokemonKeywords',     $('#bot-pokemon-keywords')?.value || '');
            GM_setValue('pokemonBlacklist',    $('#bot-pokemon-blacklist')?.value || '');
            GM_setValue('multiUrls',           $('#bot-multi-urls')?.value || '');
            GM_setValue('accountProfiles',     $('#bot-account-profiles')?.value || '[]');
            GM_setValue('activeAccountIndex',  $('#bot-active-account')?.value || '0');
            GM_setValue('discordWebhook',      $('#bot-discord-webhook')?.value?.trim() || '');
            GM_setValue('telegramToken',       $('#bot-telegram-token')?.value?.trim() || '');
            GM_setValue('telegramChatId',      $('#bot-telegram-chat-id')?.value?.trim() || '');
            updateGoalUI();
        };

        [
            'bot-qty', 'bot-max-price', 'bot-cvv', 'bot-drop-time', 'bot-target-goal',
            'bot-pokemon-keywords', 'bot-pokemon-blacklist', 'bot-multi-urls',
            'bot-account-profiles', 'bot-active-account',
            'bot-discord-webhook', 'bot-telegram-token', 'bot-telegram-chat-id'
        ].forEach(id => {
            const el = $(`#${id}`);
            if (el) el.addEventListener('change', save);
        });

        // Toggles
        const setupToggle = (id, key, callback) => {
            const el = $(`#${id}`);
            if (!el) return;
            el.addEventListener('click', () => {
                const active = !el.classList.contains('active');
                el.classList.toggle('active', active);
                GM_setValue(key, active);
                if (callback) callback(active);
            });
        };

        setupToggle('bot-skip-price', 'skipPriceCheck');
        setupToggle('bot-drop-mode', 'dropMode');
        setupToggle('bot-pokemon-autoscan', 'pokemonAutoScan');
        setupToggle('bot-repeat-loop', 'repeatPurchaseLoop');
        setupToggle('bot-sound-mode', 'soundEnabled');
        setupToggle('bot-discord-mode', 'discordEnabled', active => {
            const f = $('#bot-discord-fields');
            if (f) f.style.display = active ? 'block' : 'none';
        });
        setupToggle('bot-telegram-mode', 'telegramEnabled', active => {
            const f = $('#bot-telegram-fields');
            if (f) f.style.display = active ? 'block' : 'none';
        });

        // Test buttons
        $('#bot-test-sound')?.addEventListener('click', () => {
            Sound.getContext();
            Sound.orderConfirmedAlert();
        });

        $('#bot-test-discord')?.addEventListener('click', async () => {
            save();
            try {
                await sendDiscordNotification('test', {
                    title: '🧪 DISCORD TEST SUCCESSFUL',
                    message: 'Target Auto Buyer v4.0 is connected to your Discord channel!',
                    productName: 'Pokemon 30th Anniversary Celebration Box',
                    price: '$389.99',
                    qty: '1',
                    goal: `${getPurchasedCount()}/${getTargetGoal()} units`,
                });
            } catch (e) {}
        });

        $('#bot-test-telegram')?.addEventListener('click', async () => {
            save();
            try {
                await sendTelegramNotification('test', {
                    message: 'Target Auto Buyer v4.0 is connected to your Telegram chat!',
                    productName: 'Pokemon 30th Anniversary Celebration Box',
                    price: '$389.99',
                    qty: '1',
                    goal: `${getPurchasedCount()}/${getTargetGoal()} units`,
                });
            } catch (e) {}
        });

        // Start / Stop
        $('#bot-start')?.addEventListener('click', () => {
            Sound.getContext();
            save();
            setTabRunning(true);
            updateStatusUI(true);
            metrics.reset();
            state.placeOrderAttempted = false;
            sendBroadcast('GLOBAL_START');
            preWarmSession().then(() => runBot());
        });

        $('#bot-stop')?.addEventListener('click', () => {
            setTabRunning(false);
            updateStatusUI(false);
            stopAllTimers();
            sendBroadcast('GLOBAL_STOP');
        });

        // Reset Goal counter
        $('#bot-reset-goal')?.addEventListener('click', () => {
            GM_setValue('purchasedCount', '0');
            updateGoalUI();
            console.log('Target Bot: Goal counter reset to 0.');
        });

        // Clear Logs
        $('#bot-clear-logs')?.addEventListener('click', () => {
            const logArea = $('#bot-log-area');
            if (logArea) logArea.textContent = '';
        });

        // Visual Account Manager
        const renderAccounts = () => {
            const listEl = $('#bot-accounts-list');
            if (!listEl) return;
            const profilesRaw = GM_getValue('accountProfiles', '[{"name":"Account 1","cvv":""}]');
            let profiles = [];
            try { profiles = JSON.parse(profilesRaw); } catch (e) { profiles = []; }

            const activeIdx = parseInt(GM_getValue('activeAccountIndex', '0'), 10) || 0;
            listEl.innerHTML = '';

            if (profiles.length === 0) {
                listEl.innerHTML = '<div style="font-size:10px; color:#9ca3af; text-align:center;">No accounts added yet.</div>';
                return;
            }

            profiles.forEach((acc, idx) => {
                const item = document.createElement('div');
                item.style.cssText = `display:flex; justify-content:space-between; align-items:center; padding:4px 6px; font-size:11px; border-bottom:1px solid #f3f4f6; ${idx === activeIdx ? 'background:#eff6ff; border-radius:4px;' : ''}`;
                item.innerHTML = `
                    <div style="display:flex; align-items:center; gap:6px; overflow:hidden;">
                        <input type="radio" name="active-acc" ${idx === activeIdx ? 'checked' : ''} style="cursor:pointer;" />
                        <span style="font-weight:${idx === activeIdx ? '800' : '500'}; color:${idx === activeIdx ? '#1d4ed8' : '#374151'}; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
                            ${escapeHtml(acc.name || 'Account ' + (idx + 1))} (CVV: ${acc.cvv ? '***' : 'none'})
                        </span>
                    </div>
                    <button type="button" class="tb-del-acc" data-idx="${idx}" style="border:none; background:transparent; color:#ef4444; font-weight:bold; cursor:pointer; font-size:12px;" title="Delete">✕</button>
                `;

                // Select account
                item.querySelector('input[type="radio"]')?.addEventListener('change', () => {
                    GM_setValue('activeAccountIndex', String(idx));
                    console.log(`Target Bot: Active account switched to: ${acc.name}`);
                    renderAccounts();
                });

                // Delete account
                item.querySelector('.tb-del-acc')?.addEventListener('click', () => {
                    profiles.splice(idx, 1);
                    GM_setValue('accountProfiles', JSON.stringify(profiles));
                    if (activeIdx >= profiles.length) {
                        GM_setValue('activeAccountIndex', String(Math.max(0, profiles.length - 1)));
                    }
                    renderAccounts();
                });

                listEl.appendChild(item);
            });
        };

        // Add Account Button
        $('#bot-add-acc-btn')?.addEventListener('click', () => {
            const name = $('#bot-new-acc-name')?.value.trim();
            const cvv = $('#bot-new-acc-cvv')?.value.trim();
            if (!name) {
                console.log('Target Bot: Enter an account name or email.');
                return;
            }
            const profilesRaw = GM_getValue('accountProfiles', '[]');
            let profiles = [];
            try { profiles = JSON.parse(profilesRaw); } catch (e) { profiles = []; }

            profiles.push({ name, cvv });
            GM_setValue('accountProfiles', JSON.stringify(profiles));
            $('#bot-new-acc-name').value = '';
            $('#bot-new-acc-cvv').value = '';
            renderAccounts();
            console.log(`Target Bot: Added account "${name}".`);
        });

        renderAccounts();

        setInterval(updateMetricsUI, 500);
        updateStatusUI(getTabRunning());
        updateGoalUI();
    }

    // =====================================================================
    //  STARTUP — Smart page-ready detection
    // =====================================================================
    function waitForPageReady(callback) {
        const t0 = Date.now();

        function check() {
            const hasProduct =
                $('[data-test="product-price"]') ||
                $('button[data-test="shippingButton"]') ||
                $('button[id^="addToCartButtonOrTextIdFor"]') ||
                $('[data-test="outOfStockButton"]') ||
                $('[data-test="product-card"]');

            const isSearch   = window.location.href.includes('target.com/s?') || window.location.href.includes('target.com/c/');
            const isCart     = window.location.href.includes('target.com/cart') || window.location.href.includes('target.com/co-cart');
            const isCheckout = window.location.href.includes('/checkout') || window.location.href.includes('/co-');
            const timedOut   = Date.now() - t0 > CFG.STARTUP_MAX_WAIT_MS;

            if (hasProduct || isSearch || isCart || isCheckout || timedOut) {
                callback();
            } else {
                setTimeout(check, CFG.STARTUP_POLL_MS);
            }
        }

        check();
    }

    // =====================================================================
    //  INITIALIZATION
    // =====================================================================
    function init() {
        waitForPageReady(() => {
            createUI();
            if (getTabRunning()) {
                console.log('Target Bot: Resuming from active session...');
                runBot();
            }
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }

})();
