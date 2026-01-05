#!/usr/bin/env ts-node
/**
 * Script to add balance to your platform account using test charges
 * This is necessary before you can transfer funds to connected accounts
 *
 * Usage:
 *   npm run script:add-balance -- --amount 500
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

interface BalanceOptions {
  amount: number;
}

async function addPlatformBalance(options: BalanceOptions) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found in environment variables');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    console.log('\n💳 Creating test charge to add platform balance...');
    console.log(`   Amount: €${options.amount.toFixed(2)}`);

    // Create a test charge using a test card token
    // In test mode, this adds funds to your platform balance
    // Using tok_bypassPending to get immediately available funds
    const charge = await stripe.charges.create({
      amount: Math.round(options.amount * 100), // Convert EUR to cents
      currency: 'eur',
      source: 'tok_bypassPending', // Special token that bypasses pending balance
      description: `Test charge to add platform balance - ${new Date().toISOString()}`,
      metadata: {
        test: 'true',
        purpose: 'platform_balance',
        created_by: 'add-platform-balance-script'
      }
    });

    console.log('✅ Test charge created successfully!');
    console.log(`\n📋 Charge Details:`);
    console.log(`   Charge ID: ${charge.id}`);
    console.log(`   Amount: €${(charge.amount / 100).toFixed(2)}`);
    console.log(`   Status: ${charge.status}`);
    console.log(`   Paid: ${charge.paid ? 'Yes' : 'No'}`);

    // Check your platform balance
    console.log('\n💰 Checking platform balance...');
    const balance = await stripe.balance.retrieve();

    const availableEUR = balance.available.find((b) => b.currency === 'eur');
    const pendingEUR = balance.pending.find((b) => b.currency === 'eur');

    console.log('   Available: €' + (availableEUR ? (availableEUR.amount / 100).toFixed(2) : '0.00'));
    console.log('   Pending: €' + (pendingEUR ? (pendingEUR.amount / 100).toFixed(2) : '0.00'));

    console.log('\n✨ Platform balance updated! You can now transfer funds to connected accounts.');
    console.log('\n📝 Next step:');
    console.log('   npm run script:transfer -- --account acct_xxx --amount 100');

  } catch (error) {
    console.error('\n❌ Error creating test charge:', error.message);

    if (error.type === 'StripeInvalidRequestError') {
      console.error('\n💡 Possible issues:');
      console.error('   - Make sure you are in test mode');
      console.error('   - Verify your STRIPE_SECRET_KEY is correct');
    }

    process.exit(1);
  }
}

// Parse command line arguments
function parseArgs(): BalanceOptions {
  const args = process.argv.slice(2);
  let amount: number = 500; // default amount

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--amount' && args[i + 1]) {
      amount = parseFloat(args[i + 1]);
      i++;
    }
  }

  if (amount <= 0) {
    console.error('❌ Error: Amount must be greater than 0');
    process.exit(1);
  }

  return { amount };
}

// Main execution
const options = parseArgs();
console.log('\n🚀 Adding platform balance...');

addPlatformBalance(options)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
