// ==UserScript==
// @name         Target Auto Buyer
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  Auto buy from target.com — optimized for high-demand drops with Discord, Telegram, and Audio alerts
// @author       Pythonic Shariful
// @match        https://www.target.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @connect      discordapp.com
// @connect      api.telegram.org
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
        // Startup
        STARTUP_POLL_MS:        100,     // How often to check if page is ready
        STARTUP_MAX_WAIT_MS:   5000,     // Max wait for page ready before proceeding anyway

        // Session pre-warming
        SESSION_CHECK_URL: 'https://www.target.com/co-cart',
    };

    // =====================================================================
    //  PERFORMANCE METRICS — Track timing for diagnostics
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
        placeOrderError:      null,
        domObserver:          null,      // Phase 4: dual-mode DOM observer
        sessionValid:         null,      // Phase 4: pre-warm result
        dropTimerInterval:    null,      // Phase 4: drop timer countdown
    };

    function stopAllTimers() {
        clearTimeout(state.pollTimeout);
        clearTimeout(state.cartTimeout);
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
    //  DOM HELPERS
    // =====================================================================
    function $(sel)      { return document.querySelector(sel); }
    function $$(sel)     { return document.querySelectorAll(sel); }
    function xpath(path) {
        return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }

    function isVisible(el)  {
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
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // =====================================================================
    //  TCIN EXTRACTION
    // =====================================================================
    function extractTcin() {
        const m = window.location.href.match(/A-(\d+)/);
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
                text: 'Target Auto Buyer ⚡ v3.2 • High-Demand Drop Assist',
                icon_url: 'https://assets.targetimg1.com/web/static-resources/favicons/favicon.ico'
            },
            timestamp: new Date().toISOString(),
        };

        const payload = JSON.stringify({
            username: 'Target Auto Buyer',
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
            throw err;
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
        text += `⏰ <i>${now} • Target Auto Buyer ⚡ v3.2</i>`;

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
            throw err;
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
                    message: `Item added to cart in **${elapsed}**! Redirecting to checkout...`,
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

        async notifyOrderConfirmed() {
            const now = Date.now();
            if (now - this.lastOrderNoticeTime < 30000) return;
            this.lastOrderNoticeTime = now;

            const title = getProductTitle();
            const url = window.location.href;
            const tcin = extractTcin();
            const timingSummary = metrics.summary();

            Sound.orderConfirmedAlert();

            if (GM_getValue('discordEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendDiscordNotification('order', {
                    title: '🎉 TARGET ORDER CONFIRMED!',
                    message: `Target order placed and confirmed successfully! Verify your confirmation email.`,
                    productName: title,
                    tcin: tcin,
                    url: url,
                    metrics: timingSummary,
                    customFields: [
                        { name: '✅ Status', value: 'Order Accepted & Confirmed', inline: true }
                    ]
                }).catch(() => {});
            }

            if (GM_getValue('telegramEnabled', false) && GM_getValue('notifyOrder', true)) {
                sendTelegramNotification('order', {
                    message: 'Order confirmed by Target! Check your email and Target order history.',
                    productName: title,
                    tcin: tcin,
                    url: url,
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
    //  POLL INTERVAL — respects drop-mode and adaptive timing (P4.3)
    // =====================================================================
    function getPollInterval() {
        // Drop-mode override
        if (GM_getValue('dropMode', false)) return CFG.DROP_MODE_POLL_MS;

        // Adaptive: auto-switch to aggressive near drop time (P4.3)
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
    //  OUT-OF-STOCK DETECTION  (P3.4 — optimized, no body.innerText scan)
    // =====================================================================
    function isOutOfStock() {
        // 1. Targeted selectors (fast)
        const fastSelectors = [
            '[data-test="outOfStockButton"]',
            '[data-test="soldOutButton"]',
            'button[disabled][data-test="shippingButton"]',
        ];
        for (const sel of fastSelectors) {
            if ($(sel)) return true;
        }

        // 2. Bold text spans (Target's common OOS pattern)
        for (const el of $$('span.h-text-bold')) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t.includes('out of stock') || t.includes('sold out')) return true;
        }

        // 3. Aria labels
        for (const el of $$('button[aria-label], div[aria-label]')) {
            const label = (el.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('out of stock') || label.includes('sold out')) return true;
        }

        // 4. Fallback: visible XPath match (still avoids body.innerText)
        const oosEl = xpath("//*[contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'out of stock')]");
        if (oosEl && isVisible(oosEl)) return true;

        return false;
    }

    // =====================================================================
    //  PRICE HELPERS
    // =====================================================================
    function getCurrentPrice() {
        const el = $('[data-test="product-price"]') || $('span.styles_currentPriceFontSize__Xps20');
        if (!el) return null;
        const v = parseFloat((el.textContent || '').replace(/[^0-9.]/g, ''));
        return Number.isFinite(v) ? v : null;
    }
    function getMaxPrice() {
        const v = parseFloat((GM_getValue('maxPrice', '0') || '0').toString().trim());
        return Number.isFinite(v) ? v : 0;
    }

    // =====================================================================
    //  FIND ADD-TO-CART BUTTON — comprehensive selector list from live DOM
    // =====================================================================
    function findATCButton() {
        // Target may render an ATC-shaped control before its fulfillment state updates.
        if (isOutOfStock()) return null;

        // Primary: data-test shipping button
        let btn = $('button[data-test="shippingButton"]');
        if (btn && isVisible(btn) && !isDisabled(btn)) return btn;

        // By ID pattern: addToCartButtonOrTextIdFor<TCIN>
        const tcin = extractTcin();
        if (tcin) {
            btn = $(`#addToCartButtonOrTextIdFor${tcin}`);
            if (btn && isVisible(btn) && !isDisabled(btn)) return btn;
        }

        // Generic ID prefix
        btn = $('button[id^="addToCartButtonOrTextIdFor"]');
        if (btn && isVisible(btn) && !isDisabled(btn)) return btn;

        // XPath fallbacks
        btn = xpath("//button[contains(text(),'Add to cart')]");
        if (btn && isVisible(btn) && !isDisabled(btn)) return btn;

        btn = xpath("//button[text()='Preorder']") || xpath("//button[text()='Preorder now']");
        if (btn && isVisible(btn) && !isDisabled(btn)) return btn;

        return null;
    }

    // =====================================================================
    //  API STOCK CHECK WITH RETRY + BACKOFF  (P3.1)
    // =====================================================================
    async function checkStockApi(tcin) {
        const apiKey = '9f36aeafbe60771e321a7cc95a78140772ab3e96';
        const url = `https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?tcin=${tcin}&key=${apiKey}`;

        for (let attempt = 1; attempt <= CFG.API_MAX_RETRIES; attempt++) {
            try {
                const resp = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    cache: 'no-store',                         // Bypass browser cache
                });

                if (resp.ok) {
                    const data = await resp.json();
                    const status = data?.data?.product?.fulfillment?.shipping_options?.availability_status;
                    return status === 'IN_STOCK';
                }

                // Server error — retry with backoff
                if (resp.status >= 500 && attempt < CFG.API_MAX_RETRIES) {
                    console.log(`Target Bot: API ${resp.status} — retry ${attempt}/${CFG.API_MAX_RETRIES}`);
                    await sleep(CFG.API_RETRY_BASE_MS * attempt);
                    continue;
                }
                // 4xx — don't retry
                return false;
            } catch (e) {
                if (attempt < CFG.API_MAX_RETRIES) {
                    console.log(`Target Bot: API error (attempt ${attempt}): ${e.message}`);
                    await sleep(CFG.API_RETRY_BASE_MS * attempt);
                } else {
                    console.log(`Target Bot: API failed after ${CFG.API_MAX_RETRIES} tries: ${e.message}`);
                }
            }
        }
        return false;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // =====================================================================
    //  STOCK POLLING — Aggressive, no page-reload  (P1.1, P1.2)
    // =====================================================================
    async function pollStock(tcin) {
        if (!getTabRunning()) return;
        metrics.pollCount++;
        const pollNumber = metrics.pollCount;
        console.log(`Target Bot: Checking stock for TCIN ${tcin} (check #${pollNumber})...`);

        const inStock = await checkStockApi(tcin);

        if (inStock) {
            metrics.stockDetectedAt = Date.now();
            console.log(`Target Bot: ✅ IN STOCK detected via API! (check #${pollNumber})`);
            Notifier.notifyStock(tcin, getCurrentPrice());

            // Phase 1.2: Try to click ATC directly WITHOUT page reload
            const btn = findATCButton();
            if (btn) {
                console.log('Target Bot: ATC button available on current page — clicking directly.');
                beginAddToCart(btn);
                return;
            }

            // Button not ready (page still shows OOS) — fast reload (no extra delay)
            console.log('Target Bot: ATC button not ready. Fast-reloading page...');
            window.location.reload();
            return;
        }

        console.log(`Target Bot: No in-stock result yet (check #${pollNumber}).`);

        // Schedule next poll
        const interval = getPollInterval();
        clearTimeout(state.pollTimeout);
        state.pollTimeout = setTimeout(() => pollStock(tcin), interval);
    }

    // =====================================================================
    //  PHASE 4.1 — DUAL-MODE MONITORING  (API polling + DOM observation)
    // =====================================================================
    function startDualModeMonitoring(tcin) {
        // A) Start API polling
        pollStock(tcin);

        // B) Also watch DOM for button becoming enabled (catches React state updates)
        if (state.domObserver) state.domObserver.disconnect();

        state.domObserver = new MutationObserver(() => {
            if (!getTabRunning()) { state.domObserver?.disconnect(); return; }
            const btn = findATCButton();
            if (btn) {
                console.log('Target Bot: ✅ ATC button appeared in DOM! Clicking immediately.');
                metrics.stockDetectedAt = metrics.stockDetectedAt || Date.now();
                Notifier.notifyStock(tcin, getCurrentPrice());
                clearTimeout(state.pollTimeout); // Stop API polling
                state.domObserver.disconnect();
                state.domObserver = null;
                beginAddToCart(btn);
            }
        });

        // Observe the product info area (scoped for performance)
        const target = $('[data-test="product-detail-highlights"]')?.parentElement || document.body;
        state.domObserver.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    }

    // =====================================================================
    //  ADD TO CART — with retry logic + MutationObserver  (P2.1, P3.2)
    // =====================================================================
    function beginAddToCart(button) {
        if (!getTabRunning()) return;
        state.atcRetries = 0;
        metrics.atcClickedAt = Date.now();
        clickATC(button);
    }

    function clickATC(button) {
        if (!getTabRunning()) return;
        state.atcRetries++;
        console.log(`Target Bot: 🛒 ATC click #${state.atcRetries}/${CFG.ATC_MAX_RETRIES}`);
        button.click();

        // Start MutationObserver for cart confirmation (P2.1)
        watchForCartConfirmation();

        // Timeout: retry or fallback (P3.2)
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
                    // Button vanished — item may be in cart already
                    console.log('Target Bot: ATC button gone. Navigating to checkout (item may be in cart)...');
                    goToCheckout();
                }
            } else {
                // Max retries — go to checkout anyway (optimistic)
                console.log('Target Bot: Max ATC retries. Navigating to checkout...');
                goToCheckout();
            }
        }, CFG.CART_CONFIRM_TIMEOUT_MS);
    }

    // =====================================================================
    //  CART CONFIRMATION VIA MUTATIONOBSERVER  (P2.1, P2.2)
    // =====================================================================
    function watchForCartConfirmation() {
        if (state.cartObserver) state.cartObserver.disconnect();

        const checkCart = () => {
            if (!getTabRunning()) { state.cartObserver?.disconnect(); return; }

            // Handle protection plan modal
            const declineBtn = xpath("//button[contains(text(),'Decline coverage')]");
            if (declineBtn && isVisible(declineBtn)) {
                console.log('Target Bot: Declining protection plan...');
                declineBtn.click();
            }

            // Cart drawer confirmation texts (from live site inspection)
            // "Added to cart" heading + "View cart & check out" button
            const viewCartBtn =
                xpath("//a[contains(text(),'View cart')]")  ||
                xpath("//button[contains(text(),'View cart')]") ||
                xpath("//a[contains(text(),'check out')]");

            const picker = $('button[data-test="custom-quantity-picker"]');
            const addedHeading = xpath("//*[contains(text(),'Added to cart')]");

            if (viewCartBtn || (picker && picker.innerText.toLowerCase().includes('in cart')) || addedHeading) {
                metrics.cartConfirmedAt = Date.now();
                const elapsed = metrics.atcClickedAt ? ((metrics.cartConfirmedAt - metrics.atcClickedAt) / 1000).toFixed(2) : '?';
                console.log(`Target Bot: ✅ Cart confirmed! (${elapsed}s) → Checkout`);
                Notifier.notifyCart(extractTcin());

                clearTimeout(state.cartTimeout);
                if (state.cartObserver) { state.cartObserver.disconnect(); state.cartObserver = null; }

                goToCheckout();
                return true;
            }
            return false;
        };

        // Check immediately
        if (checkCart()) return;

        // Observe DOM mutations
        state.cartObserver = new MutationObserver(checkCart);
        state.cartObserver.observe(document.body, { childList: true, subtree: true });
    }

    // =====================================================================
    //  NAVIGATE TO CHECKOUT
    // =====================================================================
    function goToCheckout() {
        if (!getTabRunning()) return;
        metrics.checkoutStartedAt = Date.now();
        console.log('Target Bot: → Navigating to checkout...');
        window.location.href = 'https://www.target.com/checkout';
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
    //  PRODUCT PAGE HANDLER — orchestrates stock check → ATC → checkout
    // =====================================================================
    function handleProductPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: Analyzing product page...');

        // --- Out of stock? Start dual-mode monitoring ---
        if (isOutOfStock()) {
            console.log('Target Bot: ❌ Out of stock detected on page.');
            const tcin = extractTcin();
            if (tcin) {
                console.log(`Target Bot: Starting dual-mode monitoring for TCIN ${tcin}...`);
                startDualModeMonitoring(tcin);  // Phase 4.1
            } else {
                console.log('Target Bot: No TCIN found. Fast-retrying...');
                clearTimeout(state.pollTimeout);
                state.pollTimeout = setTimeout(() => {
                    if (getTabRunning()) window.location.reload();
                }, 2000);
            }
            return;
        }

        // --- Price check ---
        const maxPrice = getMaxPrice();
        const currentPrice = getCurrentPrice();
        if (maxPrice > 0 && currentPrice !== null && currentPrice > maxPrice) {
            console.log(`Target Bot: Price $${currentPrice} > max $${maxPrice}. Monitoring for price drop...`);
            const tcin = extractTcin();
            if (tcin) startDualModeMonitoring(tcin);
            return;
        }

        // --- Quantity selection (minimized delay) ---
        const targetQty = GM_getValue('qty', '1');
        const qtyBtn = $('button[id^="select-"]') || xpath("//button[contains(., 'Qty')]");
        if (qtyBtn) {
            const qtyTextDiv = qtyBtn.querySelector('div');
            const currentQty = qtyTextDiv ? qtyTextDiv.innerText.trim() : '';
            if (currentQty && currentQty !== targetQty) {
                console.log(`Target Bot: Quantity ${currentQty} → ${targetQty}`);
                const optionLink =
                    $(`ul.Options_styles_options__UapY8 a[aria-label="${targetQty}"]`) ||
                    $(`ul a[aria-label="${targetQty}"]`);
                if (optionLink) optionLink.click();
                else qtyBtn.click();
                setTimeout(handleProductPage, 250); // Reduced from 500ms
                return;
            }
        }

        // --- Find and click ATC ---
        const btn = findATCButton();
        if (btn) {
            metrics.stockDetectedAt = metrics.stockDetectedAt || Date.now();
            console.log('Target Bot: 🛒 ATC button found — clicking!');
            Notifier.notifyStock(extractTcin(), currentPrice);
            beginAddToCart(btn);
        } else {
            // Button not available yet — start dual-mode monitoring
            const tcin = extractTcin();
            if (tcin) {
                console.log('Target Bot: ATC not clickable. Starting dual-mode monitoring...');
                startDualModeMonitoring(tcin);
            } else {
                console.log('Target Bot: ATC not available, no TCIN. Retrying in 2s...');
                clearTimeout(state.pollTimeout);
                state.pollTimeout = setTimeout(() => {
                    if (getTabRunning()) window.location.reload();
                }, 2000);
            }
        }
    }

    // =====================================================================
    //  CHECKOUT HANDLER — Fast loop, single-pass multi-step  (P1.4, P2.3)
    // =====================================================================
    function handleCheckoutPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: Handling checkout page...');
        if (state.checkoutLoop) return; // Already running

        state.checkoutLoop = setInterval(() => {
            if (!getTabRunning()) {
                clearInterval(state.checkoutLoop); state.checkoutLoop = null;
                return;
            }

            const url = window.location.href;

            if (hasOrderConfirmation()) {
                metrics.orderPlacedAt = Date.now();
                console.log('Target Bot: 🎉 Order confirmation detected.');
                console.log(`Target Bot: Metrics — ${metrics.summary()}`);
                Notifier.notifyOrderConfirmed();
                stopWithOrderStatus('Order confirmed successfully.', '✅ Order Confirmed');
                return;
            }

            // Leaving checkout alone does not prove the order was accepted.
            if (!url.includes('/checkout') && !url.includes('/co-')) {
                Notifier.notifyError('Checkout ended without a recognized order confirmation. Verify your Target account.');
                stopWithOrderStatus('Checkout ended without a recognized order confirmation. Verify your Target account before retrying.', '⚠️ Verify Order');
                return;
            }

            // === P3.3 — Detect cart-empty / item-removed errors ===
            for (const msg of $$('[data-test="boxEmptyMsg"], [data-test="error-message"], [data-test="cartEmptyMessage"]')) {
                const t = (msg.textContent || '').toLowerCase();
                if (t.includes('removed') || t.includes('empty') || t.includes('no longer available') || t.includes('sold out')) {
                    console.log('Target Bot: ⚠️ Item removed from cart during checkout! Going back...');
                    Notifier.notifyError('Item was removed from cart or sold out during checkout!');
                    clearInterval(state.checkoutLoop); state.checkoutLoop = null;
                    window.history.back();
                    return;
                }
            }

            // === SINGLE-PASS CHECKOUT STEPS (P2.3) ===

            // 1. Login — fill password + click in same pass
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
                if (passField.value) return; // Wait for login button to enable
            }

            // 2. Skip button (mobile number, etc.)
            const skipBtn = xpath("//a[normalize-space()='Skip']") || xpath("//button[normalize-space()='Skip']");
            if (skipBtn && isVisible(skipBtn)) {
                console.log('Target Bot: Clicking Skip');
                skipBtn.click();
                return;
            }

            // 3. Save and continue
            const sncBtn = xpath("//button[contains(text(),'Save and continue')]");
            if (sncBtn && isVisible(sncBtn) && !isDisabled(sncBtn)) {
                console.log('Target Bot: Clicking Save and Continue');
                sncBtn.click();
                return;
            }

            // 4. CVV — fill + confirm in same pass (P2.4)
            const cvvField    = $('#enter-cvv');
            const confirmBtn  = $('button[data-test="confirm-button"]');
            if (cvvField && !cvvField.disabled && isVisible(cvvField)) {
                const cvv = GM_getValue('cvv', '');
                if (cvv && (!cvvField.value || cvvField.value !== cvv)) {
                    console.log('Target Bot: Entering CVV...');
                    setNativeValue(cvvField, cvv);
                }
                if (cvvField.value === cvv && confirmBtn && !isDisabled(confirmBtn)) {
                    confirmBtn.click();
                    console.log('Target Bot: Confirmed CVV');
                    return;
                }
                if (cvvField.value === cvv) return; // Wait for confirm button
            }

            // Submit only once; a slow response must not create a duplicate order.
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
                        console.log(`Target Bot: ⚠️ Checkout returned an error after submission: ${errorMessage}`);
                    }
                }
            }
        }, CFG.CHECKOUT_INTERVAL_MS);
    }

    // =====================================================================
    //  PHASE 4.2 — SESSION PRE-WARMING
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
                console.log(`Target Bot: ⚠️ Session may need re-auth (status ${resp.status})`);
            }
        } catch (e) {
            console.log(`Target Bot: Session check failed: ${e.message}`);
            state.sessionValid = null;
        }
    }

    // =====================================================================
    //  CART PAGE HANDLER — fast auto-checkout from /cart
    // =====================================================================
    function handleCartPage() {
        if (!getTabRunning()) return;
        console.log('Target Bot: On Cart page — looking for Checkout button...');

        const clickCartCheckout = () => {
            if (!getTabRunning()) return true;

            const checkoutBtn =
                $('button[data-test="checkout-button"]') ||
                $('[data-test="checkout-button-primary"]') ||
                $('[data-test="order-summary-checkout-button"]') ||
                xpath("//button[contains(.,'Check out') or contains(.,'check out') or contains(.,'Sign in to check out')]");

            if (checkoutBtn && isVisible(checkoutBtn) && !isDisabled(checkoutBtn)) {
                console.log('Target Bot: 🛒 Checkout button found on cart page — clicking!');
                metrics.checkoutStartedAt = metrics.checkoutStartedAt || Date.now();
                checkoutBtn.click();
                return true;
            }
            return false;
        };

        if (clickCartCheckout()) return;

        // Poll fast (100ms) for checkout button to appear
        const cartInterval = setInterval(() => {
            if (!getTabRunning() || clickCartCheckout()) {
                clearInterval(cartInterval);
            }
        }, 100);
    }

    // =====================================================================
    //  STATE MACHINE — routes to the right handler
    // =====================================================================
    function runBot() {
        if (!getTabRunning()) return;

        const url = window.location.href;

        if (url.includes('target.com/p/') || url.includes('target.com/s/')) {
            handleProductPage();
        } else if (url.includes('target.com/cart')) {
            handleCartPage();
        } else if (url.includes('/checkout') || url.includes('/co-')) {
            handleCheckoutPage();
        } else {
            console.log('Target Bot: Navigate to a product page or cart to begin.');
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

    // =====================================================================
    //  UI CREATION  (Preserved design + Drop Mode toggle + Drop Timer + Metrics)
    // =====================================================================
    function createUI() {
        if ($('#target-bot-ui')) return;

        GM_addStyle(`
            #target-bot-ui {
                position: fixed;
                right: 18px;
                bottom: 18px;
                z-index: 999999;
                font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
                color: #111827;
            }
            #target-bot-ui .tb-card {
                width: 340px;
                border-radius: 14px;
                background: rgba(255, 255, 255, 0.92);
                border: 1px solid rgba(17, 24, 39, 0.12);
                box-shadow: 0 18px 40px rgba(0, 0, 0, 0.18);
                overflow: hidden;
                backdrop-filter: blur(8px);
                transition: width 160ms ease;
                max-height: 90vh;
                display: flex;
                flex-direction: column;
            }
            #target-bot-ui.tb-minimized .tb-card {
                width: auto;
            }
            #target-bot-ui.tb-minimized .tb-body {
                display: none;
            }
            #target-bot-ui.tb-large .tb-card {
                width: 460px;
            }
            #target-bot-ui .tb-size-toggle {
                border: 1px solid rgba(255, 255, 255, 0.35);
                border-radius: 999px;
                padding: 4px 8px;
                background: rgba(255, 255, 255, 0.16);
                color: inherit;
                font: inherit;
                font-size: 10px;
                font-weight: 700;
                cursor: pointer;
            }
            #target-bot-ui .tb-header {
                padding: 12px 14px;
                background: linear-gradient(135deg, #cc0000 0%, #ff3b30 100%);
                color: #ffffff;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                cursor: grab;
                user-select: none;
                touch-action: none;
            }
            #target-bot-ui .tb-header:active {
                cursor: grabbing;
            }
            #target-bot-ui .tb-header-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #target-bot-ui .tb-icon-btn {
                width: 26px;
                height: 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border: 1px solid rgba(255, 255, 255, 0.35);
                border-radius: 8px;
                padding: 0;
                background: rgba(255, 255, 255, 0.16);
                color: inherit;
                font: inherit;
                font-size: 17px;
                line-height: 1;
                cursor: pointer;
            }
            #target-bot-ui .tb-title {
                font-size: 14px;
                font-weight: 800;
                letter-spacing: 0.2px;
                line-height: 1.1;
            }
            #target-bot-ui .tb-pill {
                font-size: 11px;
                font-weight: 700;
                padding: 4px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.18);
                border: 1px solid rgba(255, 255, 255, 0.25);
                white-space: nowrap;
            }
            #target-bot-ui .tb-body {
                padding: 12px 14px 14px;
                overflow-y: auto;
                max-height: calc(90vh - 54px);
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
                font-size: 12px;
                font-weight: 700;
                color: #374151;
                margin-bottom: 6px;
            }
            #target-bot-ui .tb-input {
                width: 100%;
                box-sizing: border-box;
                padding: 10px 10px;
                border-radius: 10px;
                border: 1px solid rgba(17, 24, 39, 0.16);
                background: #ffffff;
                outline: none;
                font-size: 13px;
                transition: border-color 140ms ease, box-shadow 140ms ease;
            }
            #target-bot-ui .tb-input:focus {
                border-color: rgba(204, 0, 0, 0.5);
                box-shadow: 0 0 0 4px rgba(204, 0, 0, 0.12);
            }
            #target-bot-ui .tb-status-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin: 10px 0 8px;
                padding: 10px 10px;
                border-radius: 12px;
                background: rgba(17, 24, 39, 0.04);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-status-value {
                font-size: 12px;
                font-weight: 800;
                padding: 4px 8px;
                border-radius: 999px;
                background: rgba(255, 255, 255, 0.8);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-metrics {
                font-size: 10px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                color: #6b7280;
                padding: 6px 10px;
                margin-bottom: 8px;
                border-radius: 8px;
                background: rgba(17, 24, 39, 0.03);
                border: 1px solid rgba(17, 24, 39, 0.06);
                overflow-x: auto;
                white-space: nowrap;
            }
            #target-bot-ui .tb-log {
                width: 100%;
                height: 120px;
                max-height: 30vh;
                border-radius: 12px;
                border: 1px solid rgba(17, 24, 39, 0.12);
                background: #111827;
                color: #e5e7eb;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                font-size: 11px;
                line-height: 1.5;
                overflow-y: auto;
                padding: 10px 10px;
                box-sizing: border-box;
                white-space: pre-wrap;
            }
            #target-bot-ui .tb-actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin-top: 12px;
            }
            #target-bot-ui .tb-btn {
                border: none;
                border-radius: 12px;
                padding: 10px 12px;
                font-size: 13px;
                font-weight: 800;
                cursor: pointer;
                transition: transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
            }
            #target-bot-ui .tb-btn:active {
                transform: translateY(1px);
            }
            #target-bot-ui .tb-btn-primary {
                background: linear-gradient(135deg, #16a34a 0%, #22c55e 100%);
                color: #ffffff;
                box-shadow: 0 10px 18px rgba(34, 197, 94, 0.22);
            }
            #target-bot-ui .tb-btn-danger {
                background: linear-gradient(135deg, #b91c1c 0%, #ef4444 100%);
                color: #ffffff;
                box-shadow: 0 10px 18px rgba(239, 68, 68, 0.22);
            }
            #target-bot-ui .tb-btn:hover {
                filter: brightness(1.03);
            }
            #target-bot-ui .tb-toggle-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 10px;
                padding: 8px 10px;
                border-radius: 10px;
                background: rgba(17, 24, 39, 0.03);
                border: 1px solid rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-toggle-label {
                font-size: 12px;
                font-weight: 700;
                color: #374151;
            }
            #target-bot-ui .tb-switch {
                position: relative;
                width: 40px;
                height: 22px;
                background: #d1d5db;
                border-radius: 11px;
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
                width: 18px;
                height: 18px;
                border-radius: 50%;
                background: #fff;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                transition: transform 200ms;
            }
            #target-bot-ui .tb-switch.active::after {
                transform: translateX(18px);
            }
            #target-bot-ui .tb-section-label {
                font-size: 11px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: #9ca3af;
                margin: 12px 0 6px;
            }
            #target-bot-ui .tb-accordion-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 9px 10px;
                background: rgba(17, 24, 39, 0.04);
                border: 1px solid rgba(17, 24, 39, 0.09);
                border-radius: 10px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 700;
                color: #1f2937;
                margin: 10px 0 6px;
                user-select: none;
                transition: background 140ms ease;
            }
            #target-bot-ui .tb-accordion-header:hover {
                background: rgba(17, 24, 39, 0.08);
            }
            #target-bot-ui .tb-accordion-body {
                padding: 4px 2px 8px;
                display: none;
            }
            #target-bot-ui .tb-accordion-body.open {
                display: block;
            }
            #target-bot-ui .tb-test-btn {
                padding: 5px 10px;
                border-radius: 8px;
                font-size: 11px;
                font-weight: 700;
                border: 1px solid rgba(17, 24, 39, 0.15);
                background: #ffffff;
                color: #374151;
                cursor: pointer;
                transition: all 120ms ease;
            }
            #target-bot-ui .tb-test-btn:hover {
                background: #f3f4f6;
                border-color: #9ca3af;
            }
            #target-bot-ui .tb-checkbox-group {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                margin-top: 6px;
                font-size: 11px;
                font-weight: 600;
                color: #4b5563;
            }
            #target-bot-ui .tb-checkbox-item {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
            }
            @media (max-width: 520px) {
                #target-bot-ui {
                    right: 8px;
                    bottom: 8px;
                }
                #target-bot-ui .tb-card,
                #target-bot-ui.tb-large .tb-card {
                    width: min(460px, calc(100vw - 16px));
                }
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
                    <div class="tb-title">Target Auto Buyer</div>
                    <div class="tb-header-actions">
                        <div class="tb-pill">v3.2 ⚡</div>
                        <button id="bot-size-toggle" class="tb-size-toggle" type="button" aria-label="Switch panel size">${isLarge ? 'Compact' : 'Large'}</button>
                        <button id="bot-minimize-toggle" class="tb-icon-btn" type="button" aria-controls="bot-panel-body" aria-expanded="${!isMinimized}" aria-label="${isMinimized ? 'Restore panel' : 'Minimize panel'}">${isMinimized ? '□' : '−'}</button>
                    </div>
                </div>
                <div id="bot-panel-body" class="tb-body">
                    <div class="tb-grid-2">
                        <div class="tb-field">
                            <label class="tb-label" for="bot-qty">Quantity</label>
                            <input class="tb-input" type="number" id="bot-qty" min="1" max="10" value="${GM_getValue('qty', '1')}" />
                        </div>
                        <div class="tb-field">
                            <label class="tb-label" for="bot-max-price">Max Price ($0=any)</label>
                            <input class="tb-input" type="number" id="bot-max-price" min="0" step="0.01" value="${GM_getValue('maxPrice', '0')}" />
                        </div>
                    </div>

                    <div class="tb-field">
                        <label class="tb-label" for="bot-cvv">CVV</label>
                        <input class="tb-input" type="text" id="bot-cvv" maxlength="4" value="${GM_getValue('cvv', '')}" />
                    </div>

                    <div class="tb-section-label">Speed Settings</div>
                    <div class="tb-grid-2">
                        <div class="tb-field">
                            <label class="tb-label" for="bot-min-delay">Poll Min (ms)</label>
                            <input class="tb-input" type="number" id="bot-min-delay" value="${GM_getValue('minDelay', String(CFG.POLL_MIN_MS))}" />
                        </div>
                        <div class="tb-field">
                            <label class="tb-label" for="bot-max-delay">Poll Max (ms)</label>
                            <input class="tb-input" type="number" id="bot-max-delay" value="${GM_getValue('maxDelay', String(CFG.POLL_MAX_MS))}" />
                        </div>
                    </div>

                    <div class="tb-toggle-row">
                        <span class="tb-toggle-label">⚡ Drop Mode (${CFG.DROP_MODE_POLL_MS}ms polls)</span>
                        <div id="bot-drop-mode" class="tb-switch ${GM_getValue('dropMode', false) ? 'active' : ''}"></div>
                    </div>

                    <div class="tb-section-label">Drop Timer</div>
                    <div class="tb-grid-2">
                        <div class="tb-field">
                            <label class="tb-label" for="bot-drop-time">Drop Time</label>
                            <input class="tb-input" type="datetime-local" id="bot-drop-time" value="${GM_getValue('dropTime', '')}" />
                        </div>
                        <div class="tb-field">
                            <label class="tb-label">Countdown</label>
                            <div id="bot-drop-countdown" class="tb-input" style="display:flex;align-items:center;color:#6b7280;cursor:default;">—</div>
                        </div>
                    </div>

                    <!-- Notifications & Sound Section -->
                    <div class="tb-accordion-header" id="bot-notif-accordion-header">
                        <span>🔔 Alerts & Notifications</span>
                        <span id="bot-notif-chevron" style="transition: transform 200ms ease; font-size: 10px;">${GM_getValue('uiNotifOpen', false) ? '▲' : '▼'}</span>
                    </div>
                    <div id="bot-notif-accordion-body" class="tb-accordion-body ${GM_getValue('uiNotifOpen', false) ? 'open' : ''}">
                        <!-- Sound settings -->
                        <div class="tb-toggle-row" style="margin-bottom: 6px;">
                            <span class="tb-toggle-label">🔊 Audio Alerts</span>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <button type="button" id="bot-test-sound" class="tb-test-btn" title="Test audio playback">Test</button>
                                <div id="bot-sound-mode" class="tb-switch ${GM_getValue('soundEnabled', true) ? 'active' : ''}"></div>
                            </div>
                        </div>

                        <!-- Discord settings -->
                        <div class="tb-toggle-row" style="margin-bottom: 6px;">
                            <span class="tb-toggle-label">💬 Discord Webhook</span>
                            <div id="bot-discord-mode" class="tb-switch ${GM_getValue('discordEnabled', false) ? 'active' : ''}"></div>
                        </div>
                        <div id="bot-discord-fields" style="${GM_getValue('discordEnabled', false) ? '' : 'display:none;'} margin-bottom: 8px;">
                            <div class="tb-field" style="margin-bottom: 4px;">
                                <input class="tb-input" type="text" id="bot-discord-webhook" placeholder="https://discord.com/api/webhooks/..." value="${GM_getValue('discordWebhook', '')}" />
                            </div>
                            <button type="button" id="bot-test-discord" class="tb-test-btn" style="width: 100%;">Test Discord Webhook</button>
                        </div>

                        <!-- Telegram settings -->
                        <div class="tb-toggle-row" style="margin-bottom: 6px;">
                            <span class="tb-toggle-label">✈️ Telegram Bot</span>
                            <div id="bot-telegram-mode" class="tb-switch ${GM_getValue('telegramEnabled', false) ? 'active' : ''}"></div>
                        </div>
                        <div id="bot-telegram-fields" style="${GM_getValue('telegramEnabled', false) ? '' : 'display:none;'} margin-bottom: 8px;">
                            <div class="tb-field" style="margin-bottom: 4px;">
                                <input class="tb-input" type="text" id="bot-telegram-token" placeholder="Bot Token (e.g. 123456:ABC...)" value="${GM_getValue('telegramToken', '')}" />
                            </div>
                            <div class="tb-field" style="margin-bottom: 4px;">
                                <input class="tb-input" type="text" id="bot-telegram-chat-id" placeholder="Chat ID (e.g. 123456789)" value="${GM_getValue('telegramChatId', '')}" />
                            </div>
                            <button type="button" id="bot-test-telegram" class="tb-test-btn" style="width: 100%;">Test Telegram Message</button>
                        </div>

                        <!-- Event preferences -->
                        <div class="tb-section-label" style="margin-top: 8px;">Notify On Events</div>
                        <div class="tb-checkbox-group">
                            <label class="tb-checkbox-item"><input type="checkbox" id="bot-notify-stock" ${GM_getValue('notifyStock', true) ? 'checked' : ''}/> In-Stock</label>
                            <label class="tb-checkbox-item"><input type="checkbox" id="bot-notify-cart" ${GM_getValue('notifyCart', true) ? 'checked' : ''}/> Cart Added</label>
                            <label class="tb-checkbox-item"><input type="checkbox" id="bot-notify-order" ${GM_getValue('notifyOrder', true) ? 'checked' : ''}/> Order Placed</label>
                            <label class="tb-checkbox-item"><input type="checkbox" id="bot-notify-error" ${GM_getValue('notifyError', true) ? 'checked' : ''}/> Errors/Alerts</label>
                        </div>
                    </div>

                    <div class="tb-status-row">
                        <span class="tb-label" style="margin: 0;">Status</span>
                        <span id="bot-status" class="tb-status-value" style="color: ${getTabRunning() ? '#16a34a' : '#b91c1c'};">${getTabRunning() ? 'Running' : 'Stopped'}</span>
                    </div>

                    <div id="bot-metrics" class="tb-metrics">Waiting...</div>

                    <div class="tb-field" style="margin-bottom: 0;">
                        <label class="tb-label" for="bot-log-area">Logs</label>
                        <div id="bot-log-area" class="tb-log"></div>
                    </div>

                    <div class="tb-actions">
                        <button id="bot-start" class="tb-btn tb-btn-primary">▶ Start</button>
                        <button id="bot-stop"  class="tb-btn tb-btn-danger">■ Stop</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(ui);

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
            const maxLeft = Math.max(0, window.innerWidth - ui.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - ui.offsetHeight);
            ui.style.left = `${Math.min(Math.max(0, savedPosition.left), maxLeft)}px`;
            ui.style.top = `${Math.min(Math.max(0, savedPosition.top), maxTop)}px`;
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
        window.addEventListener('resize', () => {
            GM_setValue('uiPosition', keepUIInViewport());
        });

        $('#bot-size-toggle').addEventListener('click', () => {
            const large = !ui.classList.contains('tb-large');
            ui.classList.toggle('tb-large', large);
            GM_setValue('uiSize', large ? 'large' : 'compact');
            $('#bot-size-toggle').textContent = large ? 'Compact' : 'Large';
            $('#bot-size-toggle').setAttribute('aria-label', large ? 'Use compact panel' : 'Use large panel');
            GM_setValue('uiPosition', keepUIInViewport());
        });

        $('#bot-minimize-toggle').addEventListener('click', () => {
            const minimized = !ui.classList.contains('tb-minimized');
            ui.classList.toggle('tb-minimized', minimized);
            GM_setValue('uiMinimized', minimized);
            $('#bot-minimize-toggle').textContent = minimized ? '□' : '−';
            $('#bot-minimize-toggle').setAttribute('aria-expanded', String(!minimized));
            $('#bot-minimize-toggle').setAttribute('aria-label', minimized ? 'Restore panel' : 'Minimize panel');
            GM_setValue('uiPosition', keepUIInViewport());
        });

        // --- Wire up input persistence ---
        const save = () => {
            GM_setValue('qty',              $('#bot-qty')?.value || '1');
            GM_setValue('maxPrice',         $('#bot-max-price')?.value || '0');
            GM_setValue('cvv',              $('#bot-cvv')?.value || '');
            GM_setValue('minDelay',         $('#bot-min-delay')?.value || String(CFG.POLL_MIN_MS));
            GM_setValue('maxDelay',         $('#bot-max-delay')?.value || String(CFG.POLL_MAX_MS));
            GM_setValue('dropTime',         $('#bot-drop-time')?.value || '');
            GM_setValue('discordWebhook',   $('#bot-discord-webhook')?.value?.trim() || '');
            GM_setValue('telegramToken',    $('#bot-telegram-token')?.value?.trim() || '');
            GM_setValue('telegramChatId',   $('#bot-telegram-chat-id')?.value?.trim() || '');
            GM_setValue('notifyStock',      $('#bot-notify-stock')?.checked ?? true);
            GM_setValue('notifyCart',       $('#bot-notify-cart')?.checked ?? true);
            GM_setValue('notifyOrder',      $('#bot-notify-order')?.checked ?? true);
            GM_setValue('notifyError',      $('#bot-notify-error')?.checked ?? true);
        };

        [
            'bot-qty', 'bot-max-price', 'bot-cvv', 'bot-min-delay', 'bot-max-delay', 'bot-drop-time',
            'bot-discord-webhook', 'bot-telegram-token', 'bot-telegram-chat-id',
            'bot-notify-stock', 'bot-notify-cart', 'bot-notify-order', 'bot-notify-error'
        ].forEach(id => {
            const el = $(`#${id}`);
            if (el) el.addEventListener('change', save);
        });

        // Notifications accordion toggle
        const notifAccordionHeader = $('#bot-notif-accordion-header');
        const notifAccordionBody   = $('#bot-notif-accordion-body');
        const notifChevron         = $('#bot-notif-chevron');
        if (notifAccordionHeader && notifAccordionBody) {
            notifAccordionHeader.addEventListener('click', () => {
                const isOpen = notifAccordionBody.classList.toggle('open');
                GM_setValue('uiNotifOpen', isOpen);
                if (notifChevron) notifChevron.textContent = isOpen ? '▲' : '▼';
            });
        }

        // Sound mode toggle
        const soundToggle = $('#bot-sound-mode');
        if (soundToggle) {
            soundToggle.addEventListener('click', () => {
                const active = !soundToggle.classList.contains('active');
                soundToggle.classList.toggle('active', active);
                GM_setValue('soundEnabled', active);
                console.log(`Target Bot: Audio Alerts ${active ? 'ON 🔊' : 'OFF'}`);
            });
        }

        // Test Sound button
        const testSoundBtn = $('#bot-test-sound');
        if (testSoundBtn) {
            testSoundBtn.addEventListener('click', () => {
                Sound.getContext();
                console.log('Target Bot: 🔊 Playing test audio chime...');
                Sound.orderConfirmedAlert();
            });
        }

        // Discord toggle
        const discordToggle = $('#bot-discord-mode');
        const discordFields = $('#bot-discord-fields');
        if (discordToggle) {
            discordToggle.addEventListener('click', () => {
                const active = !discordToggle.classList.contains('active');
                discordToggle.classList.toggle('active', active);
                GM_setValue('discordEnabled', active);
                if (discordFields) discordFields.style.display = active ? 'block' : 'none';
                console.log(`Target Bot: Discord Notifications ${active ? 'ON 💬' : 'OFF'}`);
            });
        }

        // Test Discord button
        const testDiscordBtn = $('#bot-test-discord');
        if (testDiscordBtn) {
            testDiscordBtn.addEventListener('click', async () => {
                save();
                const webhook = GM_getValue('discordWebhook', '').trim();
                if (!webhook) {
                    console.log('Target Bot: ⚠️ Enter a Discord Webhook URL first.');
                    return;
                }
                console.log('Target Bot: 📨 Sending test message to Discord...');
                try {
                    await sendDiscordNotification('test', {
                        title: '🧪 DISCORD WEBHOOK TEST SUCCESSFUL',
                        message: 'Your Discord webhook is linked correctly! You will receive formatted drop alerts with product links, pricing, quantity, and order statuses.',
                        productName: 'Sample Product Test (PlayStation 5)',
                        tcin: '88492049',
                        price: '$499.99',
                        qty: '1',
                        metrics: 'Test Latency: 0.15s',
                        customFields: [
                            { name: '🟢 Webhook Status', value: 'Connected & Verified', inline: true }
                        ]
                    });
                    console.log('Target Bot: ✅ Discord test notification sent successfully!');
                } catch (e) {
                    console.log(`Target Bot: ❌ Discord test failed: ${e.message}`);
                }
            });
        }

        // Telegram toggle
        const telegramToggle = $('#bot-telegram-mode');
        const telegramFields = $('#bot-telegram-fields');
        if (telegramToggle) {
            telegramToggle.addEventListener('click', () => {
                const active = !telegramToggle.classList.contains('active');
                telegramToggle.classList.toggle('active', active);
                GM_setValue('telegramEnabled', active);
                if (telegramFields) telegramFields.style.display = active ? 'block' : 'none';
                console.log(`Target Bot: Telegram Notifications ${active ? 'ON ✈️' : 'OFF'}`);
            });
        }

        // Test Telegram button
        const testTelegramBtn = $('#bot-test-telegram');
        if (testTelegramBtn) {
            testTelegramBtn.addEventListener('click', async () => {
                save();
                const token = GM_getValue('telegramToken', '').trim();
                const chatId = GM_getValue('telegramChatId', '').trim();
                if (!token || !chatId) {
                    console.log('Target Bot: ⚠️ Enter both Telegram Bot Token and Chat ID first.');
                    return;
                }
                console.log('Target Bot: 📨 Sending test message to Telegram...');
                try {
                    await sendTelegramNotification('test', {
                        message: 'Your Telegram bot is configured and communicating properly! You will receive live alerts for in-stock drops, cart progress, and order confirmation.',
                        productName: 'Sample Product Test (PlayStation 5)',
                        tcin: '88492049',
                        price: '$499.99',
                        qty: '1',
                        metrics: 'Test Latency: 0.15s',
                    });
                    console.log('Target Bot: ✅ Telegram test message sent successfully!');
                } catch (e) {
                    console.log(`Target Bot: ❌ Telegram test failed: ${e.message}`);
                }
            });
        }

        // Drop-mode toggle
        const dropToggle = $('#bot-drop-mode');
        dropToggle.addEventListener('click', () => {
            const active = !dropToggle.classList.contains('active');
            dropToggle.classList.toggle('active', active);
            GM_setValue('dropMode', active);
            console.log(`Target Bot: Drop Mode ${active ? 'ON ⚡' : 'OFF'}`);
        });

        // Start / Stop
        $('#bot-start').addEventListener('click', () => {
            Sound.getContext(); // Unlock audio context on user gesture
            save();
            setTabRunning(true);
            updateStatusUI(true);
            metrics.reset();
            state.placeOrderAttempted = false;

            // Phase 4.2: Pre-warm session on start
            preWarmSession().then(() => runBot());
        });

        $('#bot-stop').addEventListener('click', () => {
            setTabRunning(false);
            updateStatusUI(false);
            stopAllTimers();
        });

        // --- Drop Timer Countdown (P4.4) ---
        state.dropTimerInterval = setInterval(() => {
            const cdEl = $('#bot-drop-countdown');
            if (!cdEl) return;

            const dropTime = GM_getValue('dropTime', '');
            if (!dropTime) { cdEl.textContent = '—'; return; }

            const target = new Date(dropTime).getTime();
            const now = Date.now();
            const diff = target - now;

            if (diff <= 0) {
                cdEl.textContent = '🔴 NOW!';
                cdEl.style.color = '#dc2626';
                cdEl.style.fontWeight = '800';
            } else {
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                const s = Math.floor((diff % 60000) / 1000);
                cdEl.textContent = `${h}h ${m}m ${s}s`;
                cdEl.style.color = diff <= CFG.ADAPTIVE_LEAD_SEC * 1000 ? '#f59e0b' : '#6b7280';
                cdEl.style.fontWeight = diff <= CFG.ADAPTIVE_LEAD_SEC * 1000 ? '800' : '400';
            }
        }, 1000);

        // --- Periodic metrics update ---
        setInterval(updateMetricsUI, 500);

        updateStatusUI(getTabRunning());
    }

    // =====================================================================
    //  STARTUP — Smart page-ready detection  (P1.3)
    // =====================================================================
    function waitForPageReady(callback) {
        const t0 = Date.now();

        function check() {
            const hasProduct =
                $('[data-test="product-price"]') ||
                $('button[data-test="shippingButton"]') ||
                $('button[id^="addToCartButtonOrTextIdFor"]') ||
                $('[data-test="outOfStockButton"]') ||
                $('span.h-text-bold');

            const isCart     = window.location.href.includes('target.com/cart');
            const isCheckout = window.location.href.includes('/checkout') || window.location.href.includes('/co-');
            const timedOut   = Date.now() - t0 > CFG.STARTUP_MAX_WAIT_MS;

            if (hasProduct || isCart || isCheckout || timedOut) {
                if (timedOut && !hasProduct && !isCart && !isCheckout) {
                    console.log('Target Bot: Page ready timeout — proceeding anyway.');
                }
                callback();
            } else {
                setTimeout(check, CFG.STARTUP_POLL_MS);
            }
        }

        check();
    }

    // =====================================================================
    //  INITIALIZATION — No fixed 1s delay, uses smart readiness check
    // =====================================================================
    function init() {
        waitForPageReady(() => {
            createUI();
            if (getTabRunning()) {
                console.log('Target Bot: Resuming from previous session...');
                runBot();
            }
        });
    }

    // Fire as soon as possible
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }

})();
