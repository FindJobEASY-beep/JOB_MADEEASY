# The Hiring File

A one-page site that sells a downloadable list of companies hiring in India for ₹20. Visitors see a short preview. The full clickable list downloads only after Razorpay confirms the payment.

## Run it

```powershell
cd c:\Users\nithi\Desktop\job
copy .env.example .env
npm install
npm start
```

Open http://localhost:3000

## Take real payments

1. Create a Razorpay account at https://dashboard.razorpay.com
2. Open Account & Settings → API Keys.
3. Put the Key ID and Key Secret in `.env`.
4. Restart `npm start`.

Test keys start with `rzp_test_` and do not charge real money. Use UPI ID `success@razorpay` in test mode. Live keys start with `rzp_live_` and require completed Razorpay KYC. Live payments need the site on HTTPS, not only on your laptop.

Optional webhook: point `https://your-domain/api/webhook` at the event `payment.captured`, then set `RAZORPAY_WEBHOOK_SECRET` in `.env`.

Confirmed payments are saved in `data/payments.json`. That file contains names and emails. Do not publish it.

## Change the company list

Edit `data/companies.json`. Each company needs:

```json
{"name":"Example","industry":"Product & Internet","location":"Bengaluru","url":"https://example.com/careers"}
```

Change `updated` when you refresh the list. Restart the server after saving.

Check links with:

```powershell
npm run check-links
```

Broken links are printed in the terminal and written to `data/link-report.json`.

## What the buyer gets

- An HTML file that opens in any browser, with search and a careers link for every company.
- A CSV that opens in Excel, with the same links.

The download works for 24 hours on that browser, up to 8 downloads. After that, the buyer uses Already paid with their Razorpay Payment ID and the same email.
