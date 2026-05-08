# FCUTZ Backend

Backend Node.js pour l'app FCUTZ Barbershop.

## Variables d'environnement (Railway)

| Variable | Description |
|---|---|
| `DATABASE_URL` | Auto-rempli par Railway PostgreSQL |
| `SUMUP_API_KEY` | Ta clé `sup_sk_...` SumUp |
| `FCUTZ_SECRET` | Mot de passe secret de ton API |

## Endpoints

- `GET /` — Health check
- `GET /api/clients` — Liste clients
- `POST /api/clients/bulk` — Import clients en masse
- `GET /api/appointments` — Liste RDV
- `POST /api/appointments` — Créer RDV
- `GET /api/payments` — Liste paiements
- `POST /api/sync/transactions` — Sync SumUp transactions
- `POST /webhook/sumup` — Webhook temps réel SumUp
