# Stripe Billing

## Auth
Base URL: https://api.stripe.com/v1
Header: Authorization: Bearer {{secrets.stripe_api_key}}

## Endpoints
GET /customers - List customers
GET /customers/{{customer_id}} - Get customer
GET /invoices - List invoices
GET /invoices/{{invoice_id}} - Get invoice
GET /payment_intents - List payment intents
GET /subscriptions - List subscriptions
POST /customers - Create customer
POST /invoices - Create invoice draft

## Permissions
- http: [api.stripe.com]
- shell: none
- file: none

## Source
Imported from custom setup. Reviewed: true
