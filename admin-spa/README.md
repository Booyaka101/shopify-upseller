# BooPug Admin SPA (Polaris + App Bridge)

This React SPA is embedded in Shopify Admin and will replace `static/admin.html`.

## Dev
1. Install Node.js LTS.
2. From `admin-spa/`:
   - `npm install`
   - `npm run dev`
3. Open the dev server URL shown in the console (for embedded testing, launch from Shopify with host params).

## Build (served by FastAPI at /admin)
From `admin-spa/`:

```bash
npm run build
```

This outputs to `static/admin-spa/`. The backend serves `/admin` from this build if present, else falls back to `/admin-legacy`.

## Notes
- Polaris styles are imported in `src/main.jsx`.
- App Bridge initializes using `/shopify/config` (apiKey) and `host` from the URL.
- During migration, keep using `/admin-legacy` for the old UI.
