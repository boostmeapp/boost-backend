# Stripe Connect Testing Scripts

This directory contains scripts to help test Stripe Connect functionality in development.

## Test Transfer Script

Transfer funds to a connected account to test payout functionality.

### Prerequisites

1. Make sure you have Stripe Connect enabled in your Stripe Dashboard
2. Have a valid connected account ID (starts with `acct_`)
3. Ensure your `.env.development` file has a valid `STRIPE_SECRET_KEY`

### Usage

Transfer funds to the connected account:

```bash
npm run script:transfer -- --account acct_1Sk3fjFD9CeiiaOG --amount 100
```

### Options

- `--account <id>` (required): The connected account ID
- `--amount <number>` (optional): Amount in EUR to transfer (default: 50)
- `--description <text>` (optional): Custom description for the transfer

### Examples

**Transfer 100 EUR:**
```bash
npm run script:transfer -- --account acct_1Sk3fjFD9CeiiaOG --amount 100
```

**Transfer with custom description:**
```bash
npm run script:transfer -- --account acct_1Sk3fjFD9CeiiaOG --amount 50 --description "Testing payout feature"
```

**Transfer default amount (50 EUR):**
```bash
npm run script:transfer -- --account acct_1Sk3fjFD9CeiiaOG
```

### What the Script Does

1. Verifies the connected account exists and displays its status
2. Creates a transfer from your platform to the connected account
3. Shows the transfer details
4. Displays the updated balance of the connected account

### Testing Payouts After Transfer

Once you've transferred funds to the connected account, you can test the payout functionality:

1. **Via API (Recommended):**
   ```bash
   # Use your payout endpoint
   POST /api/payouts
   {
     "connectedAccountId": "acct_1Sk3fjFD9CeiiaOG",
     "amount": 25  // Amount in EUR
   }
   ```

2. **Via the Test Script (if you add a payout script):**
   ```bash
   npm run script:payout -- --account acct_1Sk3fjFD9CeiiaOG --amount 25
   ```

3. **Via Stripe Dashboard:**
   - Go to Connect > Accounts
   - Select the test account
   - View balance and create payouts manually

### Understanding Transfers vs Payouts

- **Transfer**: Moves money from your platform balance to a connected account's balance
- **Payout**: Moves money from a connected account's balance to their bank account

Flow:
```
Your Platform Balance → Transfer → Connected Account Balance → Payout → Bank Account
```

### Important Notes

**Test Mode:**
- This script uses your test mode API key
- No real money is involved
- Test payouts won't actually send to bank accounts

**Account Status:**
- The connected account should have `charges_enabled: true` to receive transfers
- If onboarding is incomplete, you may see warnings

**Troubleshooting:**

1. **"You can only create new accounts if you've signed up for Connect"**
   - Enable Stripe Connect in your Dashboard settings

2. **"No such destination"**
   - Verify the account ID is correct
   - Ensure the account exists in your Stripe test mode

3. **"Insufficient funds"**
   - Your platform needs to have funds first
   - In test mode, you can create test charges to add platform balance

### Adding Platform Balance (Test Mode)

If you need to add balance to your platform for testing transfers:

```javascript
// Create a test charge to add funds to your platform
const charge = await stripe.charges.create({
  amount: 10000, // 100 EUR in cents
  currency: 'eur',
  source: 'tok_visa', // Test card token
  description: 'Test charge to add platform balance',
});
```

Or use the Stripe CLI:
```bash
stripe charges create --amount=10000 --currency=eur --source=tok_visa
```

## Future Scripts

Consider adding these scripts for more comprehensive testing:

- `test-payout.ts`: Create payouts from connected accounts
- `check-balance.ts`: Check balances of connected accounts
- `simulate-payment.ts`: Simulate a full payment flow
