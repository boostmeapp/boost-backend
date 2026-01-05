#!/usr/bin/env ts-node
/**
 * Create a test connected account for payout testing
 *
 * Usage:
 *   npm run script:create-account -- --email test@example.com
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env.development') });

interface AccountOptions {
  email: string;
}

async function createTestConnectAccount(options: AccountOptions) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    console.error('❌ STRIPE_SECRET_KEY not found in environment variables');
    process.exit(1);
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-11-17.clover'
  });

  try {
    console.log('\n🔧 Creating test Stripe Connect account...');
    console.log(`   Email: ${options.email}`);

    // Create Express Connect account
    const account = await stripe.accounts.create({
      type: 'express',
      email: options.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      settings: {
        payouts: {
          schedule: {
            interval: 'manual', // Manual payouts for testing
          },
        },
      },
    });

    console.log('\n✅ Connected account created successfully!');
    console.log(`\n📋 Account Details:`);
    console.log(`   Account ID: ${account.id}`);
    console.log(`   Email: ${account.email}`);
    console.log(`   Type: ${account.type}`);
    console.log(`   Charges enabled: ${account.charges_enabled}`);
    console.log(`   Payouts enabled: ${account.payouts_enabled}`);
    console.log(`   Details submitted: ${account.details_submitted}`);

    console.log(`\n✨ Account created! Copy this ID:`);
    console.log(`\n   ${account.id}\n`);

    console.log(`📝 Next steps:`);
    console.log(`\n1. Transfer funds to this account:`);
    console.log(`   npm run script:simple-transfer -- --account ${account.id} --amount 100`);
    console.log(`\n2. Test payout via your API endpoint`);

  } catch (error) {
    console.error('\n❌ Error creating connected account:', error.message);

    if (error.type === 'StripePermissionError' || error.message.includes('Connect')) {
      console.error('\n💡 Your Stripe account needs Connect enabled:');
      console.error('   1. Go to https://dashboard.stripe.com/settings/applications');
      console.error('   2. Enable Stripe Connect');
      console.error('   3. Complete the Connect onboarding');
    }

    process.exit(1);
  }
}

// Parse command line arguments
function parseArgs(): AccountOptions {
  const args = process.argv.slice(2);
  let email: string = `test-${Date.now()}@example.com`; // default email

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--email' && args[i + 1]) {
      email = args[i + 1];
      i++;
    }
  }

  return { email };
}

// Main execution
const options = parseArgs();
console.log('\n🚀 Creating test connect account...');

createTestConnectAccount(options)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
