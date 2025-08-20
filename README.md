# BooPug Upsell Rules (Local Simulator)

BooPug Studios — a lightweight upsell rules engine you can run locally to test product-page and cart upsells before building the Shopify app. Zero-config seed rules, fast UI, and simple analytics.

## What’s included
- FastAPI backend: rules CRUD, evaluation, analytics, static hosting.
- BooPug-branded admin UI (`/admin`).
- Mock storefront simulator (`/simulator`) with product page + cart.
- Sample catalog (camera, sd card, tripod, cleaning kit, gift wrap).

## Quick start (Windows)
1. Open PowerShell.
2. Run:
   ```powershell
   cd C:\Users\cbosc\CascadeProjects\BooPugUpsellRules
   .\run.ps1
   ```
   Or use Command Prompt:
   ```bat
   C:\Users\cbosc\CascadeProjects\BooPugUpsellRules\run.cmd
   ```
3. Open http://127.0.0.1:8000/admin and http://127.0.0.1:8000/simulator

## Using the simulator
- In `Admin`:
  - Click "Seed Sample Rules" to create 2 rules:
    - Product page: If product has tag `camera` → suggest `SD Card` (-10%).
    - Cart: If subtotal between $30 and $60 → suggest `Cleaning Kit`.
  - Create your own rules with tags/collections/subtotal conditions.
- In `Simulator`:
  - Product panel shows the first catalog product and a live upsell placement.
  - Add to cart, adjust quantities, and see the cart upsell fire based on subtotal.
  - Clicking upsell "Add" logs an `accept` event.

## API
- `GET /api/health` → `{ ok: true }`
- `GET /api/catalog` → mock products
- `GET /api/rules` → list
- `POST /api/rules` → create (name, placement, conditions, suggestions, limit)
- `PUT /api/rules/{id}` → update
- `DELETE /api/rules/{id}` → delete
- `POST /api/evaluate` → `{ context: { placement, product?, cart }, session_id, debug? }` → suggestions (and optional debug traces)
- `POST /api/analytics/event` → { event_type, placement, rule_id, meta }
- `GET /api/analytics/summary` → tally

## Next steps toward Shopify app
- Convert this to a Shopify Embedded App with OAuth and Billing API.
- Build a Theme App Extension with blocks for product page and cart.
- Port the rule engine endpoint to a per-shop context and cache rules.
- Add Autopilot (auto-generate 5 starter rules from catalog tags/collections).

## License & Branding
© BooPug Studios. Internal use for prototyping. Replace branding as needed when publishing.

## Debugging rule matches

You can turn on a lightweight debug mode for the evaluation endpoint to see decision traces for each rule (placement check, schedule, per‑session cap, condition results including cart subtotal, and A/B assignment).

Example:

```bash
curl -s http://127.0.0.1:8000/api/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-session-1",
    "debug": true,
    "context": {
      "placement": "cart",
      "cart": { "subtotal": 44.97 }
    }
  }' | jq
```

Response includes `debug.rules[]` with per‑rule traces:

```json
{
  "suggestions": [...],
  "triggered_rules": [123],
  "control_rules": [],
  "debug": {
    "rules": [
      {
        "rule_id": 123,
        "name": "Subtotal bump → Cleaning Kit",
        "placement_ok": true,
        "schedule_ok": true,
        "cap": 0,
        "cap_ok": true,
        "conditions": {
          "cart_subtotal_between": true,
          "subtotal": 44.97,
          "min": 30,
          "max": 60
        },
        "ab_test_pct": 100,
        "ab_bucket": 17,
        "matched": true,
        "control_assigned": false,
        "chosen": true
      }
    ]
  }
}
```

Notes:
- When `ab_test_pct` < 100, users whose `ab_bucket >= ab_test_pct` go to control and do not see suggestions.
- The simulator now logs `click` events when users tap the upsell CTA and logs `accept` with accurate placement from suggestions.
