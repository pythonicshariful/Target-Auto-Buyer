# Target Auto Buyer ⚡ v4.0 — Pokemon Drop & Auto-Monitor Edition

[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-Supported-green.svg)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Target.com-CC0000.svg)](https://www.target.com)
[![Version](https://img.shields.io/badge/Version-4.0-blue.svg)](#features)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](#license)

An ultra-fast browser userscript for monitoring Target product availability, auto-scanning Pokemon categories & drops, handling multi-quantity orders, and completing checkout with Discord, Telegram, and synthesized audio alerts.

---

## ⚡ Version 4.0 — What's New

### 🐛 Critical Bug Fixes (Day 1)
1. **Quantity Stays at 1 Bug — Fixed:**
   - Introduced a **3-Tier Quantity Controller** covering:
     - **Tier 1 (PDP):** Supports native `<select>`, Target custom dropdowns (`[role="listbox"]`), and numeric steppers.
     - **Tier 2 (Cart Drawer):** Adjusts quantity in the slide-out drawer immediately upon ATC.
     - **Tier 3 (Cart Page `/cart`):** For 3rd-party marketplace Pokemon items (where no quantity selector exists on the product page), the bot routes through `/cart` and updates `select[data-test="cartItem-qty"]` or steppers up to the seller's maximum allowed purchase limit before heading to checkout!
2. **High-Priced Items ($800+) Failing — Fixed:**
   - Corrected `isOutOfStock()` false positives caused by Target's "Out of stock at store pickup" badges on items that are fully in-stock for shipping.
   - Smart price parser now extracts the primary price cleanly, avoiding corrupted values from price ranges (e.g. `$299.99 – $849.99`).
   - Added a **"Skip Price Check for Marketplace"** toggle so high-value bundles are never blocked.
   - Added automatic fulfillment selection for items requiring "Shipping" radio button selection prior to ATC.

### 🔍 Pokemon Drop & Category Auto-Monitor (Day 2)
- **Automatic Category & Search Scanner:** Run the bot on `https://www.target.com/s?searchTerm=pokemon` — it continuously monitors search results for drops matching your whitelist keywords (e.g. `30th Anniversary`, `Ascended Heroes`, `Pitch Black`, `Booster Bundle`, `Elite Trainer Box`).
- **Blacklist Filter:** Ignores non-card products like t-shirts, plushies, binders, and costumes.
- **Multi-URL Monitoring:** Paste multiple Target product links or TCINs into the bot; it monitors availability across all of them.
- **Repeat Purchase Loop (Auto-Rebuy):** Set a purchase goal (e.g., 10, 50, 1000 pcs). Once an order is confirmed, the bot automatically loops back to repurchase until your target goal is met!

### 👥 Multi-Account & Multi-Tab Orchestration (Day 3)
- **Multi-Account Profile Manager:** Store multiple account profiles with unique CVVs. The bot automatically inputs the correct CVV for each account profile during checkout.
- **Cross-Tab Synchronization (`BroadcastChannel`):** Open multiple browser tabs across different accounts; tabs communicate to sync total purchased count, claim separate items, and coordinate global start/stop commands.
- **Proxy Configuration Guide:** In-HUD instructions for setting up US residential proxies with extensions like Proxy SwitchyOmega.

---

## 🚀 Key Features

### 🛒 1. Intelligent Add-to-Cart & Quantity Controller
- Automatically adjusts quantity on PDP, in the cart drawer, or on `/cart`.
- If an item has a purchase limit (e.g. limit 2 per order), the bot selects the maximum allowed and uses the **Repeat Purchase Loop** to reach your target goal.
- Auto-declines warranty & protection plan modals.

### 💳 2. Rapid Single-Pass Checkout
- Fast 200ms evaluation loop on `/checkout`.
- Auto-fills CVV based on the active account profile.
- Submits Place Order once and monitors confirmation status.

### 🔔 3. Multi-Channel Alerts & Audio Chimes
- **Discord Webhooks:** Rich embeds with product title, TCIN, price, quantity, and goal progress.
- **Telegram Bot API:** Instant push notifications to Telegram chats or channels.
- **Web Audio Chimes:** Synthesized audio for Stock Detected, Cart Added, and Order Confirmed fanfare.

---

## 🛠️ Installation

### Step 1: Install a Userscript Manager
Install [Tampermonkey](https://www.tampermonkey.net/) on Chrome, Edge, Brave, or Firefox.

### Step 2: Install Target Auto Buyer v4.0
1. Open Tampermonkey Dashboard -> Click **Add a new script** (`+`).
2. Replace default code with [`Target Auto Buyer.js`](./Target%20Auto%20Buyer.js).
3. Press **Ctrl + S** (or **Cmd + S**) to save.

---

## 📖 How to Use

### 1. Pre-Drop Setup
1. Log in to your Target account.
2. Save your default shipping address and payment card in your Target Wallet.
3. Keep your card CVV handy.

### 2. Configure the HUD Tabs
- **⚡ Drop Tab:** Set Quantity (e.g., 5 or 10), Max Price ($0 = any), CVV, and Drop Mode.
- **🔍 Pokemon Tab:** Enable "Auto-Scan Pokemon Categories", set your Target Goal (e.g., 1000 pcs), and configure Whitelist/Blacklist keywords.
- **👥 Accounts Tab:** Add additional account profiles and manage multi-tab synchronization.
- **🔔 Alerts Tab:** Enter your Discord Webhook URL or Telegram Bot Token/Chat ID.

### 3. Start Monitoring
- Navigate to any Target Pokemon product page or search page (`https://www.target.com/s?searchTerm=pokemon`).
- Click **▶ Start Bot**.