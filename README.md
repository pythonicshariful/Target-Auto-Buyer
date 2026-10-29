# Target Auto Buyer ⚡ v4.2 — Parallel Multi-Tab & Pokemon Drop Edition

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-green.svg)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Target.com-CC0000.svg)](https://www.target.com)
[![Version](https://img.shields.io/badge/Version-4.2-blue.svg)](#features)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](#license)

An ultra-fast browser userscript for monitoring Target product availability, auto-scanning Pokemon categories & drops, executing **parallel multi-tab purchases**, handling multi-quantity orders, and completing checkout with Discord, Telegram, and synthesized audio alerts.

---

## ⚡ What's New in Version 4.2 — Parallel Multi-Tab Buying Engine

### 🪟 1. Parallel Multi-Tab Auto-Buyer & Coordinator
- **Search Page Coordinator:** When started on any Target search page (`https://www.target.com/s?searchTerm=pokemon+card`) or category page, the tab operates as an intelligent **Coordinator**. It remains on the search page, continuously managing the product queue and worker tabs.
- **Auto-Extract Matches into Multi-URL Box:** On every scan, the bot scans rendered DOM cards and Target's Redsky API, filters items with your whitelist/blacklist, and automatically inputs matching URLs into the **Multi-URL Monitor box (`#bot-multi-urls`)**.
- **Concurrent Tabs (2–3 Tabs Simultaneously):** Configurable in the HUD under **Parallel Product Tabs** (default: `2`, configurable up to `5`). The bot opens multiple product tabs concurrently to monitor, add to cart, and process checkout in parallel.
- **Dynamic Slot Replenishment on Reaching Checkout:** As soon as an opened product tab adds an item to cart and reaches the **checkout page** (`/checkout` or `/co-`), it broadcasts `WORKER_CHECKOUT_REACHED` via `BroadcastChannel`. The coordinator immediately frees up that slot and opens the **next product tab from the queue** without waiting for order completion!
- **Auto-Close Finished Tabs:**
  - **Order Confirmed:** Records purchased units toward the Total Purchase Goal, alerts Discord/Telegram, and closes the worker tab after 4 seconds.
  - **Out of Stock (OOS):** Broadcasts `WORKER_OOS` to open the next item immediately and closes the tab after 1.5 seconds.
  - **Cart Errors / Sold Out:** Notifies coordinator to launch the next product and closes the tab after 1.5 seconds.
- **Live Queue & Tab Status Display:** The HUD features a real-time badge: `Queue: X | Open: Y` showing queued items and currently running worker tabs.

### 🛡️ 2. Stability & Anti-Bot Enhancements
- **XPath Verification Fix:** Replaced fragile string-escaped XPath evaluation with safe DOM text queries, eliminating syntax crashes on Cloudflare/Target verification prompts.
- **Redsky API Parsing Guard:** Added bulletproof `.trim() || '{}'` payload validation on Redsky `plp_search_v2` endpoints to prevent unexpected end-of-JSON errors.
- **Search Term Normalization:** Global regex normalization handles queries like `pokimon card` by mapping them directly to official Pokemon product queries.
- **Drawer Fulfillment Selector:** Scoped fulfillment drawer button selectors to avoid re-clicking Add to Cart inside slide-out drawers.

---

## 🔄 Architecture & Flow

```
+-------------------------------------------------------------------+
|               COORDINATOR TAB (Search / Category Page)            |
|  - Scans DOM Cards & Redsky API                                   |
|  - Populates Multi-URL Monitor & Queue (In-stock first)           |
|  - Manages Parallel Limits (2-3 tabs)                             |
|  - Listens for Cross-Tab BroadcastChannel Events                  |
+---------------------------------+---------------------------------+
                                  |
            +---------------------+---------------------+
            |                     |                     |
     Opens Tab 1           Opens Tab 2           Opens Tab 3
            |                     |                     |
            v                     v                     v
     [Worker Tab 1]        [Worker Tab 2]        [Worker Tab 3]
     - PDP Check           - PDP Check           - PDP Check
     - Add to Cart         - Out of Stock?       - Add to Cart
            |                     |                     |
            |              Sends WORKER_OOS             |
            |              Closes in 1.5s               |
            |                     |                     |
     Reaches /checkout            |              Reaches /checkout
            |                     |                     |
     Sends WORKER_CHECKOUT_REACHED|              Sends WORKER_CHECKOUT_REACHED
            |                     |                     |
            +-----------> Coordinator Opens Next Product <---------+
            |                                                      |
     Auto-fills CVV                                         Auto-fills CVV
     Clicks Place Order                                     Clicks Place Order
     Order Confirmed!                                       Order Confirmed!
     Sends ORDER_COMPLETED                                  Sends ORDER_COMPLETED
     Closes in 4s                                           Closes in 4s
```

---

## 🚀 Key Features

### 🛒 1. Intelligent Add-to-Cart & Quantity Controller
- Automatically adjusts quantity on PDP, in the fulfillment drawer, or on `/cart`.
- If an item has a purchase limit (e.g. limit 2 per order), the bot selects the maximum allowed and uses the **Repeat Purchase Loop** to reach your target goal.
- Auto-declines warranty and protection plan modals.

### 💳 2. Rapid Single-Pass Checkout
- Fast evaluation loop on `/checkout`.
- Auto-fills CVV based on active account profile.
- Submits Place Order once and monitors confirmation status.

### 🔔 3. Multi-Channel Alerts & Audio Chimes
- **Discord Webhooks:** Rich visual embeds with product title, TCIN, price, quantity, and goal progress.
- **Telegram Bot API:** Instant push alerts to Telegram chats or channels with copyable code tags.
- **Web Audio Chimes:** Built-in acoustic synthesizer for Stock Detected, Cart Added, and Order Confirmed fanfare (zero external audio files needed).

---

## 🛠️ Installation & Setup

### Step 1: Install a Userscript Manager
Install [Tampermonkey](https://www.tampermonkey.net/) on Chrome, Brave, Edge, or Firefox.

### Step 2: Install Target Auto Buyer v4.2
1. Open the Tampermonkey Dashboard → Click **Add a new script** (`+`).
2. Replace default contents with [`Target Auto Buyer.js`](./Target%20Auto%20Buyer.js).
3. Press **Ctrl + S** (or **Cmd + S**) to save.

### Step 3: Enable Browser Pop-ups (CRITICAL for Multi-Tab)
Because the bot opens 2–3 tabs concurrently to check out multiple items in parallel:
1. Navigate to `https://www.target.com/s?searchTerm=pokemon+card`
2. Click the site settings icon on the left of the address bar (or the pop-up blocker icon on the right).
3. Set **Pop-ups and redirects** to **Allow**.

---

## 📖 Recommended Settings for Pokemon Drops

Open the floating HUD by visiting Target.com and configure the **🔍 Pokemon Tab**:

| Setting | Recommended Value | Description |
|---|---|---|
| **Auto-Scan Pokemon Categories** | `ON` | Automatically scans search and category pages. |
| **Buy ANY In-Stock Pokemon Card** | `OFF` | Set to `OFF` so it uses the Whitelist and ignores non-Pokemon items (e.g. Mario, Monopoly). |
| **Repeat Purchase Loop** | `ON` | Continues buying across items until Total Goal is reached. |
| **Total Purchase Goal** | `100` – `1000` | Target total units across all orders. |
| **Parallel Product Tabs** | `2` or `3` | Number of product tabs to process simultaneously. |
| **Whitelist Keywords** | `pokemon, pokimon, booster, elite trainer, scarlet, celebration, tin, collection, pack, box, tcg` | Comma-separated allowed product keywords. |
| **Blacklist Keywords** | `shirt, socks, hoodie, costume, plush, binder, book, blanket` | Keywords to strictly skip. |
| **Multi-URL Monitor** | Auto-populated | Automatically filled with matched URLs; can also paste custom URLs. |

---

## 🧪 Safe Dry-Run Testing

1. Navigate to an in-stock, inexpensive everyday item (e.g., notebook, paper clips).
2. Set **Quantity** to `1`.
3. In the **⚡ Drop Tab**, set **Max Price** to `$0.01` (below item price).
4. Click **▶ Start Bot**.
5. Verify:
   - The bot detects the price and logs: `Price $X > max $0.01. Monitoring for price drop...`
   - Test Discord, Telegram, and Audio alerts using the test buttons in the **🔔 Alerts Tab**.
6. When satisfied, set **Max Price** back to `$0` (any price) or your target budget and start your drop session!

---

## 📄 License
MIT License. For educational and automation workflow research. Always adhere to Target.com Terms of Service.
