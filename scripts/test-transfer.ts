#!/usr/bin/env ts-node
/**
 * Test script to transfer funds to a Stripe Connect account for payout testing
 *
 * Usage:
 *   npm run script:transfer -- --account acct_xxx --amount 100
 *
 * Options:
 *   --account: Connected account ID (required)
 *   --amount: Amount in EUR to transfer (default: 50)
 *   --description: Transfer description (optional)
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

interface TransferOptions {
  accountId: string;
  amount: number;
  description?: string;
}

async function createTestTransfer(options: TransferOptions) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found in environment variables');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    console.log('\n🔍 Verifying connected account...');

    // First, verify the account exists and get its details
    const account = await stripe.accounts.retrieve(options.accountId);
    console.log(`✅ Account found: ${account.id}`);
    console.log(`   Email: ${account.email || 'N/A'}`);
    console.log(`   Type: ${account.type}`);
    console.log(`   Charges enabled: ${account.charges_enabled}`);
    console.log(`   Payouts enabled: ${account.payouts_enabled}`);
    console.log(`   Details submitted: ${account.details_submitted}`);

    if (!account.charges_enabled) {
      console.warn('\n⚠️  Warning: Charges are not enabled for this account yet.');
      console.warn('   The account may need to complete onboarding first.');
    }

    console.log(`\n💸 Creating transfer of €${options.amount.toFixed(2)}...`);

    // Create the transfer
    const transfer = await stripe.transfers.create({
      amount: Math.round(options.amount * 100), // Convert EUR to cents
      currency: 'eur',
      destination: options.accountId,
      description: options.description || `Test transfer for payout testing - ${new Date().toISOString()}`,
      metadata: {
        test: 'true',
        purpose: 'payout_testing',
        created_by: 'test-transfer-script'
      }
    });

    console.log('✅ Transfer created successfully!');
    console.log(`\n📋 Transfer Details:`);
    console.log(`   Transfer ID: ${transfer.id}`);
    console.log(`   Amount: €${(transfer.amount / 100).toFixed(2)}`);
    console.log(`   Destination: ${transfer.destination}`);
    console.log(`   Status: ${transfer.created ? 'Created' : 'Pending'}`);
    console.log(`   Description: ${transfer.description}`);

    // Check the balance of the connected account
    console.log('\n💰 Checking connected account balance...');
    const balance = await stripe.balance.retrieve({
      stripeAccount: options.accountId,
    });

    const availableEUR = balance.available.find((b) => b.currency === 'eur');
    const pendingEUR = balance.pending.find((b) => b.currency === 'eur');

    console.log('   Available: €' + (availableEUR ? (availableEUR.amount / 100).toFixed(2) : '0.00'));
    console.log('   Pending: €' + (pendingEUR ? (pendingEUR.amount / 100).toFixed(2) : '0.00'));

    console.log('\n✨ You can now test payout functionality with this account!');
    console.log('\n📝 Next steps:');
    console.log('   1. Use the payout API endpoint to create a payout');
    console.log('   2. Check the payout status in Stripe Dashboard');
    console.log('   3. Verify the payout appears in test mode');

  } catch (error) {
    console.error('\n❌ Error during transfer:', error.message);

    if (error.type === 'StripeInvalidRequestError') {
      console.error('\n💡 Possible issues:');
      console.error('   - The account ID might be incorrect');
      console.error('   - The account might not be ready to receive transfers');
      console.error('   - Your platform might not have Connect enabled');
      console.error('   - The account might need to complete onboarding first');
    }

    process.exit(1);
  }
}

// Parse command line arguments
function parseArgs(): TransferOptions {
  const args = process.argv.slice(2);
  let accountId: string | undefined;
  let amount: number = 50; // default amount
  let description: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--account' && args[i + 1]) {
      accountId = args[i + 1];
      i++;
    } else if (arg === '--amount' && args[i + 1]) {
      amount = parseFloat(args[i + 1]);
      i++;
    } else if (arg === '--description' && args[i + 1]) {
      description = args[i + 1];
      i++;
    }
  }

  if (!accountId) {
    console.error('❌ Error: --account is required');
    console.log('\nUsage:');
    console.log('  npm run script:transfer -- --account acct_xxx --amount 100');
    console.log('\nOptions:');
    console.log('  --account <id>      Connected account ID (required)');
    console.log('  --amount <number>   Amount in EUR (default: 50)');
    console.log('  --description <text> Transfer description (optional)');
    process.exit(1);
  }

  if (amount <= 0) {
    console.error('❌ Error: Amount must be greater than 0');
    process.exit(1);
  }

  return { accountId, amount, description };
}

// Main execution
const options = parseArgs();
console.log('\n🚀 Starting test transfer...');
console.log(`   Account: ${options.accountId}`);
console.log(`   Amount: €${options.amount.toFixed(2)}`);

createTestTransfer(options)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
