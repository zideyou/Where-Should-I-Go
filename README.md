# Where Should I Go

A small web app that searches several places on Google Maps and finds the ones that are **closest to each other**, so you don't have to go far to get to the next place.

## Two ways to use it

### 1. Find nearby combos
Search for different kinds of places, such as `ramen`, `bookstore`, and `park`. Each search can return up to 20 results. The app checks the combinations and ranks the **5 tightest groups**, with one place from each search. For each group you get:
- the visiting order and the distance of each leg
- the total trip distance
- an **Open in Google Maps** link with real turn-by-turn directions

### 2. Plan my stops
Add the exact places you already want to visit. The app works out the **visiting order with the least travel**. Up to 8 stops the order is guaranteed shortest. Above that it's a close estimate (nearest neighbour + 2-opt).

Both modes accept an optional **starting point**, such as your hotel. If you set one, the trip begins there.

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
