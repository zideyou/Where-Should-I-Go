# Where Should I Go

A small web app that searches several places on Google Maps and finds the ones that are **closest to each other**, so you don't have to go far to get to the next place.

## Two ways to use it

### 1. Nearby areas
Type a kind of place into the search bar, or tap a category chip under it (`拉麵`, `咖啡廳`, `書店`…). Each search can return up to 20 results. The app splits the results into up to **5 different areas** of town. Each area plan:
- is built around the tightest one-of-each group of places in that area
- lists **several nearby places of each type** (up to 5) so you can pick the one you like; the route updates when you choose
- draws **every area as a circle on the map**, labelled 方案 1, 方案 2…; click a circle or its label to open a popup with that plan's filter options (choose a place, keep 📌 or exclude 🚫)
- has a **路線** button that opens real directions in Google Maps

Press **儲存** on a plan (in its card or the map popup) to keep it; the **已儲存** tab lists saved plans so you can reopen them any time, exactly as saved (places, choices, starting point, travel mode). Saved plans live in this browser's localStorage.

Each plan is named after the nearest MRT station (Places nearby search), else the road most of its places are on, else the district.

Areas never share places, so each plan really is a different neighbourhood. You can keep (📌) or exclude (🚫) a place, and "在此區域搜尋" re-runs the searches inside the visible map.

### 2. Plan my stops
Add the exact places you already want to visit. The app works out the **visiting order with the least travel**. Up to 8 stops the order is guaranteed shortest. Above that it's a close estimate (nearest neighbour + 2-opt).

Both modes accept an optional **starting point** (set in the ☰ menu, together with travel mode and units), such as your hotel. If you set one, the trip begins there.

## Look and feel
The interface follows the layout and visual style of the Google Maps app and website (it does not use Google's logo or trademarks): a floating rounded search bar at the top left, category chips below it, white Material-style cards, Roboto and blue `#1a73e8`. On desktop the results sit in a collapsible side panel; on phones they are in a bottom sheet you can drag between peek, half and full height.

**Dark mode** follows the system setting by default; the ☰ menu has 自動 / 淺色 / 深色 to override it (saved in this browser). The map switches to its dark colour scheme too.

## Setup

1. **Get a Google Maps API key.**
   - Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project. Billing must be enabled, but Google gives a free monthly credit.
   - Under *APIs & Services → Library*, enable **Maps JavaScript API** and **Places API (New)**.
   - Under *APIs & Services → Credentials*, create an API key.
   - Recommended: restrict the key to *HTTP referrers* (for example `http://localhost:8080/*` and your hosted domain) and to those two APIs.
2. **Run the app locally.** It's static files only, so no build step:
   ```bash
   npm start            # serves on http://localhost:8080
   # or: python3 -m http.server 8080
   ```
3. Open http://localhost:8080 and paste your key. It's saved only in your browser's localStorage. To change it, click *Change API key*.

You can also host it on any static host (GitHub Pages, Netlify, etc.). Add the hosted domain to the key's referrer restrictions.

## How distance is measured
Ranking uses straight-line (great-circle) distance. It's free and instant, and it's a good guide to which places are clustered together. Actual walking or driving distance can be longer. Use the *Open in Google Maps* link for real directions in the travel mode you picked.

## Project layout
```
index.html        page markup
src/app.js        Google Maps / Places UI
src/geo.js        distance + route/combination algorithms (no Google dependency)
src/styles.css    styles (light + dark)
test/geo.test.js  unit tests for the algorithms
```

## Tests
```bash
npm test
```
