#!/usr/bin/env ts-node
/**
 * Complete setup script for testing payouts
 * This script will:
 * 1. Add funds to your platform balance via test charge
 * 2. Transfer funds to the connected account
 * 3. Show the connected account balance
 *
 * Usage:
 *   npm run script:setup-payout-test -- --account acct_xxx --amount 100
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

interface SetupOptions {
  accountId: string;
  amount: number;
}

async function setupPayoutTest(options: SetupOptions) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found in environment variables');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 STRIPE PAYOUT TEST SETUP');
    console.log('='.repeat(60));

    // Step 1: Check current platform balance
    console.log('\n📊 STEP 1: Checking platform balance...');
    const initialBalance = await stripe.balance.retrieve();
    const initialAvailableEUR = initialBalance.available.find((b) => b.currency === 'eur');
    const currentBalance = initialAvailableEUR ? initialAvailableEUR.amount / 100 : 0;

    console.log(`   Current available balance: €${currentBalance.toFixed(2)}`);

    // Step 2: Add funds if needed
    const neededAmount = options.amount;
    if (currentBalance < neededAmount) {
      const amountToAdd = Math.ceil(neededAmount - currentBalance + 10); // Add a bit extra
      console.log(`\n💳 STEP 2: Adding €${amountToAdd.toFixed(2)} to platform balance...`);
      console.log('   Using tok_bypassPending for immediately available funds...');

      const charge = await stripe.charges.create({
        amount: Math.round(amountToAdd * 100),
        currency: 'eur',
        source: 'tok_bypassPending', // Special token that bypasses pending balance
        description: `Test charge for payout testing - ${new Date().toISOString()}`,
        metadata: {
          test: 'true',
          purpose: 'payout_test_setup'
        }
      });

      console.log(`   ✅ Test charge created: ${charge.id}`);
      console.log(`   ✅ Added €${(charge.amount / 100).toFixed(2)} to platform`);
    } else {
      console.log('\n✅ STEP 2: Platform has sufficient balance, skipping charge creation');
    }

    // Step 3: Verify the connected account
    console.log('\n🔍 STEP 3: Verifying connected account...');
    const account = await stripe.accounts.retrieve(options.accountId);
    console.log(`   ✅ Account: ${account.id}`);
    console.log(`   Email: ${account.email || 'N/A'}`);
    console.log(`   Type: ${account.type}`);
    console.log(`   Charges enabled: ${account.charges_enabled}`);
    console.log(`   Payouts enabled: ${account.payouts_enabled}`);

    if (!account.charges_enabled) {
      console.warn('\n   ⚠️  Warning: Charges not enabled. Account may need onboarding.');
    }

    // Step 4: Create the transfer
    console.log(`\n💸 STEP 4: Transferring €${options.amount.toFixed(2)} to connected account...`);
    const transfer = await stripe.transfers.create({
      amount: Math.round(options.amount * 100),
      currency: 'eur',
      destination: options.accountId,
      description: `Test transfer for payout testing - ${new Date().toISOString()}`,
      metadata: {
        test: 'true',
        purpose: 'payout_testing'
      }
    });

    console.log(`   ✅ Transfer created: ${transfer.id}`);
    console.log(`   ✅ Amount transferred: €${(transfer.amount / 100).toFixed(2)}`);

    // Step 5: Check connected account balance
    console.log('\n💰 STEP 5: Checking connected account balance...');
    const connectedBalance = await stripe.balance.retrieve({
      stripeAccount: options.accountId,
    });

    const availableEUR = connectedBalance.available.find((b) => b.currency === 'eur');
    const pendingEUR = connectedBalance.pending.find((b) => b.currency === 'eur');

    console.log(`   Available: €${availableEUR ? (availableEUR.amount / 100).toFixed(2) : '0.00'}`);
    console.log(`   Pending: €${pendingEUR ? (pendingEUR.amount / 100).toFixed(2) : '0.00'}`);

    // Final summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ SETUP COMPLETE - READY FOR PAYOUT TESTING!');
    console.log('='.repeat(60));
    console.log('\n📝 What you can do now:\n');
    console.log('1. Test payout via API:');
    console.log('   POST /api/payouts');
    console.log('   {');
    console.log(`     "connectedAccountId": "${options.accountId}",`);
    console.log(`     "amount": 25  // Amount in EUR`);
    console.log('   }\n');
    console.log('2. Test payout via Stripe Dashboard:');
    console.log('   - Go to Connect > Accounts');
    console.log(`   - Select account ${options.accountId}`);
    console.log('   - Navigate to Balance and create a payout\n');
    console.log('3. Check the balance again:');
    console.log(`   npm run script:check-balance -- --account ${options.accountId}\n`);

  } catch (error) {
    console.error('\n❌ Error during setup:', error.message);

    if (error.type === 'StripeInvalidRequestError') {
      console.error('\n💡 Possible issues:');
      console.error('   - Verify the account ID is correct');
      console.error('   - Ensure Stripe Connect is enabled');
      console.error('   - Check that you are in test mode');
    }

    process.exit(1);
  }
}

// Parse command line arguments
function parseArgs(): SetupOptions {
  const args = process.argv.slice(2);
  let accountId: string | undefined;
  let amount: number = 100; // default amount

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--account' && args[i + 1]) {
      accountId = args[i + 1];
      i++;
    } else if (arg === '--amount' && args[i + 1]) {
      amount = parseFloat(args[i + 1]);
      i++;
    }
  }

  if (!accountId) {
    console.error('❌ Error: --account is required');
    console.log('\nUsage:');
    console.log('  npm run script:setup-payout-test -- --account acct_xxx --amount 100');
    console.log('\nOptions:');
    console.log('  --account <id>      Connected account ID (required)');
    console.log('  --amount <number>   Amount in EUR to transfer (default: 100)');
    process.exit(1);
  }

  if (amount <= 0) {
    console.error('❌ Error: Amount must be greater than 0');
    process.exit(1);
  }

  return { accountId, amount };
}

// Main execution
const options = parseArgs();
setupPayoutTest(options)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
